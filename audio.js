// ============================================================
// audio.js — Motor de áudio
// Polifonia Eletroacústica — Copyright (C) 2026 Rogério Tavares Constante
// Licença GPL-3.0 ou posterior (ver LICENSE).
// ============================================================
//
// Tipos de objeto:
//  - 'nota'     → ataques pulsados (grid do passo rítmico)
//  - 'gliss'    → feixe de trajetórias contínuas entre as bordas do
//                  polígono (ver continuo.js); ignora ritmo, ADSR e
//                  quantização
//  - 'continuo' → material pré-calculado que preenche a área do
//                  polígono (ver continuo.js); ignora ritmo, ADSR e
//                  série de alturas
//
// Timbres:
//  - 'sine', 'aditiva', 'fm', 'granular', 'ruido'
//
// A duração de cada evento em 'nota' é:
//   durBase = passo * multiplicadorDuracao
//   se aleatoriedadeDuracao > 0:
//     fator ∈ [1-k, 1+k], k = aleatoriedadeDuracao/100
//     dur = durBase * fator
//   senão dur = durBase
//   trunca por tMax com piso 0.01 s.
// ============================================================

import { estado, camadaSelecionada, valorAutomacao } from './model.js';
import { aplicarRelacoes } from './relations.js';
import { parseSerie } from './serie.js';
import { versaoArquivo, decodificarArquivo } from './arquivos.js';

export const CAUDA_CAMADA_S = 0;

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
  if (!quant || quant.modo === 'livre' || quant.modo === 'serie') return f;
  const m = Math.round(hzParaMidi(f));
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

export function transporPorOitava(f, fMin, fMax) {
  if (!(f > 0) || !(fMin > 0) || !(fMax >= fMin)) return null;
  const kMin = Math.ceil(Math.log2(fMin / f) - 1e-9);
  const kMax = Math.floor(Math.log2(fMax / f) + 1e-9);
  if (kMin > kMax) return null;
  const k = (kMin > 0) ? kMin : (kMax < 0 ? kMax : 0);
  return f * Math.pow(2, k);
}

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

export function ajustarAoPoligono(f, faixa, quant, opcoes = {}) {
  const quantizarAntes = opcoes.quantizarAntes !== false;
  const [fMin, fMax] = faixa || [0, 0];
  if (!(fMin > 0) || !(fMax >= fMin)) return { f, ajuste: 'nenhum' };
  let alvo = f;
  if (quantizarAntes) alvo = quantizar(alvo, quant);
  if (alvo >= fMin * 0.999 && alvo <= fMax * 1.001) return { f: alvo, ajuste: 'nenhum' };
  const oit = transporPorOitava(alvo, fMin, fMax);
  if (oit != null) {
    if (quantizarAntes) {
      const q = quantizar(oit, quant);
      if (q >= fMin * 0.999 && q <= fMax * 1.001) return { f: q, ajuste: 'oitava' };
    }
    return { f: oit, ajuste: 'oitava' };
  }
  const prox = quantizarNaFaixa(alvo, quant, fMin, fMax);
  if (prox != null) return { f: prox, ajuste: 'proxima' };
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
  for (let i = 0; i + 1 < fInts.length; i += 2) out.push([fInts[i], fInts[i + 1]]);
  return out;
}

export function faixaVerticalEm(vertices, t) {
  const ints = intervalosVerticaisEm(vertices, t);
  if (!ints.length) return null;
  return [ints[0][0], ints[ints.length - 1][1]];
}

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
// Envelope ADSR
// ------------------------------------------------------------
function sortearEnvelope(base, rigor, rEnv) {
  if (rigor >= 100) return { ...base };
  const u1 = rEnv()*2-1, u2 = rEnv()*2-1, u3 = rEnv()*2-1, u4 = rEnv()*2-1;
  const fator = 1 - rigor / 100;
  const a = Math.max(0, base.a * (1 + fator * u1));
  const d = Math.max(0, base.d * (1 + fator * u2));
  const s = Math.max(0, base.s * (1 + fator * u3));
  const r = Math.max(0, base.r * (1 + fator * u4));
  const soma = a + d + s + r;
  if (soma <= 0) return { ...base };
  const k = 100 / soma;
  const us = rEnv()*2-1;
  const nivelSustain = Math.min(1, Math.max(0, base.nivelSustain * (1 + fator * us)));
  return { a: a*k, d: d*k, s: s*k, r: r*k, nivelSustain, rigor };
}

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
  if (tr < ta) { const m = t0 + dur/2; ta = m; tr = m; }
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

