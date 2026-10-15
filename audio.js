// ============================================================
// audio.js — Motor de áudio + grafo reutilizável (online/offline)
// ============================================================
//
// Rodada 4 (itens 4, 5):
//  - Helpers puros: transporPorOitava, quantizarNaFaixa,
//    ajustarAoPoligono. Reutilizados pelas relações e pela série.
//  - Série de alturas (`serieAlturas`) consumida em gerarEventosCamada.
//  - Granular: grãos em torno do centro (série) ± dispersão.

import { estado, camadaSelecionada, valorAutomacao } from './model.js';
import { aplicarRelacoes } from './relations.js';
import { parseSerie, midiParaHz as serieMidiParaHz } from './serie.js';

// Cauda após parar (para reverb). 0 = corte seco com fade.
export const CAUDA_CAMADA_S = 0;

// Dispersão (em semitons) dos grãos em torno do centro da nuvem.
export const DISPERSAO_GRANULAR_ST = 1;

// ------------------------------------------------------------
// PRNG
// ------------------------------------------------------------
export function prng(semente) {
  let a = (semente >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------
// Utilidades musicais
// ------------------------------------------------------------
export function midiParaHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
export function hzParaMidi(f) { return 69 + 12 * Math.log2(f / 440); }

export function quantizar(f, quant) {
  if (!quant || quant.modo === 'livre') return f;
  let m = Math.round(hzParaMidi(f));
  if (quant.modo === 'semitons') return midiParaHz(m);
  if (quant.modo === 'conjunto') {
    const classes = quant.classes && quant.classes.length ? quant.classes : [0,2,4,5,7,9,11];
    const alvo = ((m % 12) + 12) % 12;
    if (classes.includes(alvo)) return midiParaHz(m);
    let desloc = 0;
    for (let d = 1; d <= 6; d++) {
      if (classes.includes((alvo + d) % 12)) { desloc = d; break; }
      if (classes.includes((alvo - d + 12) % 12)) { desloc = -d; break; }
    }
    return midiParaHz(m + desloc);
  }
  return f;
}

// ------------------------------------------------------------
// Helpers puros de polígono/altura (itens 4 e 5)
// ------------------------------------------------------------

/** Menor transposição por oitava que põe f em [fMin, fMax]; null se nenhuma couber. */
export function transporPorOitava(f, fMin, fMax) {
  if (!(f > 0) || !(fMin > 0) || !(fMax >= fMin)) return null;
  const kMin = Math.ceil(Math.log2(fMin / f) - 1e-9);
  const kMax = Math.floor(Math.log2(fMax / f) + 1e-9);
  if (kMin > kMax) return null;
  const k = (kMin > 0) ? kMin : (kMax < 0 ? kMax : 0);
  return f * Math.pow(2, k);
}

/**
 * Entre as alturas permitidas pela quantização que caibam em
 * [fMin, fMax], a mais próxima de f (em semitons). Devolve
 * `null` se nada couber.
 */
export function quantizarNaFaixa(f, quant, fMin, fMax) {
  if (!(fMin > 0) || !(fMax >= fMin)) return null;
  const mTop = Math.floor(hzParaMidi(fMax));
  const mBase = Math.ceil(hzParaMidi(fMin));
  if (mBase > mTop) return null;

  const classes = (quant && quant.modo === 'conjunto' && quant.classes && quant.classes.length)
    ? quant.classes : null;

  let melhor = null, melhorDist = Infinity;
  for (let m = mBase; m <= mTop; m++) {
    if (classes) {
      const c = ((m % 12) + 12) % 12;
      if (!classes.includes(c)) continue;
    }
    const hz = midiParaHz(m);
    const d = Math.abs(hzParaMidi(f) - m);
    if (d < melhorDist) { melhorDist = d; melhor = hz; }
  }
  return melhor;
}

/**
 * Garante que `f` caiba na faixa do polígono. Devolve
 * `{ f, ajuste }` com `ajuste` ∈ {'nenhum','oitava','proxima'}.
 *
 * Ordem de preferência: 1) já cabe; 2) transposição por oitava
 * (preserva classe de altura); 3) altura viável mais próxima
 * (quantiza dentro da faixa).
 *
 * `opcoes.quantizarAntes` (padrão true): aplica `quantizar` em
 * `f` antes; a série de alturas passa `false`.
 */
export function ajustarAoPoligono(f, faixa, quant, opcoes = {}) {
  const quantizarAntes = opcoes.quantizarAntes !== false;
  const [fMin, fMax] = faixa || [0, 0];
  if (!(fMin > 0) || !(fMax >= fMin)) return { f, ajuste: 'nenhum' };

  let alvo = f;
  if (quantizarAntes) alvo = quantizar(alvo, quant);

  if (alvo >= fMin * 0.999 && alvo <= fMax * 1.001) {
    return { f: alvo, ajuste: 'nenhum' };
  }

  const oit = transporPorOitava(alvo, fMin, fMax);
  if (oit != null) {
    if (quantizarAntes) {
      const q = quantizar(oit, quant);
      if (q >= fMin * 0.999 && q <= fMax * 1.001) {
        return { f: q, ajuste: 'oitava' };
      }
    }
    return { f: oit, ajuste: 'oitava' };
  }

  const prox = quantizarNaFaixa(alvo, quant, fMin, fMax);
  if (prox != null) return { f: prox, ajuste: 'proxima' };

  // fallback final: limita à borda mais próxima
  const borda = (alvo < fMin) ? fMin : fMax;
  return { f: borda, ajuste: 'proxima' };
}

// ------------------------------------------------------------
// Interseção polígono × vertical
// ------------------------------------------------------------
export function intervalosVerticaisEm(vertices, t) {
  if (!vertices || vertices.length < 3) return [];
  const fInts = [];
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[j], b = vertices[i];
    if ((a.t <= t && b.t > t) || (b.t <= t && a.t > t)) {
      const u = (t - a.t) / (b.t - a.t);
      fInts.push(a.f + u * (b.f - a.f));
    }
  }
  if (fInts.length < 2) return [];
  fInts.sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i + 1 < fInts.length; i += 2) {
    out.push([fInts[i], fInts[i + 1]]);
  }
  return out;
}

