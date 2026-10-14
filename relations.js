// ============================================================
// relations.js — Relações entre camadas (ritmo, direção, intervalar)
// ============================================================
//
// Uma relação conecta uma camada de REFERÊNCIA a N camadas
// DEPENDENTES. Cada tipo (ritmo/direção/intervalar) é um valor
// 0..100 ou null (inativo).
//
// Ordem de aplicação: ritmo → direção → intervalar.
//
// O polígono sempre prevalece: se o resultado de uma relação
// empurrar a altura para fora da região no instante t, o evento
// é descartado (não é gerado).
//
// Determinismo: cada decisão "obedecer ou não" usa um PRNG
// semeado com a semente da camada dependente + um contador.
// ============================================================

import { faixaVerticalEm } from './audio.js';

// ------------------------------------------------------------
// PRNG determinístico (mulberry32) — mesma semente, mesma saída
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

function hzParaMidi(f) { return 69 + 12 * Math.log2(f / 440); }
function midiParaHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

// ------------------------------------------------------------
// Utilidades de eventos
// ------------------------------------------------------------

/** Encontra o evento da referência mais próximo de t (dentro de uma janela). */
function eventoRefMaisProximo(refEvs, t, janela = 0.06) {
  let melhor = null;
  let melhorDist = Infinity;
  for (const e of refEvs) {
    const d = Math.abs(e.t - t);
    if (d < melhorDist) { melhorDist = d; melhor = e; }
  }
  if (melhor && melhorDist <= janela) return melhor;
  return null;
}

/** Retorna o evento imediatamente anterior na lista (já ordenada por t). */
function anterior(evs, i) {
  for (let k = i - 1; k >= 0; k--) if (evs[k]._ativo !== false) return evs[k];
  return null;
}

/** Intervalo em semitons entre dois eventos (arredondado). */
function intervaloSemitons(a, b) {
  return Math.round(hzParaMidi(b.f) - hzParaMidi(a.f));
}

/** Direção: -1 descendente, 0 oblíquo/estático, +1 ascendente. */
function direcao(intervalo) {
  if (intervalo > 0) return 1;
  if (intervalo < 0) return -1;
  return 0;
}

// ------------------------------------------------------------
// Aplicação das relações sobre as listas de eventos
// ------------------------------------------------------------
//
// eventosPorCamada: Map(id -> [eventos])
// relacoes:         lista de relações
// camadasPorId:     Map(id -> camada) — precisa dos vertices p/ recorte
//
// Retorna: Map(id -> { ritmoAtingido, direcaoAtingida, intervalarAtingida })
//          com os valores efetivamente atingidos por relação.
//
export function aplicarRelacoes(eventosPorCamada, relacoes, camadasPorId) {
  const atingidos = new Map();

  for (const rel of relacoes) {
    const refEvs = eventosPorCamada.get(rel.camadaReferencia) || [];
    for (const depId of rel.camadasDependentes) {
      const depEvs = eventosPorCamada.get(depId);
      if (!depEvs || !depEvs.length) continue;
      const camDep = camadasPorId.get(depId);
      if (!camDep) continue;

      // marcador de eventos "descartados" pelo polígono
      for (const e of depEvs) e._ativo = true;

      const rand = prng((camDep.semente ^ 0x5BD1E995) >>> 0);
      const res = {};

      // ---- 1) RITMO ----
      if (rel.ritmo != null) {
        res.ritmo = aplicarRitmo(depEvs, refEvs, rel.ritmo, rand);
      }

      // reordena e limpa inativos antes de alturas
      let ativos = depEvs.filter(e => e._ativo !== false);
      ativos.sort((a, b) => a.t - b.t);

      // ---- 2) DIREÇÃO ----
      if (rel.direcao != null) {
        res.direcao = aplicarDirecao(ativos, refEvs, rel.direcao, rand, camDep);
      }

      // ---- 3) INTERVALAR ----
      if (rel.intervalar != null) {
        res.intervalar = aplicarIntervalar(
          ativos, refEvs, rel.intervalar, rand, camDep,
          rel.parametros && rel.parametros.compararPorClasse
        );
      }

      // ---- 4) recorte final pelo polígono ----
      const filtrados = [];
      for (const e of ativos) {
        const faixa = faixaVerticalEm(camDep.vertices, e.t);
        if (!faixa) continue;
        const [fMin, fMax] = faixa;
        if (e.f < fMin * 0.999 || e.f > fMax * 1.001) {
          // fora da faixa: descarta (polígono prevalece)
          continue;
        }
        filtrados.push(e);
      }

      // Substitui a lista da camada dependente
      eventosPorCamada.set(depId, filtrados);

      atingidos.set(depId + ':' + rel.id, res);
    }
  }

  return atingidos;
}