// Envelope específico do grão (suavização em 0..100).
//  100%: A=50%, S=0%, R=50% (triangular)
//   50%: A=25%, S=50%, R=25%
//    0%: A=R=~0% (retangular)
function envelopeGrao(ctx, dest, t0, durGrao, suavizacao) {
  const g = ctx.createGain();
  g.connect(dest);
  const piso = 0.0001;
  const pico = 1.0;
  const s = Math.min(100, Math.max(0, suavizacao)) / 100;
  // A = metade de s (máx 50%), S = 1 - s, R = metade de s.
  const A = (0.5 * s) * durGrao;
  const R = (0.5 * s) * durGrao;
  const S = Math.max(0, durGrao - A - R);
  const aMin = 0.0005, rMin = 0.0005;
  const A2 = Math.max(aMin, A);
  const R2 = Math.max(rMin, R);
  const tS0 = t0 + A2;
  const tS1 = t0 + durGrao - R2;
  g.gain.setValueAtTime(piso, t0);
  if (A2 > aMin) g.gain.linearRampToValueAtTime(pico, tS0);
  else g.gain.setValueAtTime(pico, t0);
  if (S > 0 && tS1 > tS0) g.gain.setValueAtTime(pico, tS1);
  if (R2 > rMin) g.gain.linearRampToValueAtTime(piso, t0 + durGrao);
  else g.gain.setValueAtTime(piso, t0 + durGrao);
  return g;
}

