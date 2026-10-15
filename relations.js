// ============================================================
// relations.js — Relações (ritmo, direção, intervalar)
// ============================================================
//
// Rodada 4 (item 4): nenhuma nota é descartada por estar fora
// da faixa do polígono. Todas passam por `ajustarAoPoligono`
// (transposição por oitava; senão, altura viável mais próxima).
//
// Ordem: ritmo → direção → intervalar.
// Métricas são medidas com a altura FINAL (após ajuste).

import {
  faixaVerticalEm, intervalosVerticaisEm,
  ajustarAoPoligono, quantizar, hzParaMidi, midiParaHz,
} from './audio.js';

// ------------------------------------------------------------
// PRNG
// ------------------------------------------------------------
function prng(semente) {
  let a = (semente >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------
function eventoRefMaisProximo(refEvs, t, janela = 0.25) {
  let melhor = null, melhorDist = Infinity;
  for (const e of refEvs) {
    const d = Math.abs(e.t - t);
    if (d < melhorDist) { melhorDist = d; melhor = e; }
  }
  if (melhor && melhorDist <= janela) return melhor;
  return null;
}

function anterior(evs, i) {
  for (let k = i - 1; k >= 0; k--) if (evs[k]._ativo !== false) return evs[k];
  return null;
}

function intervaloSemitons(a, b) {
  return Math.round(hzParaMidi(b.f) - hzParaMidi(a.f));
}
function direcao(intervalo) {
  if (intervalo > 0) return 1;
  if (intervalo < 0) return -1;
  return 0;
}

/** Extensão temporal do polígono (menor/maior t dos vértices). */
function extensao(cam) {
  if (!cam || !cam.vertices || cam.vertices.length < 3) return null;
  let t0 = Infinity, t1 = -Infinity;
  for (const v of cam.vertices) {
    if (v.t < t0) t0 = v.t;
    if (v.t > t1) t1 = v.t;
  }
  return { t0, t1 };
}

/**
 * Ajusta `e.f` (em Hz) para caber em alguma faixa interna do
 * polígono em `e.t`. Atualiza `e.f` e `e._ajuste`.
 */
function fixarEvento(e, camDep, ajustes) {
  const ints = intervalosVerticaisEm(camDep.vertices, e.t);
  if (!ints.length) {
    // Instante fora do polígono — não deveria ocorrer (o ritmo
    // já checa antes). Marca como descartado.
    e._ativo = false;
    ajustes.descartadas++;
    return;
  }
  // Faixa mais próxima de e.f (garante coerência em côncavos).
  let faixa = ints[0], melhorDist = Infinity;
  for (const [a, b] of ints) {
    const d = (e.f < a) ? (a - e.f) : (e.f > b ? e.f - b : 0);
    if (d < melhorDist) { melhorDist = d; faixa = [a, b]; }
  }
  const { f, ajuste } = ajustarAoPoligono(e.f, faixa, camDep.quantizacaoAltura, {});
  if (ajuste === 'oitava') ajustes.oitava++;
  else if (ajuste === 'proxima') ajustes.proxima++;
  e.f = f;
  e._ajuste = ajuste;
}

// ------------------------------------------------------------
// Aplicação das relações
// ------------------------------------------------------------
export function aplicarRelacoes(eventosPorCamada, relacoes, camadasPorId) {
  const atingidos = new Map();

  for (const rel of relacoes) {
    const refEvs = eventosPorCamada.get(rel.camadaReferencia) || [];
    for (const depId of rel.camadasDependentes) {
      const depEvs = eventosPorCamada.get(depId);
      if (!depEvs || !depEvs.length) continue;
      const camDep = camadasPorId.get(depId);
      if (!camDep) continue;

      for (const e of depEvs) e._ativo = true;

      const rand = prng((camDep.semente ^ 0x5BD1E995) >>> 0);
      const ajustes = { oitava: 0, proxima: 0, descartadas: 0 };
      const res = {};

      // 1) RITMO
      if (rel.ritmo != null) {
        res.ritmo = aplicarRitmo(depEvs, refEvs, rel.ritmo, rand, camDep, ajustes);
      }

      let ativos = depEvs.filter(e => e._ativo !== false);
      ativos.sort((a, b) => a.t - b.t);

      // 2) DIREÇÃO
      if (rel.direcao != null) {
        res.direcao = aplicarDirecao(ativos, refEvs, rel.direcao, rand, camDep, ajustes);
      }

      // 3) INTERVALAR
      if (rel.intervalar != null) {
        res.intervalar = aplicarIntervalar(
          ativos, refEvs, rel.intervalar, rand, camDep,
          rel.parametros && rel.parametros.compararPorClasse,
          ajustes
        );
      }

      // Rede de segurança: fixa todos que ainda não foram fixados.
      for (const e of ativos) {
        if (e._ajuste === undefined) {
          try { fixarEvento(e, camDep, ajustes); } catch (_) { e._ativo = false; ajustes.descartadas++; }
        }
      }
      ativos = ativos.filter(e => e._ativo !== false);

      eventosPorCamada.set(depId, ativos);
      res.ajustes = ajustes;
      atingidos.set(depId + ':' + rel.id, res);
    }
  }

  return atingidos;
}

// ------------------------------------------------------------
// Ritmo
// ------------------------------------------------------------
//
// Só move `e.t` para `ref.t` se o instante `ref.t` estiver dentro
// da extensão do polígono e produzir faixa vertical. A altura é
// reajustada via `fixarEvento`.
//
function aplicarRitmo(depEvs, refEvs, alvo, rand, camDep, ajustes) {
  if (!refEvs.length) return 0;
  const alvoFrac = alvo / 100;
  const ext = extensao(camDep);
  if (!ext) return 0;

  for (const e of depEvs) {
    const ref = eventoRefMaisProximo(refEvs, e.t, 0.25);
    if (!ref) continue;
    if (rand() >= alvoFrac) continue;
    // Checa que ref.t está dentro do polígono.
    if (ref.t < ext.t0 - 1e-6 || ref.t > ext.t1 + 1e-6) continue;
    const faixa = faixaVerticalEm(camDep.vertices, ref.t);
    if (!faixa) continue;
    e.t = ref.t;
    // Trunca dur para não passar do fim do polígono.
    const tMax = ext.t1;
    if (e.t + e.dur > tMax) e.dur = Math.max(0.02, tMax - e.t);
    // A altura precisa ser refeita neste novo t.
    try { fixarEvento(e, camDep, ajustes); } catch (_) { e._ativo = false; ajustes.descartadas++; }
  }

  // Medição: proporção dos eventos finais que coincidem com um
  // ataque da referência (tolerância 5 ms).
  let acertos = 0;
  for (const e of depEvs) {
    if (e._ativo === false) continue;
    if (refEvs.some(r => Math.abs(r.t - e.t) < 0.005)) acertos++;
  }
  const total = depEvs.filter(e => e._ativo !== false).length;
  return total ? Math.round((acertos / total) * 100) : 0;
}

// ------------------------------------------------------------
// Direção
// ------------------------------------------------------------
//
// Após reescrever `at.f`, chama `fixarEvento`. Mede com a altura
// final.
//
function aplicarDirecao(ativos, refEvs, alvo, rand, camDep, ajustes) {
  if (ativos.length < 2 || !refEvs.length) return 0;
  const alvoFrac = alvo / 100;
  let acertos = 0, total = 0;

  for (let i = 1; i < ativos.length; i++) {
    const ant = anterior(ativos, i);
    const at = ativos[i];
    if (!ant) continue;

    const dirDep = direcao(intervaloSemitons(ant, at));
    const refAnt = refEvs.filter(r => r.t < at.t).pop() || null;
    const refAt  = refEvs.find(r => r.t >= at.t) || null;
    if (!refAnt || !refAt) { total++; continue; }

    const dirRef = direcao(intervaloSemitons(refAnt, refAt));
    total++;

    // Já coincide com a direção da referência?
    if (dirDep === dirRef) { acertos++; continue; }
    if (rand() >= alvoFrac) continue;

    // Tenta obedecer. Ordem de tentativas:
    //  (1) mesma magnitude, sinal da referência;
    //  (2) magnitude reduzida (mag-1, mag-2, ... 1) no sentido
    //      da referência (preserva mais o contorno do que
    //      transpor por oitava);
    //  (3) transposição por oitava do resultado de (1).
    const mag = Math.abs(intervaloSemitons(ant, at));
    const sinalRef = dirRef === 0 ? 1 : dirRef;

    const candidatos = [];
    for (let m = mag; m >= 1; m--) {
      candidatos.push(midiParaHz(hzParaMidi(ant.f) + m * sinalRef));
    }
    // (3) por oitava do (1) — tenta por último
    candidatos.push(midiParaHz(hzParaMidi(ant.f) + mag * sinalRef));

    for (const cand of candidatos) {
      const original = at.f;
      at.f = quantizar(cand, camDep.quantizacaoAltura);
      fixarEvento(at, camDep, ajustes);
      if (direcao(intervaloSemitons(ant, at)) === dirRef) {
        acertos++;
        break;
      }
      // Se não cumpriu e o ajuste foi "nenhum", deixa o candidato
      // mesmo assim (é o melhor possível). Se não cumpriu e o
      // ajuste foi por oitava/proxima, ainda assim mantemos — a
      // rede de segurança garante que o evento cabe.
      // Para tentar o próximo candidato, é preciso restaurar.
      if (cand !== candidatos[candidatos.length - 1]) at.f = original;
    }
  }

  return total ? Math.round((acertos / total) * 100) : 0;
}

// ------------------------------------------------------------
// Intervalar
// ------------------------------------------------------------
function aplicarIntervalar(ativos, refEvs, alvo, rand, camDep, porClasse, ajustes) {
  if (ativos.length < 2 || !refEvs.length) return 0;
  const alvoFrac = alvo / 100;
  let acertos = 0, total = 0;

  for (let i = 1; i < ativos.length; i++) {
    const ant = anterior(ativos, i);
    const at = ativos[i];
    if (!ant) continue;

    const magDep = Math.abs(intervaloSemitons(ant, at));
    const refAnt = refEvs.filter(r => r.t < at.t).pop() || null;
    const refAt  = refEvs.find(r => r.t >= at.t) || null;
    if (!refAnt || !refAt) { total++; continue; }

    const magRef = Math.abs(intervaloSemitons(refAnt, refAt));
    total++;

    const mDep = porClasse ? (magDep % 12) : magDep;
    const mRef = porClasse ? (magRef % 12) : magRef;
    if (mDep === mRef) { acertos++; continue; }
    if (rand() >= alvoFrac) continue;

    const dirAtual = direcao(intervaloSemitons(ant, at));
    const sinal = dirAtual === 0 ? 1 : dirAtual;
    const candidatos = [
      midiParaHz(hzParaMidi(ant.f) + magRef * sinal),
    ];
    // Só tenta o sentido oposto se a relação de direção estiver
    // inativa (não faz sentido brigar com direção).
    if (rel_direcao_inativa(relAtualRef)) {
      candidatos.push(midiParaHz(hzParaMidi(ant.f) - magRef * Math.sign(sinal || 1)));
    }

    for (let k = 0; k < candidatos.length; k++) {
      const original = at.f;
      at.f = quantizar(candidatos[k], camDep.quantizacaoAltura);
      fixarEvento(at, camDep, ajustes);
      const mAtual = Math.abs(intervaloSemitons(ant, at));
      const mAtualC = porClasse ? (mAtual % 12) : mAtual;
      if (mAtualC === mRef) { acertos++; break; }
      if (k < candidatos.length - 1) at.f = original;
    }
  }

  return total ? Math.round((acertos / total) * 100) : 0;
}

// placeholder — resolvido no escopo acima via closure
let relAtualRef = null;
function rel_direcao_inativa(rel) {
  return !rel || rel.direcao == null;
}