export function faixaVerticalEm(vertices, t) {
  const ints = intervalosVerticaisEm(vertices, t);
  if (!ints.length) return null;
  return [ints[0][0], ints[ints.length - 1][1]];
}

/**
 * Faixa mais próxima do alvo (dentro da lista de intervalos).
 * Útil para escolher uma faixa que comporte um ajuste por oitava
 * quando há reentrâncias.
 */
function faixaMaisProxima(ints, fAlvo) {
  if (!ints.length) return null;
  let melhor = ints[0], melhorDist = Infinity;
  for (const [a, b] of ints) {
    const d = (fAlvo < a) ? (a - fAlvo) : (fAlvo > b ? fAlvo - b : 0);
    if (d < melhorDist) { melhorDist = d; melhor = [a, b]; }
  }
  return melhor;
}

// ------------------------------------------------------------
// Envelope: sorteio por evento (determinístico)
// ------------------------------------------------------------
function sortearEnvelope(base, rigor, rEnv) {
  if (rigor >= 100) return { ...base };
  const u1 = rEnv() * 2 - 1;
  const u2 = rEnv() * 2 - 1;
  const u3 = rEnv() * 2 - 1;
  const u4 = rEnv() * 2 - 1;
  const fator = (1 - rigor / 100);
  const a = Math.max(0, base.a * (1 + fator * u1));
  const d = Math.max(0, base.d * (1 + fator * u2));
  const s = Math.max(0, base.s * (1 + fator * u3));
  const r = Math.max(0, base.r * (1 + fator * u4));
  const soma = a + d + s + r;
  if (soma <= 0) return { ...base };
  const k = 100 / soma;
  const us = rEnv() * 2 - 1;
  const nivelSustain = Math.min(1, Math.max(0,
    base.nivelSustain * (1 + fator * us)));
  return { a: a * k, d: d * k, s: s * k, r: r * k, nivelSustain, rigor };
}