// ------------------------------------------------------------
// Escolha de altura por série
// ------------------------------------------------------------
function alturaDaSerie(entradaMidi, cam, ints, rSerie, midiAnterior) {
  if (ints.length === 0) return null;
  const serie = cam.serieAlturas || { modo: 'absoluta', oitava: 'proxima' };
  const modo = serie.modo || 'absoluta';
  const alvoHz = midiParaHz(entradaMidi);
  const faixa = faixaMaisProxima(ints, alvoHz);
  if (!faixa) return null;
  const [fMin, fMax] = faixa;

  if (modo === 'absoluta') {
    const { f } = ajustarAoPoligono(midiParaHz(entradaMidi), faixa,
      cam.quantizacaoAltura, { quantizarAntes: false });
    return f;
  }
  const classe = ((Math.round(entradaMidi) % 12) + 12) % 12;
  const mTop = Math.floor(hzParaMidi(fMax));
  const mBase = Math.ceil(hzParaMidi(fMin));
  if (serie.oitava === 'aleatoria') {
    const cands = [];
    for (let m = mBase; m <= mTop; m++)
      if ((((m % 12) + 12) % 12) === classe) cands.push(m);
    if (cands.length) return midiParaHz(cands[Math.floor(rSerie() * cands.length)]);
  } else {
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
  const prox = quantizarNaFaixa(alvoHz, cam.quantizacaoAltura, fMin, fMax);
  return prox != null ? prox : alvoHz;
}

// ------------------------------------------------------------
// Geração de eventos
// ------------------------------------------------------------
export function gerarEventosCamada(cam, duracaoTotal) {
  const ev = [];
  if (!cam || cam.mudo) return ev;
  if (cam.vertices.length < 3) return ev;

  const rand = prng(cam.semente);
  const rEnv = prng((cam.semente ^ 0xA5A5A5A5) >>> 0);
  const rSerie = prng((cam.semente ^ 0x51ED270B) >>> 0);
  const rDur = prng((cam.semente ^ 0x8BADF00D) >>> 0);

  const bpm = cam.andamento > 0 ? cam.andamento : 120;
  const pulsoSeg = cam.pulso > 0 ? cam.pulso : (60 / bpm);
  const dens = Math.max(0.1, cam.densidadeRitmica || 1);
  const passo = pulsoSeg / dens;
  const padrao = (cam.padraoRitmico && cam.padraoRitmico.length) ? cam.padraoRitmico : [1];
  const envBase = cam.envelope || { a:5, d:10, s:70, r:15, nivelSustain:0.7, rigor:100 };

  const multDur = Math.max(0.1, Math.min(10, cam.multiplicadorDuracao ?? 1));
  const aleatDur = Math.max(0, Math.min(100, cam.aleatoriedadeDuracao ?? 0));
  const kDur = aleatDur / 100;

  const serieAtiva = cam.quantizacaoAltura && cam.quantizacaoAltura.modo === 'serie'
    && cam.serieAlturas && (cam.serieAlturas.texto || '').trim().length > 0;
  const serieValores = serieAtiva ? parseSerie(cam.serieAlturas.texto).valores : [];
  let idxAtaque = 0;
  let midiAnterior = null;

  const tMin = Math.min(...cam.vertices.map(v => v.t));
  const tMax = Math.max(...cam.vertices.map(v => v.t));
  const t0 = Math.max(0, tMin);
  const t1 = Math.min(duracaoTotal, tMax);
  if (t1 <= t0) return ev;

  // ---- Som contínuo e glissando: um único evento, calculado por continuo.js ----
  if (cam.tipoObjeto === 'continuo' || cam.tipoObjeto === 'gliss') {
    const fs = cam.vertices.map(v => v.f);
    ev.push({
      t: t0,
      f: Math.sqrt(Math.min(...fs) * Math.max(...fs)),
      dur: t1 - t0,
      tipoObjeto: cam.tipoObjeto,
      timbre: cam.timbre || { tipo: 'sine' },
      vol: cam.volume != null ? cam.volume : 0.8,
      // Descritor próprio: t0/t1 não mudam mesmo que uma relação
      // desloque ev.t.
      _cont: {
        modo: cam.tipoObjeto,
        vertices: cam.vertices.map(v => ({ t: v.t, f: v.f })),
        timbre: cam.timbre || { tipo: 'sine' },
        quant: cam.tipoObjeto === 'continuo'
          ? (cam.quantizacaoAltura || { modo: 'livre' }) : null,
        nGliss: cam.tipoObjeto === 'gliss' ? cam.densidadeGliss : null,
        semente: cam.semente,
        t0, t1,
      },
    });
    return ev;
  }

  // ---- Nota: ataques pulsados ----
  const nSlots = Math.max(1, Math.floor((t1 - t0) / passo));
  let idxPadrao = 0;

  for (let i = 0; i < nSlots; i++) {
    const ativo = padrao[idxPadrao % padrao.length] === 1;
    idxPadrao++;
    if (!ativo) continue;

    const t = t0 + i * passo;
    const ints = intervalosVerticaisEm(cam.vertices, t);
    if (!ints.length) continue;
    const centroFaixa = (ints[0][0] + ints[ints.length - 1][1]) / 2;
    const faixaRef = faixaMaisProxima(ints, centroFaixa);
    if (!faixaRef) continue;
    const [fMinRef, fMaxRef] = faixaRef;
    if (!(fMaxRef > 0) || !(fMinRef > 0) || fMaxRef <= fMinRef) continue;

    const r1 = rand();

    let f = null;
    let usadoSerie = false;
    if (serieAtiva && serieValores.length) {
      const token = serieValores[idxAtaque % serieValores.length];
      if (token != null) {
        const cand = alturaDaSerie(token, cam, ints, rSerie, midiAnterior);
        if (cand != null) { midiAnterior = hzParaMidi(cand); f = cand; usadoSerie = true; }
      }
    }
    if (!usadoSerie) {
      f = fMinRef + (fMaxRef - fMinRef) * r1;
      f = quantizar(f, cam.quantizacaoAltura);
      midiAnterior = hzParaMidi(f);
    }
    idxAtaque++;

    // Duração: passo * multiplicador, com aleatoriedade simétrica.
    const durBase = passo * multDur;
    let dur = durBase;
    if (kDur > 0) {
      const fator = 1 + kDur * (rDur() * 2 - 1);
      dur = durBase * fator;
    }
    if (t + dur > tMax) dur = Math.max(0.01, tMax - t);

    const envEv = sortearEnvelope(envBase, envBase.rigor, rEnv);

    ev.push({
      t, f, dur,
      tipoObjeto: cam.tipoObjeto,
      timbre: cam.timbre || { tipo: 'sine' },
      vol: cam.volume != null ? cam.volume : 0.8,
      env: envEv,
      semente: (cam.semente ^ Math.imul(idxAtaque, 0x9E3779B1)) >>> 0,
      _vertices: cam.vertices,
    });
  }

  ev.sort((a, b) => a.t - b.t);
  return ev;
}

// ------------------------------------------------------------
// Síntese de um evento
// ------------------------------------------------------------
export function sintetizarEvento(ctx, dest, ev) {
  if (ev._cont) return;  // ver agendarContinuos()
  if (usaArquivo(ev.timbre) && !ev._render) return;  // arquivo indisponível
  const t0 = ev.t;
  const dur = Math.max(0.005, ev.dur);
  const t1 = t0 + dur;
  const peak = Math.max(0.0001, ev.vol);
  const env = ev.env || { a:5, d:10, s:70, r:15, nivelSustain:0.7, rigor:100 };
  const envNode = agendarEnvelope(ctx, dest, env, t0, dur, peak);

  const timbre = ev.timbre || { tipo: 'sine' };

  // ---------- Ataques (nota) ----------
  if (usaArquivo(timbre)) {
    const dados = ev._render.dados;
    const buf = ctx.createBuffer(1, dados.length, ctx.sampleRate);
    buf.copyToChannel(dados, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(envNode);
    src.start(t0);
    return;
  }
  if (timbre.tipo === 'granular') {
    sintetizarGranularAtaque(ctx, envNode, ev, t0, t1, timbre);
    return;
  }
  if (timbre.tipo === 'ruido') {
    sintetizarRuidoAtaque(ctx, envNode, ev, t0, t1, timbre);
    return;
  }
  // nota + sine/aditiva/fm
  sintetizarNota(ctx, envNode, ev, t0, t1, timbre);
}

// ------------------------------------------------------------
// Síntese: nota (timbres senoidal, aditivo, FM)
// ------------------------------------------------------------
function sintetizarNota(ctx, dest, ev, t0, t1, timbre) {
  const f = ev.f;
  if (timbre.tipo === 'aditiva') {
    const n = Math.max(1, Math.min(32, timbre.nHarm || 6));
    const incl = timbre.inclinacao || 1.5;
    const soma = ctx.createGain();
    soma.gain.value = 1;
    soma.connect(dest);
    for (let h = 1; h <= n; h++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f * h, t0);
      const g = ctx.createGain();
      g.gain.value = 1 / Math.pow(h, incl);
      o.connect(g); g.connect(soma);
      o.start(t0); o.stop(t1);
    }
    return;
  }
  if (timbre.tipo === 'fm') {
    const razao = timbre.razao || 2;
    const indice = timbre.indice || 3;
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(f, t0);
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.setValueAtTime(f * razao, t0);
    const modGain = ctx.createGain();
    modGain.gain.value = f * indice;
    mod.connect(modGain); modGain.connect(carrier.frequency);
    carrier.connect(dest);
    mod.start(t0); carrier.start(t0);
    mod.stop(t1); carrier.stop(t1);
    return;
  }
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(f, t0);
  o.connect(dest);
  o.start(t0); o.stop(t1);
}

// ------------------------------------------------------------
// Síntese: ruído filtrado para ataques (nota+ruido)
// ------------------------------------------------------------
function sintetizarRuidoAtaque(ctx, dest, ev, t0, t1, timbre) {
  const dur = Math.max(0.02, t1 - t0);
  const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * dur)), ctx.sampleRate);
  const d = buf.getChannelData(0);
  const r = prng(Math.floor(ev.f * 1000) ^ 0x9e3779b9);
  for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(ev.f, t0);
  bp.frequency.linearRampToValueAtTime(ev.f * 1.05, t1);
  bp.Q.value = (timbre && timbre.q) || 4;
  src.connect(bp); bp.connect(dest);
  src.start(t0); src.stop(t1);
}

