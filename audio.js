// ============================================================
// audio.js — Motor de áudio + grafo reutilizável (online/offline)
// ============================================================
//
// Cadeia por camada:
//   [vozes] → env (ADSR por evento) → dinamica → gain (volume) → panner → master → destination
//                                                               ↘ send → convolver → master
//
// Arquitetura de agendamento:
//  - Um ÚNICO grafo por execução (criado uma vez em `play`).
//  - A cada janela (~4 s), `agendarEventos` percorre as listas de
//    eventos e as curvas de automação, agendando só o que cai no
//    intervalo [deTempo, janelaAte). Nada é descartado, nada é
//    recriado; apenas continua de onde parou.
//  - No offline, uma única chamada com janelaAte=Infinity agenda
//    tudo.
//
// Correções (rodada 3):
//  - `play` não constrói mais o grafo vazio nem substitui grafo
//    a cada janela (isso interrompia o som após ~50 ms).
//  - `agendarAutomacoes` é chamada TAMBÉM no caminho offline
//    (antes só era chamada pelo motor online).
//  - `motor._onFim` permite à UI reagir ao fim natural.

import { estado, camadaSelecionada, valorAutomacao } from './model.js';
import { aplicarRelacoes } from './relations.js';

// ------------------------------------------------------------
// PRNG determinístico (mulberry32)
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
// Interseção polígono × vertical
// ------------------------------------------------------------
export function faixaVerticalEm(vertices, t) {
  if (!vertices || vertices.length < 3) return null;
  const fIntersect = [];
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[j], b = vertices[i];
    if ((a.t <= t && b.t > t) || (b.t <= t && a.t > t)) {
      const u = (t - a.t) / (b.t - a.t);
      fIntersect.push(a.f + u * (b.f - a.f));
    }
  }
  if (fIntersect.length < 2) return null;
  fIntersect.sort((x, y) => x - y);
  return [fIntersect[0], fIntersect[fIntersect.length - 1]];
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
// Geração de eventos por camada
// ------------------------------------------------------------
export function gerarEventosCamada(cam, duracaoTotal) {
  const ev = [];
  if (!cam || cam.mudo) return ev;
  if (cam.vertices.length < 3) return ev;

  const rand = prng(cam.semente);
  const rEnv = prng((cam.semente ^ 0xA5A5A5A5) >>> 0);

  const bpm = cam.andamento > 0 ? cam.andamento : 120;
  const pulsoSeg = cam.pulso > 0 ? cam.pulso : (60 / bpm);
  const dens = Math.max(0.1, cam.densidadeRitmica || 1);
  const padrao = (cam.padraoRitmico && cam.padraoRitmico.length) ? cam.padraoRitmico : [1];

  const envBase = cam.envelope || { a: 5, d: 10, s: 70, r: 15, nivelSustain: 0.7, rigor: 100 };

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

    const faixa = faixaVerticalEm(cam.vertices, t);
    if (!faixa) continue;
    const [fMin, fMax] = faixa;
    if (!(fMax > 0) || !(fMin > 0) || fMax <= fMin) continue;

    let f;
    if (cam.tipoObjeto === 'gliss') {
      const k = (i % 8) / 7;
      f = fMin + (fMax - fMin) * (rand() * 0.2 + k * 0.8);
    } else {
      f = fMin + (fMax - fMin) * rand();
    }
    f = quantizar(f, cam.quantizacaoAltura);

    let dur;
    if (cam.tipoObjeto === 'granular') dur = passo * (0.05 + rand() * 0.15);
    else if (cam.tipoObjeto === 'gliss') dur = passo * (0.9 + rand() * 0.5);
    else if (cam.tipoObjeto === 'ruido') dur = passo * (0.5 + rand() * 0.5);
    else dur = passo * (0.6 + rand() * 0.4);
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

  if (cam.tipoObjeto === 'granular') {
    const nuvem = [];
    for (const e of ev.slice()) {
      const nGraos = 6 + Math.floor(rand() * 6);
      for (let k = 0; k < nGraos; k++) {
        const faixa = faixaVerticalEm(cam.vertices, e.t + rand() * e.dur);
        if (!faixa) continue;
        const [fMin, fMax] = faixa;
        const fg = quantizar(fMin + (fMax - fMin) * rand(), cam.quantizacaoAltura);
        const durG = 0.02 + rand() * 0.06;
        const envG = sortearEnvelope(envBase, envBase.rigor, rEnv);
        nuvem.push({
          t: e.t + rand() * e.dur,
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
  if (ta > t0) {
    g.gain.exponentialRampToValueAtTime(peak, ta);
  } else {
    g.gain.setValueAtTime(peak, t0);
  }
  if (td > ta) {
    g.gain.exponentialRampToValueAtTime(Math.max(piso, sustain), td);
  }
  if (ts > td) {
    g.gain.setValueAtTime(Math.max(piso, sustain), ts);
  }
  if (t0 + dur > ts) {
    g.gain.exponentialRampToValueAtTime(piso, t0 + dur);
  }

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
// IR sintetizada (reverb)
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
// criarGrafo: monta master e cadeia por camada (NÃO agenda eventos)
// ------------------------------------------------------------
//
// Recebe `ctx` (online ou offline) e o projeto. Retorna o grafo
// com os nós prontos para receber agendamentos via `agendarEventos`.
//
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

// ------------------------------------------------------------
// agendarEventos: agenda eventos e automações num grafo existente
// ------------------------------------------------------------
//
// Percorre as listas de eventos do `eventos` (Map id->[ev]) e agenda
// os que caem em [deTempo, janelaAte). Também chama agendarAutomacoes
// para o mesmo intervalo.
//
// Em `deTempo=0, janelaAte=Infinity` agenda tudo (modo offline).
//
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
      } catch (_) { /* evento ruim: ignora */ }
    }
  }

  agendarAutomacoes(ctx, projeto, grafo.camadas, inicioCtx, deTempo, janelaAte);
}

// ------------------------------------------------------------
// Automações contínuas (dinâmica, pan, send)
// ------------------------------------------------------------
function agendarAutomacoes(ctx, projeto, camadas, inicioCtx, deTempo, janelaAte) {
  const PASSO = 0.03; // 30 ms

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

// ------------------------------------------------------------
// construirGrafo: conveniência (criar + agendar tudo de uma vez)
// ------------------------------------------------------------
//
// Usada pelo render offline e por qualquer consumidor que queira
// um grafo "completo". Equivale a criarGrafo + agendarEventos com
// janelaAte=Infinity.
//
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
  somenteCamadaId: null,

  timerJanela: null,
  timerAnimacao: null,

  // Em segundos de música.
  JANELA_S: 4.0,
  INTERVALO_MS: 250,

  // Até onde já agendamos (tempo de música).
  _janelaAte: 0,
  // Callback opcional chamado quando a reprodução termina sozinha.
  _onFim: null,

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

    // Desmonta o grafo antigo, se houver.
    this._desmontarGrafo();

    this.somenteCamadaId = opcoes.somenteCamadaId || null;

    // 1) Calcula eventos (com relações).
    const { eventos, atingidos } = calcularEventos(
      estado.projeto,
      this.somenteCamadaId
    );
    this.eventosPorCamada = eventos;
    this.atingidos = atingidos;

    // 2) Cria o grafo UMA vez.
    this.grafo = criarGrafo(this.ctx, estado.projeto, {
      somenteCamadaId: this.somenteCamadaId,
    });
    this.grafo.master.connect(this.analisador);

    // 3) Estado temporal.
    this.tInicio = this.ctx.currentTime - de;
    this.tPausa = de;
    this.tocando = true;
    this.pausado = false;
    this._janelaAte = de;

    // 4) Primeira janela.
    this._agendarJanela();

    // 5) Anima cursor/medidor.
    this._iniciarAnimacao();
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
  },

  parar() {
    this.tocando = false;
    this.pausado = false;
    this.tPausa = 0;
    this._pararTimers();
    this._desmontarGrafo();
    window.__tempoReproducao = 0;
    atualizarTempoUI(0);
  },

  tempoAtual() {
    if (!this.ctx) return 0;
    if (!this.tocando) return this.tPausa;
    return Math.max(0, this.ctx.currentTime - this.tInicio);
  },

  // ----------------------------------------------------------
  // Agendamento por janelas
  // ----------------------------------------------------------
  _agendarJanela() {
    if (!this.tocando || !this.grafo) return;
    const tAgoraMusica = this.tempoAtual();
    const duracao = estado.projeto.duracaoTotal;

    const alvoAte = Math.min(tAgoraMusica + this.JANELA_S, duracao);

    if (alvoAte > this._janelaAte) {
      const inicioCtx = this.tInicio;
      agendarEventos(this.ctx, estado.projeto, this.eventosPorCamada, this.grafo, {
        somenteCamadaId: this.somenteCamadaId,
        inicioCtx,
        deTempo: this._janelaAte,
        janelaAte: alvoAte,
      });
      this._janelaAte = alvoAte;
    }

    if (tAgoraMusica >= duracao) {
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

// ------------------------------------------------------------
// Solo: tocar uma única camada (sem mexer em flags)
// ------------------------------------------------------------
export async function tocarSomenteSelecionada() {
  const cam = camadaSelecionada();
  if (!cam) return false;
  await motor.play(0, { somenteCamadaId: cam.id });
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