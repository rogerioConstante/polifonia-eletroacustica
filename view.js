// ============================================================
// view.js — Renderização do gráfico (grade, polígonos, desenho)
// ============================================================
//
// Correções (rodada 2):
//  - Constante CALHA_PX reserva à esquerda do gráfico a mesma
//    largura da coluna de rótulos das faixas. Isso faz com que o
//    mesmo `t` caia na mesma coordenada x no gráfico e nas faixas.
//  - A calha também serve para exibir os rótulos de altura (nota +
//    Hz), sem que o usuário desenhe por cima.
//  - As faixas de automação agora desenham o cursor de reprodução.

import { estado, estaSelecionada, camadaSelecionada } from './model.js';

// Largura da calha à esquerda do gráfico (em CSS px).
// 4 (borda esquerda) + 84 (rótulo da faixa) + 1 (borda direita) = 89.
// Mantida em um único lugar para evitar desalinhamento.
export const CALHA_PX = 89;

let canvas, ctx, dpr = 1;
let W = 0, H = 0;
let _resizeObserver = null;

/** Inicializa o canvas e ajusta o DPR. */
export function initView(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  redimensionar();

  const wrap = canvas.parentElement;
  if (_resizeObserver) _resizeObserver.disconnect();
  _resizeObserver = new ResizeObserver(() => {
    redimensionar();
  });
  _resizeObserver.observe(wrap);
}

function redimensionar() {
  dpr = window.devicePixelRatio || 1;
  const r = canvas.parentElement.getBoundingClientRect();
  const novoW = Math.max(1, Math.floor(r.width));
  const novoH = Math.max(1, Math.floor(r.height));
  if (novoW === W && novoH === H && canvas.width === novoW * dpr) {
    return;
  }
  W = novoW; H = novoH;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  marcarRender();
}

export function tamanhoCanvas() { return { W, H }; }

// ------------------------------------------------------------
// Conversões tempo <-> pixel e freq <-> pixel
// ------------------------------------------------------------
// A calha desloca TODAS as conversões horizontais.
export function tParaX(t) {
  return CALHA_PX + (t - estado.scrollX) * estado.zoomX;
}
export function xParaT(x) {
  return (x - CALHA_PX) / estado.zoomX + estado.scrollX;
}
export function fParaY(f) {
  const base = Math.log2(estado.fMin);
  return H - (Math.log2(f) - base) * estado.zoomY;
}
export function yParaF(y) {
  const base = Math.log2(estado.fMin);
  return Math.pow(2, base + (H - y) / estado.zoomY);
}

export function midiParaHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
export function hzParaMidi(f) { return 69 + 12 * Math.log2(f / 440); }

const NOMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export function nomeNota(m) {
  const oit = Math.floor(m / 12) - 2; // C3 = dó central
  return NOMES[((m % 12) + 12) % 12] + oit;
}