// ------------------------------------------------------------
// Síntese: granular para ataques (nota+granular)
// ------------------------------------------------------------
function sintetizarGranularAtaque(ctx, dest, ev, t0, t1, timbre) {
  const durTotal = Math.max(0.02, t1 - t0);
  const durGraoBase = (timbre.duracaoGraoMs ?? 30) / 1000;
  const aleat = (timbre.aleatoriedadeGrao ?? 0) / 100;
  const sobrep = (timbre.sobreposicao ?? 10) / 100;
  const suav = timbre.suavizacaoEnv ?? 50;
  const r = prng(Math.floor((ev.f * 1000) ^ 0x9e3779b9));

  // Taxa de grãos: no ataque, distribuímos grãos ao longo de durTotal.
  const passoGrao = Math.max(0.002, durGraoBase * (1 - sobrep));
  const nGraos = Math.max(1, Math.ceil(durTotal / passoGrao));

  for (let i = 0; i < nGraos; i++) {
    const tG = t0 + i * passoGrao;
    if (tG >= t1) break;
    const fatorDur = 1 + aleat * (r() * 2 - 1);
    const durGrao = Math.max(0.002, durGraoBase * fatorDur);
    const g = envelopeGrao(ctx, dest, tG, Math.min(durGrao, t1 - tG), suav);
    // cada grão é uma senoide curta na altura f (evento).
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(ev.f, tG);
    o.connect(g);
    o.start(tG); o.stop(tG + durGrao);
  }
}