// ------------------------------------------------------------
// Escolha de altura por série
// ------------------------------------------------------------
//
// Devolve a altura em Hz, ou `null` se a série não deve ser usada
// neste ataque (o chamador sorteia normalmente).
//
// - `modo='absoluta'`: `midi` é literal (em MIDI). Ajusta ao
//   polígono por oitava / mais próxima.
// - `modo='classe'`: só importa `midi mod 12`. A oitava é
//   escolhida dentro da faixa segundo `oitava`:
//     'proxima'   → mais próxima de `midiAnterior` (ou do centro
//                    da faixa no primeiro ataque).
//     'aleatoria' → sorteada por PRNG dedicado.
//
function alturaDaSerie(entradaMidi, cam, ints, rSerie, midiAnterior) {
  if (ints.length === 0) return null;
  const serie = cam.serieAlturas || { modo: 'absoluta', oitava: 'proxima' };
  const modo = serie.modo || 'absoluta';

  // Faixa mais adequada (o alvo ajuda a escolher a faixa interna
  // correta em polígonos côncavos).
  const alvoHz = midiParaHz(entradaMidi);
  const faixa = faixaMaisProxima(ints, alvoHz);
  if (!faixa) return null;
  const [fMin, fMax] = faixa;

  if (modo === 'absoluta') {
    const { f } = ajustarAoPoligono(
      midiParaHz(entradaMidi), faixa, cam.quantizacaoAltura,
      { quantizarAntes: false }
    );
    return f;
  }

  // modo classe
  const classe = ((Math.round(entradaMidi) % 12) + 12) % 12;
  const mTop = Math.floor(hzParaMidi(fMax));
  const mBase = Math.ceil(hzParaMidi(fMin));

  if (serie.oitava === 'aleatoria') {
    // Enumera as classes dentro da faixa e sorteia uma.
    const candidatos = [];
    for (let m = mBase; m <= mTop; m++) {
      if ((((m % 12) + 12) % 12) === classe) candidatos.push(m);
    }
    if (candidatos.length) {
      const idx = Math.floor(rSerie() * candidatos.length);
      return midiParaHz(candidatos[idx]);
    }
  } else {
    // 'proxima': encontra a mais próxima de `midiAnterior` (ou do
    // centro da faixa, no primeiro ataque).
    const centro = (mBase + mTop) / 2;
    const ref = (midiAnterior != null) ? midiAnterior : centro;
    let melhor = null, melhorDist = Infinity;
    for (let m = mBase; m <= mTop; m++) {
      if ((((m % 12) + 12) % 12) !== classe) continue;
      const d = Math.abs(m - ref);
      if (d < melhorDist) { melhorDist = d; melhor = m; }
    }
    if (melhor != null) return midiParaHz(melhor);
  }

  // Fallback: mais próxima dentro da faixa (ramo proxima do ajustar).
  const prox = quantizarNaFaixa(alvoHz, cam.quantizacaoAltura, fMin, fMax);
  return prox != null ? prox : alvoHz;
}