// ------------------------------------------------------------
// Grade: régua em SEGUNDOS + grade de altura + calha à esquerda
// ------------------------------------------------------------
export function desenharGrade() {
  // Área do gráfico (branca)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(CALHA_PX, 0, W - CALHA_PX, H);

  // Calha (cinza escuro)
  ctx.fillStyle = '#2b2b2b';
  ctx.fillRect(0, 0, CALHA_PX, H);

  const t0 = estado.scrollX;
  const t1 = xParaT(W);

  // ----- 1) Régua de SEGUNDOS -----
  const passo = passoBonito(t1 - t0, 10);
  const sIni = Math.floor(t0 / passo) * passo;
  const sFim = Math.ceil(t1 / passo) * passo;

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.beginPath();
  for (let s = sIni; s <= sFim + 1e-9; s += passo) {
    const x = Math.round(tParaX(s)) + 0.5;
    if (x < CALHA_PX - 1 || x > W + 1) continue;
    ctx.moveTo(x, 0); ctx.lineTo(x, H);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(0,0,0,0.05)';
  ctx.beginPath();
  for (let s = sIni; s <= sFim + 1e-9; s += passo) {
    for (let k = 1; k < 5; k++) {
      const x = Math.round(tParaX(s + k * passo / 5)) + 0.5;
      if (x < CALHA_PX - 1 || x > W + 1) continue;
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
    }
  }
  ctx.stroke();

  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.font = '11px system-ui';
  ctx.textAlign = 'left';
  for (let s = sIni; s <= sFim + 1e-9; s += passo) {
    const x = tParaX(s);
    if (x < CALHA_PX + 2 || x > W + 30) continue;
    ctx.fillText(formatarSegundos(s), x + 3, 14);
  }

  // ----- 2) Linhas horizontais (semitons / oitavas) -----
  const fTopo = yParaF(0);
  const fBase = yParaF(H);
  const mTopo = Math.ceil(hzParaMidi(fTopo));
  const mBase = Math.floor(hzParaMidi(fBase));

  ctx.strokeStyle = 'rgba(0,0,0,0.05)';
  ctx.beginPath();
  for (let m = mBase; m <= mTopo; m++) {
    if (m % 12 === 0) continue;
    const y = Math.round(fParaY(midiParaHz(m))) + 0.5;
    if (y < 0 || y > H) continue;
    ctx.moveTo(CALHA_PX, y); ctx.lineTo(W, y);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.font = '10px system-ui';
  ctx.textAlign = 'left';
  ctx.beginPath();
  for (let m = mBase; m <= mTopo; m++) {
    if (m % 12 !== 0) continue;
    const f = midiParaHz(m);
    const y = Math.round(fParaY(f)) + 0.5;
    if (y < 0 || y > H) continue;
    ctx.moveTo(CALHA_PX, y); ctx.lineTo(W, y);
    // rótulo dentro da calha (fundo escuro, texto claro)
    ctx.fillStyle = 'rgba(220,220,220,0.85)';
    ctx.fillText(`${nomeNota(m)} · ${f.toFixed(1)}`, 4, y - 3);
  }
  ctx.stroke();

  // Linha divisória entre calha e gráfico
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath();
  ctx.moveTo(CALHA_PX + 0.5, 0);
  ctx.lineTo(CALHA_PX + 0.5, H);
  ctx.stroke();
}

function passoBonito(range, alvoDivisoes) {
  const bruto = range / alvoDivisoes;
  const pot = Math.pow(10, Math.floor(Math.log10(bruto)));
  const n = bruto / pot;
  let mult;
  if (n < 1.5) mult = 1;
  else if (n < 3.5) mult = 2;
  else if (n < 7.5) mult = 5;
  else mult = 10;
  return mult * pot;
}

function formatarSegundos(s) {
  if (Math.abs(s) < 1e-9) return '0s';
  if (s < 10) {
    const txt = (Math.round(s * 10) / 10).toString().replace('.', ',');
    return txt + 's';
  }
  return s.toFixed(0) + 's';
}

// ------------------------------------------------------------
// Polígonos das camadas
// ------------------------------------------------------------
export function desenharCamadas() {
  for (const cam of estado.projeto.camadas) {
    if (cam.mudo && !cam.solo) continue;
    desenharPoligono(cam);
  }
}

function corComAlfa(hex, alfa) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alfa})`;
}

function desenharPoligono(cam) {
  const v = cam.vertices;
  if (v.length < 3) {
    if (v.length === 2) desenharLinhaTemporaria(v, cam.cor);
    return;
  }
  const pts = v.map(p => [tParaX(p.t), fParaY(p.f)]);

  ctx.save();
  ctx.beginPath();
  // Recorta à área do gráfico (à direita da calha).
  ctx.rect(CALHA_PX, 0, W - CALHA_PX, H);
  ctx.clip();

  // Preenchimento
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.clip();

  ctx.fillStyle = corComAlfa(cam.cor, 0.30);
  ctx.fillRect(CALHA_PX, 0, W - CALHA_PX, H);
  desenharPadrao(cam.padraoPreenchimento, cam.cor);
  ctx.restore();

  // Borda
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.lineWidth = estaSelecionada(cam.id) ? 2.5 : 1.5;
  ctx.strokeStyle = estaSelecionada(cam.id) ? '#000' : corComAlfa(cam.cor, 0.9);
  ctx.stroke();

  // Vértices
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], estaSelecionada(cam.id) ? 4 : 3, 0, Math.PI * 2);
    ctx.fillStyle = estaSelecionada(cam.id) ? '#000' : cam.cor;
    ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
  }

  // Nome
  const c = centroide(pts);
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.font = '11px system-ui'; ctx.textAlign = 'center';
  ctx.fillText(cam.nome, c[0], c[1]);
}

function centroide(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

function desenharLinhaTemporaria(v, cor) {
  ctx.beginPath();
  ctx.moveTo(tParaX(v[0].t), fParaY(v[0].f));
  for (let i = 1; i < v.length; i++) ctx.lineTo(tParaX(v[i].t), fParaY(v[i].f));
  ctx.strokeStyle = cor; ctx.lineWidth = 2; ctx.stroke();
}

function desenharPadrao(tipo, cor) {
  const passo = 14;
  ctx.strokeStyle = corComAlfa(cor, 0.35);
  ctx.fillStyle = corComAlfa(cor, 0.35);
  ctx.lineWidth = 1;

  if (tipo === 'hachura') {
    ctx.beginPath();
    for (let x = CALHA_PX - H; x < W + H; x += passo) {
      ctx.moveTo(x, 0); ctx.lineTo(x + H, H);
    }
    ctx.stroke();
  } else if (tipo === 'pontos') {
    for (let x = CALHA_PX; x < W; x += passo) {
      for (let y = 0; y < H; y += passo) {
        ctx.beginPath(); ctx.arc(x, y, 1.2, 0, Math.PI * 2); ctx.fill();
      }
    }
  } else if (tipo === 'linhas') {
    ctx.beginPath();
    for (let y = 0; y < H; y += passo) { ctx.moveTo(CALHA_PX, y); ctx.lineTo(W, y); }
    ctx.stroke();
  } else if (tipo === 'xadrez') {
    for (let x = CALHA_PX; x < W; x += passo) {
      for (let y = 0; y < H; y += passo) {
        if (((x / passo) + (y / passo)) % 2 === 0) ctx.fillRect(x, y, passo, passo);
      }
    }
  }
}

// ------------------------------------------------------------
// Desenho em progresso
// ------------------------------------------------------------
export function desenharEmProgresso() {
  const d = estado.desenhando;
  if (!d || d.vertices.length === 0) return;
  const v = d.vertices;
  ctx.beginPath();
  ctx.moveTo(tParaX(v[0].t), fParaY(v[0].f));
  for (let i = 1; i < v.length; i++) ctx.lineTo(tParaX(v[i].t), fParaY(v[i].f));
  ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.stroke();
  ctx.setLineDash([]);
  for (const p of v) {
    ctx.beginPath(); ctx.arc(tParaX(p.t), fParaY(p.f), 4, 0, Math.PI * 2);
    ctx.fillStyle = '#000'; ctx.fill();
  }
}

// ------------------------------------------------------------
// Cursor de reprodução (gráfico principal)
// ------------------------------------------------------------
export function desenharCursor(tempo) {
  const x = tParaX(tempo);
  if (x < CALHA_PX || x > W) return;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H);
  ctx.strokeStyle = 'rgba(200,30,30,0.85)'; ctx.lineWidth = 1.5; ctx.stroke();
}

// ------------------------------------------------------------
// Faixas de automação: desenho + hit-test
// ------------------------------------------------------------
export const estadoAutomacao = {
  selecionada: null,
  arrasto: null,
};

export function desenharAutomacoes() {
  const cont = document.getElementById('automacoes');
  if (!cont) return;
  const cam = camadaSelecionada();

  if (!cam) {
    cont.classList.add('oculto');
    return;
  }
  cont.classList.remove('oculto');

  const canvases = cont.querySelectorAll('.faixaCanvas');
  canvases.forEach(cv => {
    const tipo = cv.parentElement.dataset.tipo;
    const dpr = window.devicePixelRatio || 1;

    // Largura REAL do canvas (nunca constante).
    const r = cv.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width));
    const h = Math.max(1, Math.floor(r.height));
    if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) {
      cv.width = Math.floor(w * dpr);
      cv.height = Math.floor(h * dpr);
      // O CSS já define width/height via flex; não forçamos inline.
    }
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);

    c.fillStyle = '#fff';
    c.fillRect(0, 0, w, h);

    // O tempo `t` é mapeado para x do canvas usando a MESMA
    // função do gráfico, subtraindo CALHA_PX (já que o canvas da
    // faixa começa DEPOIS do rótulo).
    const xT = (t) => tParaX(t) - CALHA_PX;
    const tDeX = (x) => xParaT(x + CALHA_PX);

    // Grid vertical alinhado ao gráfico.
    const t0 = estado.scrollX, t1 = tDeX(w);
    const passo = passoBonito(t1 - t0, 10);
    const sIni = Math.floor(t0 / passo) * passo;
    const sFim = Math.ceil(t1 / passo) * passo;
    c.strokeStyle = 'rgba(0,0,0,0.08)';
    c.lineWidth = 1;
    c.beginPath();
    for (let s = sIni; s <= sFim + 1e-9; s += passo) {
      const x = Math.round(xT(s)) + 0.5;
      if (x < 0 || x > w) continue;
      c.moveTo(x, 0); c.lineTo(x, h);
    }
    c.stroke();

    // Linha média
    c.strokeStyle = 'rgba(0,0,0,0.12)';
    c.beginPath();
    c.moveTo(0, h / 2 + 0.5); c.lineTo(w, h / 2 + 0.5);
    c.stroke();

    // Curva
    const pts = (cam.automacoes[tipo] || []).slice().sort((a, b) => a.t - b.t);
    desenharCurva(c, pts, tipo, w, h, cam.id, xT);

    // Cursor de reprodução nas faixas.
    if (window.__tempoReproducao != null) {
      const xc = xT(window.__tempoReproducao);
      if (xc >= 0 && xc <= w) {
        c.beginPath();
        c.moveTo(xc + 0.5, 0); c.lineTo(xc + 0.5, h);
        c.strokeStyle = 'rgba(200,30,30,0.85)';
        c.lineWidth = 1.5; c.stroke();
      }
    }

    // Legenda do ponto selecionado
    const sel = estadoAutomacao.selecionada;
    if (sel && sel.camId === cam.id && sel.tipo === tipo && pts[sel.idx]) {
      const p = pts[sel.idx];
      const x = xT(p.t);
      const y = valorParaY(p.v, h);
      c.fillStyle = '#000';
      c.font = '11px system-ui';
      c.textAlign = 'left';
      c.fillText(formatarValor(tipo, p.v), x + 6, y - 6);
    }
  });
}

export function valorParaY(v, h) { return h - v * h; }
export function yParaValor(y, h) { return Math.min(1, Math.max(0, 1 - y / h)); }

function formatarValor(tipo, v) {
  if (tipo === 'dinamica') return `${(v * 100).toFixed(0)}%`;
  if (tipo === 'panorama') {
    const p = v * 2 - 1;
    if (Math.abs(p) < 0.02) return 'centro';
    return p < 0 ? `L${Math.round(-p * 100)}` : `R${Math.round(p * 100)}`;
  }
  if (tipo === 'reverb') return `${(v * 100).toFixed(0)}%`;
  return v.toFixed(2);
}

function desenharCurva(c, pts, tipo, w, h, camId, xT) {
  const corFaixa = tipo === 'dinamica' ? '#6ab04c'
  : tipo === 'panorama' ? '#4a90d9'
  : '#9b59b6';

  const padraoV = tipo === 'dinamica' ? 1 : tipo === 'panorama' ? 0.5 : 0;
  const yPadrao = Math.round(valorParaY(padraoV, h)) + 0.5;
  c.strokeStyle = 'rgba(0,0,0,0.15)';
  c.setLineDash([4, 4]);
  c.beginPath(); c.moveTo(0, yPadrao); c.lineTo(w, yPadrao); c.stroke();
  c.setLineDash([]);

  if (pts.length === 0) return;

  c.strokeStyle = corFaixa;
  c.lineWidth = 1.6;
  c.beginPath();

  const primeiro = pts[0];
  c.moveTo(-10, valorParaY(primeiro.v, h));
  c.lineTo(xT(primeiro.t), valorParaY(primeiro.v, h));

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const xa = xT(a.t);
    const xb = xT(b.t);
    const ya = valorParaY(a.v, h);
    const yb = valorParaY(b.v, h);
    if (b.t <= estado.scrollX || a.t >= xParaT(w + CALHA_PX)) continue;
    if (a.curva === 'suave') {
      const n = 24;
      for (let k = 1; k <= n; k++) {
        const u = k / n;
        const kk = 0.5 - 0.5 * Math.cos(Math.PI * u);
        const x = xa + (xb - xa) * u;
        const y = ya + (yb - ya) * kk;
        c.lineTo(x, y);
      }
    } else {
      c.lineTo(xb, yb);
    }
  }

  const ultimo = pts[pts.length - 1];
  c.lineTo(xT(ultimo.t), valorParaY(ultimo.v, h));
  c.lineTo(w + 10, valorParaY(ultimo.v, h));
  c.stroke();

  const sel = estadoAutomacao.selecionada;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const x = xT(p.t);
    const y = valorParaY(p.v, h);
    if (x < -8 || x > w + 8) continue;
    const ehSel = sel && sel.camId === camId && sel.tipo === tipo && sel.idx === i;
    c.beginPath();
    c.arc(x, y, ehSel ? 5 : 3.5, 0, Math.PI * 2);
    c.fillStyle = ehSel ? '#000' : corFaixa;
    c.fill();
    c.strokeStyle = '#fff'; c.lineWidth = 1; c.stroke();
    if (p.curva === 'suave') {
      c.beginPath();
      c.arc(x, y, ehSel ? 7.5 : 6, 0, Math.PI * 2);
      c.strokeStyle = corFaixa; c.lineWidth = 1; c.stroke();
    }
  }
}

// --- hit-test (usado pela UI) ---------------------------------
// Aqui o x recebido é em coordenadas do canvas da FAIXA.
export function automacaoHitTest(canvasEl, x, y) {
  const cam = camadaSelecionada();
  if (!cam) return null;
  const tipo = canvasEl.parentElement.dataset.tipo;
  const h = canvasEl.getBoundingClientRect().height;
  const pts = (cam.automacoes[tipo] || []).slice().sort((a, b) => a.t - b.t);
  const xT = (t) => tParaX(t) - CALHA_PX;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const px = xT(p.t);
    const py = valorParaY(p.v, h);
    if (Math.hypot(px - x, py - y) < 8) return { tipo, idx: i };
  }
  return { tipo, idx: -1 };
}

// ------------------------------------------------------------
// Loop de render
// ------------------------------------------------------------
let precisaRender = true;
export function marcarRender() { precisaRender = true; }

export function iniciarLoop() {
  function frame() {
    if (!ctx) { requestAnimationFrame(frame); return; }
    if (precisaRender) {
      precisaRender = false;
      desenharGrade();
      desenharCamadas();
      desenharRelacoes();
      desenharEmProgresso();
      desenharAutomacoes();
      if (window.__tempoReproducao != null) desenharCursor(window.__tempoReproducao);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------
// Relações: linhas tracejadas entre camadas
// ------------------------------------------------------------
export function desenharRelacoes() {
  for (const r of estado.projeto.relacoes) {
    const ref = camadaPorIdLocal(r.camadaReferencia);
    if (!ref || ref.vertices.length < 3) continue;
    const centroRef = centroideTela(ref.vertices);
    for (const depId of r.camadasDependentes) {
      const dep = camadaPorIdLocal(depId);
      if (!dep || dep.vertices.length < 3) continue;
      const centroDep = centroideTela(dep.vertices);

      ctx.save();
      ctx.strokeStyle = hexParaRgba(ref.cor, 0.6);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(centroRef[0], centroRef[1]);
      ctx.lineTo(centroDep[0], centroDep[1]);
      ctx.stroke();
      ctx.setLineDash([]);

      const mx = (centroRef[0] + centroDep[0]) / 2;
      const my = (centroRef[1] + centroDep[1]) / 2;
      const ativos = [];
      if (r.ritmo != null)      ativos.push('R' + r.ritmo);
      if (r.direcao != null)    ativos.push('D' + r.direcao);
      if (r.intervalar != null) ativos.push('I' + r.intervalar);
      if (ativos.length) {
        const txt = ativos.join(' ');
        ctx.font = '10px system-ui';
        const w = ctx.measureText(txt).width + 6;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(mx - w / 2, my - 9, w, 14);
        ctx.strokeStyle = hexParaRgba(ref.cor, 0.9);
        ctx.strokeRect(mx - w / 2, my - 9, w, 14);
        ctx.fillStyle = '#000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, mx, my - 2);
      }
      ctx.restore();
    }
  }
}

function camadaPorIdLocal(id) {
  return estado.projeto.camadas.find(c => c.id === id);
}
function centroideTela(verts) {
  let x = 0, y = 0;
  for (const p of verts) { x += tParaX(p.t); y += fParaY(p.f); }
  return [x / verts.length, y / verts.length];
}
function hexParaRgba(hex, alfa) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alfa})`;
}