// ------------------------------------------------------------
// Som contínuo e glissando: cálculo em Worker, cache e agendamento
// ------------------------------------------------------------
const CACHE_CONTINUO_MAX_AMOSTRAS = 120e6;  // ≈ 480 MB
const cacheContinuo = new Map();            // chave → Promise<resultado>
let workerContinuo = null;
let proximoJob = 1;
const fontesNoWorker = new Map();           // nome|sr → versão do arquivo
const jobsContinuo = new Map();

function obterWorker() {
  if (workerContinuo) return workerContinuo;
  workerContinuo = new Worker(new URL('./continuo.worker.js', import.meta.url),
                              { type: 'module' });
  workerContinuo.onmessage = (e) => {
    const job = jobsContinuo.get(e.data.id);
    if (!job) return;
    jobsContinuo.delete(e.data.id);
    if (e.data.erro) job.rejeitar(new Error(e.data.erro));
    else job.resolver(e.data);
  };
  workerContinuo.onerror = (e) => {
    for (const job of jobsContinuo.values()) job.rejeitar(new Error(e.message));
    jobsContinuo.clear();
    workerContinuo = null;
    fontesNoWorker.clear();
  };
  return workerContinuo;
}

function calcularContinuo(desc, sr) {
  const chave = JSON.stringify([sr, desc]);
  const emCache = cacheContinuo.get(chave);
  if (emCache) {
    cacheContinuo.delete(chave); cacheContinuo.set(chave, emCache);  // recente
    return emCache;
  }
  const promessa = new Promise((resolver, rejeitar) => {
    const id = proximoJob++;
    jobsContinuo.set(id, { resolver, rejeitar });
    obterWorker().postMessage({ id, desc, sr });
  });
  cacheContinuo.set(chave, promessa);
  promessa.then(limitarCacheContinuo, () => cacheContinuo.delete(chave));
  return promessa;
}

async function limitarCacheContinuo() {
  const chaves = [...cacheContinuo.keys()];
  let total = 0;
  for (let i = chaves.length - 1; i >= 0; i--) {
    const r = await Promise.resolve(cacheContinuo.get(chaves[i])).catch(() => null);
    total += r ? r.dados.length : 0;
    if (total > CACHE_CONTINUO_MAX_AMOSTRAS && i < chaves.length - 1) {
      cacheContinuo.delete(chaves[i]);
    }
  }
}

function usaArquivo(timbre) {
  return !!timbre && timbre.tipo === 'granular' && timbre.material === 'arquivo';
}

/** Garante que o arquivo esteja no Worker e devolve sua referência. */
async function garantirFonte(nome, sampleRate) {
  const versao = await versaoArquivo(nome);
  const chave = `${nome}|${sampleRate}`;
  if (fontesNoWorker.get(chave) !== versao) {
    const dados = await decodificarArquivo(nome, sampleRate);
    obterWorker().postMessage({ tipo: 'arquivo', chave, dados, sr: sampleRate }, [dados.buffer]);
    fontesNoWorker.set(chave, versao);
  }
  return { chave, versao };
}

/** Calcula os sons pré-renderizados, inclusive notas com grãos de arquivo.
 *  Guarda o resultado em ev._render. Devolve { omitidos, avisos }. */