// ------------------------------------------------------------
// Geração de eventos por camada (item 5)
// ------------------------------------------------------------
export function gerarEventosCamada(cam, duracaoTotal) {
  const ev = [];
  if (!cam || cam.mudo) return ev;
  if (cam.vertices.length < 3) return ev;

  const rand = prng(cam.semente);
  const rEnv = prng((cam.semente ^ 0xA5A5A5A5) >>> 0);
  // PRNG separado para a oitava 'aleatoria' da série.
  const rSerie = prng((cam.semente ^ 0x51ED270B) >>> 0);

  const bpm = cam.andamento > 0 ? cam.andamento : 120;
  const pulsoSeg = cam.pulso > 0 ? cam.pulso : (60 / bpm);
  const dens = Math.max(0.1, cam.densidadeRitmica || 1);
  const padrao = (cam.padraoRitmico && cam.padraoRitmico.length) ? cam.padraoRitmico : [1];
  const envBase = cam.envelope || { a: 5, d: 10, s: 70, r: 15, nivelSustain: 0.7, rigor: 100 };

  // Série de alturas (se ativa).
  const serieAtiva = !!(cam.serieAlturas && cam.serieAlturas.ativa);
  let serieValores = [];
  if (serieAtiva) {
    const parsed = parseSerie(cam.serieAlturas.texto || '');
    serieValores = parsed.valores; // pode conter null (livre)
  }
  let idxAtaque = 0;
  let midiAnterior = null;

  const tMin = Math.min(...cam.vertices.map(v => v.t));
  const tMax = Math.max(...cam.vertices.map(v => v.t));
  const t0 = Math.max(0, tMin);
  const t1 = Math.min(duracaoTotal, tMax);
  if (t1 <= t0) return ev;

  const passo = pulsoSeg / dens;
  const nSlots = Math.max(1, Math.floor((t1 - t0) / passo));
  let idxPadrao = 0;

  for (let i = 0; i < nSlots; i++) {
    const ativo = padrao[idxPadrao % padrao.length] === 1;
    idxPadrao++;
    if (!ativo) continue;

    const t = t0 + i * passo;
    const ints = intervalosVerticaisEm(cam.vertices, t);
    if (!ints.length) continue;
    // Faixa de referência para decidir se a nota "cabe":
    // usamos a mais próxima do centro global.
    const centroFaixa = (ints[0][0] + ints[ints.length - 1][1]) / 2;
    const faixaRef = faixaMaisProxima(ints, centroFaixa);
    if (!faixaRef) continue;
    const [fMinRef, fMaxRef] = faixaRef;
    if (!(fMaxRef > 0) || !(fMinRef > 0) || fMaxRef <= fMinRef) continue;

    // Consome sempre um `rand()` para preservar a sequência
    // pseudoaleatória de durações/envelopes/grãos.
    const r1 = rand();

    // Altura pretendida:
    //  - série ativa e token válido → usa a série
    //  - caso contrário, sorteio normal
    let f = null;
    let usadoSerie = false;
    if (serieAtiva && serieValores.length) {
      const token = serieValores[idxAtaque % serieValores.length];
      if (token != null) {
        const candidata = alturaDaSerie(token, cam, ints, rSerie, midiAnterior);
        if (candidata != null) {
          // Guarda o MIDI efetivo para o modo 'classe proxima'
          midiAnterior = hzParaMidi(candidata);
          f = candidata;
          usadoSerie = true;
        }
      }
    }
    if (!usadoSerie) {
      // Sorteio normal dentro da faixa de referência.
      if (cam.tipoObjeto === 'gliss') {
        const k = (i % 8) / 7;
        f = fMinRef + (fMaxRef - fMinRef) * (r1 * 0.2 + k * 0.8);
      } else {
        f = fMinRef + (fMaxRef - fMinRef) * r1;
      }
      f = quantizar(f, cam.quantizacaoAltura);
      midiAnterior = hzParaMidi(f);
    }

    // Avança o contador de ataques (só quando houve ataque).
    idxAtaque++;

    // Duração: consome um rand() a mais, exatamente como antes.
    const rDur = rand();
    let dur;
    if (cam.tipoObjeto === 'granular') dur = passo * (0.05 + rDur * 0.15);
    else if (cam.tipoObjeto === 'gliss') dur = passo * (0.9 + rDur * 0.5);
    else if (cam.tipoObjeto === 'ruido') dur = passo * (0.5 + rDur * 0.5);
    else dur = passo * (0.6 + rDur * 0.4);
    if (t + dur > tMax) dur = Math.max(0.02, tMax - t);

    const envEv = sortearEnvelope(envBase, envBase.rigor, rEnv);

    ev.push({
      t, f, dur,
      tipoObjeto: cam.tipoObjeto,
      timbre: cam.timbre || { tipo: 'sine' },
      vol: cam.volume != null ? cam.volume : 0.8,
      env: envEv,
    });
  }

  // Granular: nuvem em torno do centro (série) ± dispersão.
  if (cam.tipoObjeto === 'granular') {
    const nuvem = [];
    for (const e of ev.slice()) {
      const nGraos = 6 + Math.floor(rand() * 6);
      for (let k = 0; k < nGraos; k++) {
        const tG = e.t + rand() * e.dur;
        const ints = intervalosVerticaisEm(cam.vertices, tG);
        if (!ints.length) continue;
        const faixa = faixaMaisProxima(ints, e.f);
        if (!faixa) continue;
        const [fMin, fMax] = faixa;
        // Grão = centro (e.f) ± dispersão, recortado pela faixa.
        const desloc = (rand() * 2 - 1) * DISPERSAO_GRANULAR_ST;
        let fg = midiParaHz(hzParaMidi(e.f) + desloc);
        if (fg < fMin) fg = fMin;
        if (fg > fMax) fg = fMax;
        fg = quantizar(fg, cam.quantizacaoAltura);
        const durG = 0.02 + rand() * 0.06;
        const envG = sortearEnvelope(envBase, envBase.rigor, rEnv);
        nuvem.push({
          t: tG,
          f: fg,
          dur: durG,
          tipoObjeto: 'granular',
          timbre: cam.timbre,
          vol: e.vol * (0.4 + rand() * 0.6),
          env: envG,
        });
      }
    }
    ev.push(...nuvem);
  }

  ev.sort((a, b) => a.t - b.t);
  return ev;
}