// ------------------------------------------------------------
// Ritmo
// ------------------------------------------------------------
//
// Para cada evento da dependente, procura o ataque da referência
// mais próximo. Com probabilidade = ritmo/100, o evento "obedece":
// seu t é movido para o t da referência. Os demais permanecem.
//
// Valor atingido: proporção dos eventos cujo t final coincide com
// algum ataque da referência (tolerância de 5 ms).
//
function aplicarRitmo(depEvs, refEvs, alvo, rand) {
  if (!refEvs.length) return 0;
  const alvoFrac = alvo / 100;
  let obedeceram = 0;

  for (const e of depEvs) {
    const ref = eventoRefMaisProximo(refEvs, e.t, 0.25);
    if (!ref) continue;
    if (rand() < alvoFrac) {
      e.t = ref.t;
    }
  }

  // mede
  for (const e of depEvs) {
    if (refEvs.some(r => Math.abs(r.t - e.t) < 0.005)) obedeceram++;
  }
  return depEvs.length ? Math.round((obedeceram / depEvs.length) * 100) : 0;
}

// ------------------------------------------------------------
// Direção
// ------------------------------------------------------------
//
// Para cada par (anterior, atual) da dependente, mede-se o
// intervalo melódico. Compara-se com o movimento da referência
// no mesmo trecho temporal. Com probabilidade = direcao/100 o
// evento "obedece": o intervalo é ajustado para ter a mesma
// direção que o da referência (preservando magnitude, invertendo
// o sinal se preciso). Empates (0) contam como divergência.
//
function aplicarDirecao(ativos, refEvs, alvo, rand, camDep) {
  if (ativos.length < 2 || !refEvs.length) return 0;
  const alvoFrac = alvo / 100;
  let acertos = 0, total = 0;

  for (let i = 1; i < ativos.length; i++) {
    const ant = anterior(ativos, i);
    const at = ativos[i];
    if (!ant) continue;

    const dirDep = direcao(intervaloSemitons(ant, at));
    // referência no mesmo trecho: pega o par de eventos da referência
    // que envolve o t do atual
    const refAnt = refEvs.filter(r => r.t < at.t).pop() || null;
    const refAt  = refEvs.find(r => r.t >= at.t) || null;
    if (!refAnt || !refAt) { total++; continue; }

    const dirRef = direcao(intervaloSemitons(refAnt, refAt));
    total++;

    if (dirDep === dirRef) { acertos++; continue; }

    // diverge. Com probabilidade alvo, obedece:
    if (rand() < alvoFrac) {
      // reescreve a altura do evento atual para ter a direção da referência,
      // preservando a magnitude do intervalo da dependente
      const mag = Math.abs(intervaloSemitons(ant, at));
      const sinalRef = dirRef === 0 ? 1 : dirRef;
      const novoMidi = hzParaMidi(ant.f) + mag * sinalRef;
      const novoF = midiParaHz(novoMidi);
      // o polígono prevalece (checado depois); aqui só aplica
      at.f = novoF;
      // se a direção mudou para a da referência, conta como acerto
      if (direcao(intervaloSemitons(ant, at)) === dirRef) acertos++;
    }
  }

  return total ? Math.round((acertos / total) * 100) : 0;
}

// ------------------------------------------------------------
// Intervalar
// ------------------------------------------------------------
//
// Compara magnitudes de intervalo (semitons, sem direção).
// Se `porClasse` for true, compara classe intervalar (mod 12).
// Com probabilidade = intervalar/100 o evento "obedece":
// sua magnitude é reescrita para a da referência, preservando
// a direção do evento da dependente.
//
function aplicarIntervalar(ativos, refEvs, alvo, rand, camDep, porClasse) {
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

    if (rand() < alvoFrac) {
      // obedece: reescreve magnitude, preservando a direção atual
      const dirAtual = direcao(intervaloSemitons(ant, at));
      const sinal = dirAtual === 0 ? 1 : dirAtual;
      const novoMidi = hzParaMidi(ant.f) + magRef * sinal;
      at.f = midiParaHz(novoMidi);
      if (Math.abs(intervaloSemitidos(ant, at)) === magRef) acertos++;
    }
  }

  return total ? Math.round((acertos / total) * 100) : 0;
}

// pequeno alias só para clareza acima
function intervaloSemitidos(a, b) { return intervaloSemitons(a, b); }