export async function prepararContinuos(eventos, sampleRate, aoProgredir = null) {
  const lista = [];
  for (const evs of eventos.values())
    for (const ev of evs) if (ev._cont || usaArquivo(ev.timbre)) lista.push(ev);
  const fontes = new Map();
  const avisos = new Set();
  const fonteDe = (nome) => {
    if (!fontes.has(nome)) {
      fontes.set(nome, garantirFonte(nome, sampleRate).catch((e) => {
        avisos.add(e.message);
        return null;
      }));
    }
    return fontes.get(nome);
  };
  let prontos = 0, omitidos = 0;
  if (aoProgredir && lista.length) aoProgredir(0, lista.length);
  await Promise.all(lista.map(async (ev) => {
    let fonte = null;
    const arquivo = usaArquivo(ev.timbre);
    if (arquivo) {
      if (ev.timbre.arquivo) fonte = await fonteDe(ev.timbre.arquivo);
      else avisos.add('granular sem arquivo selecionado');
    }
    if (!arquivo || fonte) {
      const desc = ev._cont
        ? { ...ev._cont, fonte }
        : { modo: 'nota', timbre: ev.timbre, semente: ev.semente,
            t0: ev.t, t1: ev.t + ev.dur, f: ev.f, fonte,
            vertices: ev.timbre.transporGrao === false ? ev._vertices : undefined };
      const r = await calcularContinuo(desc, sampleRate);
      ev._render = r;
      omitidos += r.omitidos || 0;
    }
    prontos++;
    if (aoProgredir) aoProgredir(prontos, lista.length);
  }));
  return { omitidos, avisos: [...avisos] };
}

/** Agenda de uma só vez os sons contínuos ainda não terminados em deTempo. */
function agendarContinuos(ctx, projeto, eventos, grafo, inicioCtx, deTempo) {
  const FADE = 0.005;
  for (const cam of projeto.camadas) {
    const nos = grafo.camadas.get(cam.id);
    const evs = eventos.get(cam.id);
    if (!nos || !evs) continue;
    for (const ev of evs) {
      if (!ev._cont || !ev._render) continue;
      const { t0, t1 } = ev._cont;
      if (deTempo >= t1) continue;
      const dados = ev._render.dados;
      const buf = ctx.createBuffer(1, dados.length, ctx.sampleRate);
      buf.copyToChannel(dados, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const deslocamento = Math.max(0, deTempo - t0);
      const quando = inicioCtx + t0 + deslocamento;
      const g = ctx.createGain();
      if (deslocamento > 0) {  // começo no meio do objeto: evita clique
        g.gain.setValueAtTime(0, quando);
        g.gain.linearRampToValueAtTime(1, quando + FADE);
      }
      src.connect(g); g.connect(nos.dinamica);
      src.start(quando, deslocamento);
      grafo.fontesContinuas.push(src);
    }
  }
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
    eventosPorCamada.set(cam.id, gerarEventosCamada(cam, projeto.duracaoTotal));
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

    const dinamica = ctx.createGain(); dinamica.gain.value = 1.0;
    const g = ctx.createGain(); g.gain.value = cam.volume != null ? cam.volume : 0.8;
    const pan = ctx.createStereoPanner(); pan.pan.value = 0;
    const send = ctx.createGain(); send.gain.value = 0;

    dinamica.connect(g);
    g.connect(pan); pan.connect(master);
    g.connect(send); send.connect(convolver);
    camadas.set(cam.id, { dinamica, gain: g, panner: pan, send });
  }
  return { master, convolver, reverbGain, camadas, fontesContinuas: [] };
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
      try { sintetizarEvento(ctx, nos.dinamica, { ...ev, t: tAbs }); } catch (_) {}
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
  agendarContinuos(ctx, projeto, eventos, grafo,
    opcoes.inicioCtx != null ? opcoes.inicioCtx : 0,
    opcoes.deTempo != null ? opcoes.deTempo : 0);
  return grafo;
}