// ------------------------------------------------------------
// Envelope ADSR
// ------------------------------------------------------------
function agendarEnvelope(ctx, dest, env, t0, dur, pico) {
  const g = ctx.createGain();
  g.connect(dest);

  const peak = Math.max(0.0001, pico);
  const piso = 0.0001;

  const A = Math.max(0, (env.a || 0) / 100) * dur;
  const D = Math.max(0, (env.d || 0) / 100) * dur;
  const S = Math.max(0, (env.s || 0) / 100) * dur;
  const R = Math.max(0, (env.r || 0) / 100) * dur;

  const aMin = 0.002, rMin = 0.002;
  const A2 = Math.max(aMin, A);
  const R2 = Math.max(rMin, R);
  let ta = t0 + A2;
  let tr = t0 + dur - R2;
  if (tr < ta) {
    const meio = t0 + dur / 2;
    ta = meio;
    tr = meio;
  }
  const td = Math.min(tr, ta + D);
  const ts = Math.max(td, tr);

  const sustain = Math.max(piso, peak * (env.nivelSustain != null ? env.nivelSustain : 0.7));

  g.gain.setValueAtTime(piso, t0);
  if (ta > t0) g.gain.exponentialRampToValueAtTime(peak, ta);
  else g.gain.setValueAtTime(peak, t0);
  if (td > ta) g.gain.exponentialRampToValueAtTime(Math.max(piso, sustain), td);
  if (ts > td) g.gain.setValueAtTime(Math.max(piso, sustain), ts);
  if (t0 + dur > ts) g.gain.exponentialRampToValueAtTime(piso, t0 + dur);

  return g;
}

// ------------------------------------------------------------
// Síntese
// ------------------------------------------------------------
export function sintetizarEvento(ctx, dest, ev) {
  const t0 = ev.t;
  const dur = Math.max(0.005, ev.dur);
  const t1 = t0 + dur;
  const peak = Math.max(0.0001, ev.vol);
  const env = ev.env || { a: 5, d: 10, s: 70, r: 15, nivelSustain: 0.7, rigor: 100 };

  const envNode = agendarEnvelope(ctx, dest, env, t0, dur, peak);

  const tipoObjeto = ev.tipoObjeto || 'nota';
  const timbre = ev.timbre || { tipo: 'sine' };

  if (tipoObjeto === 'ruido') {
    sintetizarRuidoFiltrado(ctx, envNode, ev, t0, t1);
    return;
  }

  const freqBase = ev.f;

  const criarVoz = (freq, timbre, t0, t1, deslizar) => {
    const saida = ctx.createGain();
    saida.gain.value = 1;
    saida.connect(envNode);

    if (timbre.tipo === 'sine') {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq, t0);
      if (deslizar) o.frequency.linearRampToValueAtTime(freq * 0.98, t1);
      o.connect(saida);
      o.start(t0); o.stop(t1);
    } else if (timbre.tipo === 'aditiva') {
      const n = Math.max(1, Math.min(32, timbre.nHarm || 6));
      const incl = timbre.inclinacao || 1.5;
      for (let h = 1; h <= n; h++) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(freq * h, t0);
        if (deslizar) o.frequency.linearRampToValueAtTime(freq * h * 0.98, t1);
        const g = ctx.createGain();
        g.gain.value = 1 / Math.pow(h, incl);
        o.connect(g); g.connect(saida);
        o.start(t0); o.stop(t1);
      }
    } else if (timbre.tipo === 'fm') {
      const razao = timbre.razao || 2;
      const indice = timbre.indice || 3;
      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      carrier.frequency.setValueAtTime(freq, t0);
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.setValueAtTime(freq * razao, t0);
      const modGain = ctx.createGain();
      modGain.gain.value = freq * indice;
      mod.connect(modGain); modGain.connect(carrier.frequency);
      carrier.connect(saida);
      mod.start(t0); carrier.start(t0);
      mod.stop(t1); carrier.stop(t1);
    } else {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq, t0);
      o.connect(saida);
      o.start(t0); o.stop(t1);
    }
    return saida;
  };

  if (tipoObjeto === 'gliss') {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freqBase, t0);
    o.frequency.linearRampToValueAtTime(freqBase * (0.5 + 0.5 * Math.abs(Math.sin(freqBase))), t1);
    const g = ctx.createGain();
    g.gain.value = 1;
    o.connect(g); g.connect(envNode);
    o.start(t0); o.stop(t1);
  } else {
    criarVoz(freqBase, timbre, t0, t1, tipoObjeto === 'nota');
  }
}

function sintetizarRuidoFiltrado(ctx, dest, ev, t0, t1) {
  const dur = Math.max(0.02, t1 - t0);
  const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const dados = buf.getChannelData(0);
  const r = prng(Math.floor(ev.f * 1000) ^ 0x9e3779b9);
  for (let i = 0; i < bufferSize; i++) dados[i] = r() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(ev.f, t0);
  bp.frequency.linearRampToValueAtTime(ev.f * 1.05, t1);
  bp.Q.value = (ev.timbre && ev.timbre.q) || 4;
  src.connect(bp); bp.connect(dest);
  src.start(t0); src.stop(t1);
}

// ------------------------------------------------------------
// IR
// ------------------------------------------------------------
export function criarIR(ctx, tempoSeg) {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.floor(sr * Math.max(0.1, tempoSeg)));
  const buf = ctx.createBuffer(2, n, sr);
  const r = prng(0xC0FFEE);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const decai = Math.pow(1 - i / n, 2.5);
      d[i] = (r() * 2 - 1) * decai;
    }
  }
  return buf;
}

// ------------------------------------------------------------
// Cálculo de eventos
// ------------------------------------------------------------
export function calcularEventos(projeto, somenteCamadaId = null) {
  const eventosPorCamada = new Map();
  const camadasPorId = new Map();
  const soloGlobal = projeto.camadas.some(c => c.solo);

  for (const cam of projeto.camadas) {
    camadasPorId.set(cam.id, cam);
    if (somenteCamadaId) {
      if (cam.id !== somenteCamadaId) continue;
    } else {
      if (cam.mudo) continue;
      if (soloGlobal && !cam.solo) continue;
    }
    if (cam.vertices.length < 3) continue;

    const evs = gerarEventosCamada(cam, projeto.duracaoTotal);
    eventosPorCamada.set(cam.id, evs);
  }

  let atingidos = new Map();
  if (!somenteCamadaId) {
    const relacoesAtivas = projeto.relacoes.filter(r =>
      eventosPorCamada.has(r.camadaReferencia) &&
      r.camadasDependentes.some(id => eventosPorCamada.has(id))
    );
    if (relacoesAtivas.length) {
      atingidos = aplicarRelacoes(eventosPorCamada, relacoesAtivas, camadasPorId);
    }
  }

  return { eventos: eventosPorCamada, atingidos };
}

// ------------------------------------------------------------
// criarGrafo / agendarEventos / construirGrafo
// ------------------------------------------------------------
export function criarGrafo(ctx, projeto, opcoes = {}) {
  const master = ctx.createGain();
  master.gain.value = projeto.volumeMaster;

  const convolver = ctx.createConvolver();
  convolver.buffer = criarIR(ctx, projeto.reverbTempo || 2);
  const reverbGain = ctx.createGain();
  reverbGain.gain.value = 0.9;
  convolver.connect(reverbGain);
  reverbGain.connect(master);

  master.connect(ctx.destination);

  const camadas = new Map();
  const soloGlobal = projeto.camadas.some(c => c.solo);

  for (const cam of projeto.camadas) {
    if (opcoes.somenteCamadaId) {
      if (cam.id !== opcoes.somenteCamadaId) continue;
    } else {
      if (cam.mudo) continue;
      if (soloGlobal && !cam.solo) continue;
    }
    if (cam.vertices.length < 3) continue;

    const dinamica = ctx.createGain();
    dinamica.gain.value = 1.0;

    const g = ctx.createGain();
    g.gain.value = cam.volume != null ? cam.volume : 0.8;

    const pan = ctx.createStereoPanner();
    pan.pan.value = 0;

    const send = ctx.createGain();
    send.gain.value = 0;

    dinamica.connect(g);
    g.connect(pan); pan.connect(master);
    g.connect(send); send.connect(convolver);

    camadas.set(cam.id, { dinamica, gain: g, panner: pan, send });
  }

  return { master, convolver, reverbGain, camadas };
}

export function agendarEventos(ctx, projeto, eventos, grafo, opcoes = {}) {
  const inicioCtx = opcoes.inicioCtx != null ? opcoes.inicioCtx : 0;
  const deTempo = opcoes.deTempo != null ? opcoes.deTempo : 0;
  const janelaAte = opcoes.janelaAte != null ? opcoes.janelaAte : Infinity;

  for (const cam of projeto.camadas) {
    const nos = grafo.camadas.get(cam.id);
    if (!nos) continue;
    const evs = eventos.get(cam.id);
    if (!evs) continue;

    for (const ev of evs) {
      if (ev.t < deTempo - 1e-6) continue;
      if (ev.t >= janelaAte) continue;
      const tAbs = inicioCtx + ev.t;
      try {
        sintetizarEvento(ctx, nos.dinamica, { ...ev, t: tAbs });
      } catch (_) {}
    }
  }

  agendarAutomacoes(ctx, projeto, grafo.camadas, inicioCtx, deTempo, janelaAte);
}