// ------------------------------------------------------------
// Motor online
// ------------------------------------------------------------
export const motor = {
  ctx: null, grafo: null, analisador: null,
  eventosPorCamada: new Map(), atingidos: new Map(),
  tocando: false, pausado: false,
  tInicio: 0, tPausa: 0, modo: null,
  timerJanela: null, timerAnimacao: null,
  JANELA_S: 4.0, INTERVALO_MS: 250,
  _janelaAte: 0, _ate: Infinity,
  _onFim: null, _onFrame: null, _onStatus: null,
  _tokenPlay: 0, avisos: [],

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
    const token = ++this._tokenPlay;
    await this.garantirCtx();
    if (token !== this._tokenPlay) return false;
    this._pararTimers();
    this.tocando = false;
    this._desmontarGrafo();
    this.modo = opcoes.somenteCamadaId
      ? { somenteCamadaId: opcoes.somenteCamadaId, ate: opcoes.ate ?? Infinity } : null;
    this._ate = (this.modo && isFinite(this.modo.ate))
      ? this.modo.ate : estado.projeto.duracaoTotal;

    const { eventos, atingidos } = calcularEventos(
      estado.projeto,
      this.modo ? this.modo.somenteCamadaId : null
    );
    this.eventosPorCamada = eventos;
    this.atingidos = atingidos;

    const { omitidos, avisos } = await prepararContinuos(eventos, this.ctx.sampleRate, (n, total) => {
      if (n < total && this._onStatus) this._onStatus(`calculando sons (${n}/${total})…`);
    });
    if (token !== this._tokenPlay) return false;  // stop ou novo play durante o cálculo
    this.avisos = omitidos
      ? [...avisos, `${omitidos} parciais fracos omitidos por custo`] : avisos;

    this.grafo = criarGrafo(this.ctx, estado.projeto, {
      somenteCamadaId: this.modo ? this.modo.somenteCamadaId : null,
    });
    this.grafo.master.connect(this.analisador);

    this.tInicio = this.ctx.currentTime - de;
    this.tPausa = de;
    this.tocando = true; this.pausado = false;
    this._janelaAte = de;
    agendarContinuos(this.ctx, estado.projeto, eventos, this.grafo, this.tInicio, de);
    this._agendarJanela();
    this._iniciarAnimacao();
    if (this._onFrame) this._onFrame();
    return true;
  },

  async retomar() {
    if (!this.pausado) return;
    const de = this.tPausa;
    if (this.modo && this.modo.somenteCamadaId) {
      return this.play(de, { somenteCamadaId: this.modo.somenteCamadaId, ate: this.modo.ate });
    }
    return this.play(de, {});
  },

  pausar() {
    if (!this.tocando) return;
    this._tokenPlay++;
    this.tPausa = this.tempoAtual();
    this.pausado = true; this.tocando = false;
    this._pararTimers(); this._desmontarGrafo();
    window.__tempoReproducao = this.tPausa;
    atualizarTempoUI(this.tPausa);
    if (this._onFrame) this._onFrame();
  },

  parar() {
    this._tokenPlay++;
    const eraTocando = this.tocando;
    this.tocando = false; this.pausado = false;
    this.tPausa = 0; this.modo = null;
    this._pararTimers();
    if (eraTocando && this.grafo && this.ctx) {
      const t = this.ctx.currentTime;
      const g = this.grafo.master.gain;
      try {
        g.cancelScheduledValues(t);
        g.setValueAtTime(Math.max(0.0001, g.value), t);
        g.linearRampToValueAtTime(0.0001, t + 0.04);
      } catch(_){}
      setTimeout(() => this._desmontarGrafo(), 60);
    } else this._desmontarGrafo();
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
        inicioCtx, deTempo: this._janelaAte, janelaAte: alvoAte,
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
    for (const src of this.grafo.fontesContinuas) {
      try { src.stop(); } catch(_){}
      try { src.disconnect(); } catch(_){}
    }
    try { this.grafo.master.disconnect(); } catch(_){}
    for (const c of this.grafo.camadas.values()) {
      try { c.dinamica.disconnect(); } catch(_){}
      try { c.gain.disconnect(); } catch(_){}
      try { c.panner.disconnect(); } catch(_){}
      try { c.send.disconnect(); } catch(_){}
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
  const iniciou = await motor.play(t0, { somenteCamadaId: cam.id, ate: t1 + CAUDA_CAMADA_S });
  if (!iniciou) return false;
  if (typeof window.__rolarParaTempo === 'function') window.__rolarParaTempo(t0);
  return true;
}
export function valoresAtingidos() { return motor.atingidos || new Map(); }
export function recalcularAtingidos() {
  const { eventos, atingidos } = calcularEventos(estado.projeto, null);
  motor.eventosPorCamada = eventos;
  motor.atingidos = atingidos;
  // Durante a reprodução, as notas com grãos de arquivo ainda por tocar
  // precisam do áudio calculado para as novas alturas.
  if (motor.tocando) prepararContinuos(eventos, motor.ctx.sampleRate).catch(() => {});
  return atingidos;
}