function agendarAutomacoes(ctx, projeto, camadas, inicioCtx, deTempo, janelaAte) {
  const PASSO = 0.03;

  for (const cam of projeto.camadas) {
    const nos = camadas.get(cam.id);
    if (!nos) continue;

    const tIni = Math.max(0, deTempo);
    const tFim = isFinite(janelaAte) ? janelaAte : projeto.duracaoTotal;

    for (let t = tIni; t <= tFim + 1e-9; t += PASSO) {
      const tAbs = inicioCtx + t;
      const din = valorAutomacao(cam, 'dinamica', t);
      const panNorm = valorAutomacao(cam, 'panorama', t);
      const rev = valorAutomacao(cam, 'reverb', t);

      try { nos.dinamica.gain.linearRampToValueAtTime(Math.max(0.0001, din), tAbs); } catch(_){}
      try { nos.panner.pan.linearRampToValueAtTime(panNorm * 2 - 1, tAbs); } catch(_){}
      try { nos.send.gain.linearRampToValueAtTime(rev * 0.8, tAbs); } catch(_){}
    }
  }
}

export function construirGrafo(ctx, projeto, eventos, opcoes = {}) {
  const grafo = criarGrafo(ctx, projeto, opcoes);
  agendarEventos(ctx, projeto, eventos, grafo, {
    somenteCamadaId: opcoes.somenteCamadaId,
    inicioCtx: opcoes.inicioCtx != null ? opcoes.inicioCtx : 0,
    deTempo: opcoes.deTempo != null ? opcoes.deTempo : 0,
    janelaAte: opcoes.janelaAte != null ? opcoes.janelaAte : Infinity,
  });
  return grafo;
}

// ------------------------------------------------------------
// Motor online
// ------------------------------------------------------------
export const motor = {
  ctx: null,
  grafo: null,
  analisador: null,
  eventosPorCamada: new Map(),
  atingidos: new Map(),

  tocando: false,
  pausado: false,
  tInicio: 0,
  tPausa: 0,
  modo: null,

  timerJanela: null,
  timerAnimacao: null,

  JANELA_S: 4.0,
  INTERVALO_MS: 250,
  _janelaAte: 0,
  _ate: Infinity,
  _onFim: null,
  _onFrame: null,

  async garantirCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.analisador = this.ctx.createAnalyser();
      this.analisador.fftSize = 512;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  },

  async play(de = 0, opcoes = {}) {
    await this.garantirCtx();
    this._desmontarGrafo();

    this.modo = opcoes.somenteCamadaId
      ? { somenteCamadaId: opcoes.somenteCamadaId, ate: opcoes.ate ?? Infinity }
      : null;

    this._ate = (this.modo && isFinite(this.modo.ate))
      ? this.modo.ate
      : estado.projeto.duracaoTotal;

    const { eventos, atingidos } = calcularEventos(
      estado.projeto,
      this.modo ? this.modo.somenteCamadaId : null
    );
    this.eventosPorCamada = eventos;
    this.atingidos = atingidos;

    this.grafo = criarGrafo(this.ctx, estado.projeto, {
      somenteCamadaId: this.modo ? this.modo.somenteCamadaId : null,
    });
    this.grafo.master.connect(this.analisador);

    this.tInicio = this.ctx.currentTime - de;
    this.tPausa = de;
    this.tocando = true;
    this.pausado = false;
    this._janelaAte = de;

    this._agendarJanela();
    this._iniciarAnimacao();
    if (this._onFrame) this._onFrame();
  },

  async retomar() {
    if (!this.pausado) return;
    const de = this.tPausa;
    if (this.modo && this.modo.somenteCamadaId) {
      await this.play(de, { somenteCamadaId: this.modo.somenteCamadaId, ate: this.modo.ate });
    } else {
      await this.play(de, {});
    }
  },

  pausar() {
    if (!this.tocando) return;
    this.pausado = true;
    this.tocando = false;
    this.tPausa = this.tempoAtual();
    this._pararTimers();
    this._desmontarGrafo();
    window.__tempoReproducao = this.tPausa;
    atualizarTempoUI(this.tPausa);
    if (this._onFrame) this._onFrame();
  },

  parar() {
    const eraTocando = this.tocando;
    this.tocando = false;
    this.pausado = false;
    this.tPausa = 0;
    this.modo = null;
    this._pararTimers();

    if (eraTocando && this.grafo && this.ctx) {
      const t = this.ctx.currentTime;
      const g = this.grafo.master.gain;
      try {
        g.cancelScheduledValues(t);
        g.setValueAtTime(Math.max(0.0001, g.value), t);
        g.linearRampToValueAtTime(0.0001, t + 0.04);
      } catch (_) {}
      setTimeout(() => this._desmontarGrafo(), 60);
    } else {
      this._desmontarGrafo();
    }

    window.__tempoReproducao = null;
    atualizarTempoUI(0);
    if (this._onFrame) this._onFrame();
  },

  tempoAtual() {
    if (!this.ctx) return 0;
    if (!this.tocando) return this.tPausa;
    return Math.max(0, this.ctx.currentTime - this.tInicio);
  },

  _agendarJanela() {
    if (!this.tocando || !this.grafo) return;
    const tAgoraMusica = this.tempoAtual();
    const alvoAte = Math.min(tAgoraMusica + this.JANELA_S, this._ate);

    if (alvoAte > this._janelaAte) {
      const inicioCtx = this.tInicio;
      agendarEventos(this.ctx, estado.projeto, this.eventosPorCamada, this.grafo, {
        somenteCamadaId: this.modo ? this.modo.somenteCamadaId : null,
        inicioCtx,
        deTempo: this._janelaAte,
        janelaAte: alvoAte,
      });
      this._janelaAte = alvoAte;
    }

    if (tAgoraMusica >= this._ate) {
      const cb = this._onFim;
      this.parar();
      if (typeof cb === 'function') cb();
      return;
    }

    this.timerJanela = setTimeout(() => this._agendarJanela(), this.INTERVALO_MS);
  },

  _pararTimers() {
    if (this.timerJanela) clearTimeout(this.timerJanela);
    this.timerJanela = null;
    if (this.timerAnimacao) cancelAnimationFrame(this.timerAnimacao);
    this.timerAnimacao = null;
  },

  _desmontarGrafo() {
    if (!this.grafo) return;
    try { this.grafo.master.disconnect(); } catch (_) {}
    for (const c of this.grafo.camadas.values()) {
      try { c.dinamica.disconnect(); } catch (_) {}
      try { c.gain.disconnect(); } catch (_) {}
      try { c.panner.disconnect(); } catch (_) {}
      try { c.send.disconnect(); } catch (_) {}
    }
    this.grafo = null;
  },

  _iniciarAnimacao() {
    const loop = () => {
      if (!this.tocando) return;
      const t = this.tempoAtual();
      window.__tempoReproducao = t;
      atualizarTempoUI(t);
      atualizarMedidor(this.analisador);
      if (this._onFrame) this._onFrame();
      this.timerAnimacao = requestAnimationFrame(loop);
    };
    this.timerAnimacao = requestAnimationFrame(loop);
  },
};

function atualizarTempoUI(t) {
  const el = document.getElementById('tempoAtual');
  if (el) el.textContent = t.toFixed(2) + ' s';
}

function atualizarMedidor(analisador) {
  const fill = document.getElementById('medidorFill');
  if (!fill || !analisador) return;
  const buf = new Uint8Array(analisador.fftSize);
  analisador.getByteTimeDomainData(buf);
  let pico = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i] - 128) / 128;
    if (v > pico) pico = v;
  }
  fill.style.width = Math.min(100, pico * 140) + '%';
}

export async function tocarSomenteSelecionada() {
  const cam = camadaSelecionada();
  if (!cam || cam.vertices.length < 3) return false;

  const t0 = Math.max(0, Math.min(...cam.vertices.map(v => v.t)));
  const t1 = Math.min(estado.projeto.duracaoTotal, Math.max(...cam.vertices.map(v => v.t)));
  if (t1 <= t0) return false;

  await motor.play(t0, {
    somenteCamadaId: cam.id,
    ate: t1 + CAUDA_CAMADA_S,
  });

  if (typeof window.__rolarParaTempo === 'function') {
    window.__rolarParaTempo(t0);
  }
  return true;
}

export function valoresAtingidos() {
  return motor.atingidos || new Map();
}

export function recalcularAtingidos() {
  const { eventos, atingidos } = calcularEventos(estado.projeto, null);
  motor.eventosPorCamada = eventos;
  motor.atingidos = atingidos;
  return atingidos;
}