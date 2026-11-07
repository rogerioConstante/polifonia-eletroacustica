// ============================================================
// ui.js — Interações: mouse, teclado, painel, persistência
// ============================================================

import {
  estado, pushUndo, undo, redo, criarCamada, camadaPorId,
  camadaSelecionada, estaSelecionada, uid, timbrePadrao,
  pontoAutomacao, criarRelacaoDaSelecao, removerRelacao,
  normalizarEnvelope, extensaoTemporal,
} from './model.js';
import {
  initView, marcarRender, tamanhoCanvas, tParaX, xParaT,
  fParaY, yParaF, midiParaHz, hzParaMidi, estadoAutomacao,
  automacaoHitTest, valorParaY, yParaValor, CALHA_PX,
} from './view.js';
import {
  baixarProjeto, abrirProjetoDialogo, novoProjeto,
  restaurarAutosave, iniciarAutosave, salvarAutosave,
} from './persist.js';
import {
  motor, tocarSomenteSelecionada, valoresAtingidos, recalcularAtingidos,
} from './audio.js';
import { exportarWAV } from './export.js';
import { parseSerie, resumoSerie } from './serie.js';
import { listarArquivos, urlArquivo } from './arquivos.js';

let canvas;

export function initUI(canvasEl) {
  canvas = canvasEl;
  initView(canvas);
  const restaurou = restaurarAutosave();

  ligarFerramentas();
  ligarPainelProjeto();
  ligarPainelCamada();
  ligarPainelEnvelope();
  ligarPainelSerie();
  ligarPainelRelacoes();
  ligarMouse();
  ligarAutomacoes();
  ligarTeclado();
  ligarBotoesZoom();
  ligarTransporte();
  ligarExportacao();

  motor._onFrame = marcarRender;
  motor._onStatus = setStatus;
  motor._onFim = () => {
    const btnPlay = document.getElementById('btnPlay');
    if (btnPlay) btnPlay.textContent = '▶';
    const fill = document.getElementById('medidorFill');
    if (fill) fill.style.width = '0%';
    setStatus('fim');
    marcarRender();
  };

  window.__rolarParaTempo = (t) => {
    if (typeof t !== 'number' || !isFinite(t)) return;
    const larguraUtil = tamanhoCanvas().W - CALHA_PX;
    const visivelIni = estado.scrollX;
    const visivelFim = estado.scrollX + larguraUtil / estado.zoomX;
    if (t < visivelIni || t > visivelFim - 0.5) {
      estado.scrollX = Math.max(0, t - 0.5);
      marcarRender();
    }
  };

  iniciarAutosave();
  atualizarPainel();
  marcarRender();
  if (restaurou) setStatus('autosave restaurado');
}

// -------- Transporte --------
function ligarTransporte() {
  const btnPlay = document.getElementById('btnPlay');
  const btnPlayCamada = document.getElementById('btnPlayCamada');
  const btnStop = document.getElementById('btnStop');

  btnPlay.onclick = async () => {
    try {
      if (motor.tocando) { motor.pausar(); btnPlay.textContent = '▶'; setStatus('pausado'); }
      else {
        const ok = motor.pausado ? await motor.retomar() : await motor.play(0, {});
        if (ok) { btnPlay.textContent = '⏸'; setStatus('tocando' + avisoRender()); }
      }
    } catch (e) { setStatus('erro de áudio: ' + e.message); }
  };
  btnPlayCamada.onclick = async () => {
    try {
      const cam = camadaSelecionada(); if (!cam) return;
      if (motor.tocando || motor.pausado) motor.parar();
      const ok = await tocarSomenteSelecionada();
      if (ok) { btnPlay.textContent = '⏸'; setStatus('tocando somente ' + cam.nome + ' (relações ignoradas)' + avisoRender()); }
    } catch (e) { setStatus('erro de áudio: ' + e.message); }
  };
  btnStop.onclick = () => {
    motor.parar(); btnPlay.textContent = '▶'; setStatus('parado');
    const fill = document.getElementById('medidorFill'); if (fill) fill.style.width = '0%';
    marcarRender();
  };
  atualizarBotaoCamada();
}
function atualizarBotaoCamada() {
  const btn = document.getElementById('btnPlayCamada');
  if (!btn) return;
  btn.disabled = !camadaSelecionada();
}

// -------- Automações --------
function ligarAutomacoes() {
  const cont = document.getElementById('automacoes'); if (!cont) return;
  cont.addEventListener('mousedown', onAutomacaoMouseDown);
  cont.addEventListener('dblclick', onAutomacaoDblClick);
  cont.addEventListener('contextmenu', e => {
    const cv = e.target.closest('.faixaCanvas'); if (!cv) return;
    e.preventDefault();
    const { x, y } = posNoCanvas(cv, e);
    const hit = automacaoHitTest(cv, x, y);
    if (hit && hit.idx >= 0) removerPontoAutomacao(hit.tipo, hit.ponto);
  });
  window.addEventListener('mousemove', onAutomacaoMouseMove);
  window.addEventListener('mouseup', onAutomacaoMouseUp);
}
function posNoCanvas(cv, e) {
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function onAutomacaoMouseDown(e) {
  if (e.button !== 0) return;
  const cv = e.target.closest('.faixaCanvas'); if (!cv) return;
  const cam = camadaSelecionada(); if (!cam) return;
  const { x, y } = posNoCanvas(cv, e);
  const tipo = cv.parentElement.dataset.tipo;
  const h = cv.getBoundingClientRect().height;
  const hit = automacaoHitTest(cv, x, y);
  if (hit && hit.idx >= 0) {
    pushUndo();
    estadoAutomacao.selecionada = { camId: cam.id, tipo, ponto: hit.ponto };
    estadoAutomacao.arrasto = { camId: cam.id, tipo, ponto: hit.ponto };
    marcarRender(); return;
  }
  if (e.shiftKey) return;
  const t = Math.max(0, xParaT(x + CALHA_PX));
  const ext = extensaoTemporal(cam);
  if (ext && (t < ext.t0 - 1e-6 || t > ext.t1 + 1e-6)) { setStatus('fora do intervalo do polígono'); return; }
  const v = yParaValor(y, h);
  pushUndo();
  const pts = cam.automacoes[tipo] || [];
  const novo = pontoAutomacao(t, v, 'linear');
  pts.push(novo); pts.sort((a, b) => a.t - b.t);
  cam.automacoes[tipo] = pts;
  estadoAutomacao.selecionada = { camId: cam.id, tipo, ponto: novo };
  estadoAutomacao.arrasto = { camId: cam.id, tipo, ponto: novo };
  marcarRender();
}
function onAutomacaoMouseMove(e) {
  const arr = estadoAutomacao.arrasto; if (!arr) return;
  const cam = camadaPorId(arr.camId); if (!cam) return;
  const cont = document.getElementById('automacoes');
  const cv = cont.querySelector(`.faixa[data-tipo="${arr.tipo}"] .faixaCanvas`); if (!cv) return;
  const { x, y } = posNoCanvas(cv, e);
  const h = cv.getBoundingClientRect().height;
  const p = arr.ponto; if (!p) return;
  const ext = extensaoTemporal(cam);
  let t = Math.max(0, xParaT(x + CALHA_PX));
  if (ext) t = Math.min(Math.max(t, ext.t0), ext.t1);
  p.t = t; p.v = yParaValor(y, h);
  const pts = cam.automacoes[arr.tipo]; pts.sort((a, b) => a.t - b.t);
  marcarRender();
}
function onAutomacaoMouseUp() {
  if (estadoAutomacao.arrasto) {
    const cam = camadaSelecionada();
    if (cam) {
      const tipo = estadoAutomacao.arrasto.tipo;
      const pts = cam.automacoes[tipo]; pts.sort((a, b) => a.t - b.t);
    }
    estadoAutomacao.arrasto = null; marcarRender();
  }
}
function onAutomacaoDblClick(e) {
  const cv = e.target.closest('.faixaCanvas'); if (!cv) return;
  const cam = camadaSelecionada(); if (!cam) return;
  const { x, y } = posNoCanvas(cv, e);
  const hit = automacaoHitTest(cv, x, y);
  if (!hit || hit.idx < 0) return;
  pushUndo();
  hit.ponto.curva = (hit.ponto.curva === 'suave') ? 'linear' : 'suave';
  marcarRender();
}
function removerPontoAutomacao(tipo, ponto) {
  const cam = camadaSelecionada(); if (!cam) return;
  const pts = cam.automacoes[tipo]; if (!pts) return;
  const idx = pts.indexOf(ponto); if (idx < 0) return;
  pushUndo(); pts.splice(idx, 1);
  estadoAutomacao.selecionada = null;
  marcarRender(); setStatus('ponto removido');
}

// -------- Snap --------
function snapAltura(f) {
  if (!estado.snapAltura) return f;
  return midiParaHz(Math.round(hzParaMidi(f)));
}

// -------- Ferramentas / mouse / teclado --------
function ligarFerramentas() {
  document.getElementById('btnSelect').onclick = () => setFerramenta('select');
  document.getElementById('btnDraw').onclick = () => setFerramenta('draw');
  document.getElementById('btnDelete').onclick = excluirSelecao;
  document.getElementById('btnDuplicate').onclick = duplicarSelecao;
  document.getElementById('btnUndo').onclick = () => { if (undo()) { atualizarPainel(); marcarRender(); } };
  document.getElementById('btnRedo').onclick = () => { if (redo()) { atualizarPainel(); marcarRender(); } };
}
function setFerramenta(f) {
  estado.ferramenta = f; estado.desenhando = null;
  document.getElementById('btnSelect').classList.toggle('ativo', f === 'select');
  document.getElementById('btnDraw').classList.toggle('ativo', f === 'draw');
  marcarRender();
}
let arrasto = null;
function ligarMouse() {
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', onWheel, { passive: false });
}
function posMouse(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function onMouseDown(e) {
  if (e.button !== 0) return;
  const { x, y } = posMouse(e);
  if (x < CALHA_PX) return;
  const t = xParaT(x), f = yParaF(y);
  if (estado.ferramenta === 'draw') {
    if (!estado.desenhando) estado.desenhando = { vertices: [] };
    estado.desenhando.vertices.push({ t, f: snapAltura(f) });
    marcarRender(); return;
  }
  if (estado.selecao.length === 1) {
    const cam = camadaSelecionada();
    if (cam) {
      for (let i = 0; i < cam.vertices.length; i++) {
        const px = tParaX(cam.vertices[i].t);
        const py = fParaY(cam.vertices[i].f);
        if (Math.hypot(px - x, py - y) < 7) { pushUndo(); arrasto = { tipo: 'vertice', id: cam.id, idx: i }; return; }
      }
    }
  }
  const cam = camadaNoPonto(t, f);
  if (cam) {
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (estaSelecionada(cam.id)) estado.selecao = estado.selecao.filter(id => id !== cam.id);
      else estado.selecao.push(cam.id);
    } else {
      estado.selecao = [cam.id]; pushUndo();
      const origAuto = {
        dinamica: (cam.automacoes.dinamica || []).map(p => ({ obj: p, t: p.t })),
        panorama: (cam.automacoes.panorama || []).map(p => ({ obj: p, t: p.t })),
        reverb:   (cam.automacoes.reverb   || []).map(p => ({ obj: p, t: p.t })),
      };
      arrasto = { tipo: 'camada', id: cam.id, t0: t, f0: f,
                  orig: cam.vertices.map(v => ({ ...v })), origAuto };
    }
    atualizarPainel(); marcarRender(); return;
  }
  if (!e.shiftKey) estado.selecao = [];
  atualizarPainel(); marcarRender();
}
function onMouseMove(e) {
  if (!arrasto) return;
  const { x, y } = posMouse(e);
  const cam = camadaPorId(arrasto.id); if (!cam) return;
  if (arrasto.tipo === 'vertice') {
    cam.vertices[arrasto.idx] = { t: Math.max(0, xParaT(x)), f: snapAltura(yParaF(y)) };
  } else if (arrasto.tipo === 'camada') {
    let dt = xParaT(x) - arrasto.t0;
    const df = yParaF(y) / arrasto.f0;
    let minT = Infinity;
    for (const v of arrasto.orig) if (v.t < minT) minT = v.t;
    for (const lista of Object.values(arrasto.origAuto))
      for (const { t: tOrig } of lista) if (tOrig < minT) minT = tOrig;
    dt = Math.max(dt, -minT);
    for (let i = 0; i < cam.vertices.length; i++) {
      cam.vertices[i].t = arrasto.orig[i].t + dt;
      cam.vertices[i].f = arrasto.orig[i].f * df;
    }
    for (const lista of Object.values(arrasto.origAuto)) {
      for (const { obj, t: tOrig } of lista) obj.t = Math.max(0, tOrig + dt);
      const tipo = Object.keys(arrasto.origAuto).find(k => arrasto.origAuto[k] === lista);
      if (tipo && cam.automacoes[tipo]) cam.automacoes[tipo].sort((a, b) => a.t - b.t);
    }
  }
  marcarRender();
}
function onMouseUp() { if (arrasto) { arrasto = null; atualizarPainel(); } }
function onDblClick() { if (estado.ferramenta === 'draw') fecharPoligono(); }
function onWheel(e) {
  e.preventDefault();
  const { x } = posMouse(e);
  if (e.ctrlKey) {
    const tAntes = xParaT(x);
    const fator = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    estado.zoomX = Math.max(10, Math.min(1000, estado.zoomX * fator));
    const tDepois = xParaT(x);
    estado.scrollX += tAntes - tDepois;
  } else if (e.altKey) {
    const fator = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    estado.zoomY = Math.max(20, Math.min(600, estado.zoomY * fator));
  } else if (e.shiftKey) {
    estado.fMin *= Math.pow(2, e.deltaY * 0.002);
  } else {
    estado.scrollX += e.deltaY * 0.002 * ((tamanhoCanvas().W - CALHA_PX) / estado.zoomX);
    estado.scrollX = Math.max(0, estado.scrollX);
  }
  marcarRender();
}
function fecharPoligono() {
  const d = estado.desenhando;
  if (!d || d.vertices.length < 3) { estado.desenhando = null; marcarRender(); return; }
  pushUndo();
  const cam = criarCamada(d.vertices);
  estado.projeto.camadas.push(cam);
  estado.selecao = [cam.id];
  estado.desenhando = null;
  setFerramenta('select');
  atualizarPainel(); marcarRender();
}
function camadaNoPonto(t, f) {
  const cams = [...estado.projeto.camadas].reverse();
  for (const cam of cams) if (cam.vertices.length >= 3 && pontoEmPoligono(t, f, cam.vertices)) return cam;
  return null;
}
function pontoEmPoligono(t, f, verts) {
  let dentro = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i].t, yi = verts[i].f;
    const xj = verts[j].t, yj = verts[j].f;
    const inter = ((yi > f) !== (yj > f)) && (t < (xj - xi) * (f - yi) / (yj - yi) + xi);
    if (inter) dentro = !dentro;
  }
  return dentro;
}

function ligarTeclado() {
  window.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const sel = estadoAutomacao.selecionada;
      if (sel && sel.ponto) { removerPontoAutomacao(sel.tipo, sel.ponto); return; }
      excluirSelecao(); return;
    }
    if (e.key === 'v' || e.key === 'V') setFerramenta('select');
    else if (e.key === 'p' || e.key === 'P') setFerramenta('draw');
    else if (e.key === 'Enter') fecharPoligono();
    else if (e.key === 'Escape') { estado.desenhando = null; estadoAutomacao.selecionada = null; marcarRender(); }
    else if (e.key === ' ') { e.preventDefault(); document.getElementById('btnPlay').click(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (undo()) { atualizarPainel(); marcarRender(); } }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); if (redo()) { atualizarPainel(); marcarRender(); } }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicarSelecao(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); baixarProjeto(); setStatus('salvo'); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); abrirProjetoDialogo().then(ok => { if (ok) { atualizarPainel(); marcarRender(); setStatus('aberto'); } }); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') { e.preventDefault();
      const btn = document.getElementById('btnExportar'); if (btn) btn.click();
    }
  });
}

// -------- Ações --------
function excluirSelecao() {
  if (!estado.selecao.length) return;
  pushUndo();
  estado.projeto.camadas = estado.projeto.camadas.filter(c => !estaSelecionada(c.id));
  estado.projeto.relacoes = estado.projeto.relacoes.filter(r =>
    !estado.selecao.includes(r.camadaReferencia) &&
    !r.camadasDependentes.some(id => estado.selecao.includes(id))
  );
  estado.selecao = [];
  atualizarBotaoCamada(); atualizarPainel(); marcarRender();
}
function duplicarSelecao() {
  if (!estado.selecao.length) return;
  pushUndo();
  const novas = [];
  for (const id of estado.selecao) {
    const cam = camadaPorId(id); if (!cam) continue;
    const copia = JSON.parse(JSON.stringify(cam));
    copia.id = uid(); copia.nome = cam.nome + ' (cópia)';
    copia.vertices = copia.vertices.map(v => ({ t: v.t + 0.5, f: v.f }));
    for (const tipo of ['dinamica','panorama','reverb']) {
      copia.automacoes[tipo] = (copia.automacoes[tipo] || []).map(p => ({ ...p, t: p.t + 0.5 }));
    }
    estado.projeto.camadas.push(copia); novas.push(copia.id);
  }
  estado.selecao = novas;
  atualizarPainel(); marcarRender();
}

// -------- Zoom --------
function ligarBotoesZoom() {
  document.getElementById('btnZoomHMais').onclick = () => { estado.zoomX = Math.min(1000, estado.zoomX * 1.25); marcarRender(); };
  document.getElementById('btnZoomHMenos').onclick = () => { estado.zoomX = Math.max(10, estado.zoomX / 1.25); marcarRender(); };
  document.getElementById('btnZoomVMais').onclick = () => { estado.zoomY = Math.min(600, estado.zoomY * 1.15); marcarRender(); };
  document.getElementById('btnZoomVMenos').onclick = () => { estado.zoomY = Math.max(20, estado.zoomY / 1.15); marcarRender(); };
  document.getElementById('btnFit').onclick = () => {
    estado.scrollX = 0;
    estado.zoomX = (tamanhoCanvas().W - CALHA_PX) / estado.projeto.duracaoTotal;
    estado.zoomY = tamanhoCanvas().H / estado.oitavasVisiveis;
    marcarRender();
  };
}

// -------- Painel: Projeto --------
function ligarPainelProjeto() {
  document.getElementById('btnNovo').onclick = () => {
    if (!confirm('Criar novo projeto? O atual será descartado.')) return;
    novoProjeto(); atualizarPainel(); marcarRender(); setStatus('novo projeto');
  };
  document.getElementById('btnAbrir').onclick = () => {
    abrirProjetoDialogo().then(ok => {
      if (ok) { atualizarPainel(); marcarRender(); setStatus('aberto'); }
    }).catch(err => setStatus('erro ao abrir: ' + err.message));
  };
  document.getElementById('btnSalvar').onclick = () => { baixarProjeto(); setStatus('salvo'); };

  const vm = document.getElementById('volMaster');
  vm.oninput = () => {
    estado.projeto.volumeMaster = +vm.value;
    document.getElementById('volMasterVal').textContent = (+vm.value).toFixed(2);
  };
  document.getElementById('durTotal').oninput = e => {
    estado.projeto.duracaoTotal = +e.target.value || 30;
    marcarRender();
  };
  document.getElementById('snapAltura').onchange = e => { estado.snapAltura = e.target.checked; };
  const rt = document.getElementById('reverbTempo');
  if (rt) rt.oninput = e => { estado.projeto.reverbTempo = Math.max(0.1, +e.target.value || 2); };
}

// -------- Painel: Camada --------
function ligarPainelCamada() {
  const camposSimples = {
    cNome:   (c, el) => { c.nome = el.value; },
    cCor:    (c, el) => { c.cor = el.value; },
    cPadrao: (c, el) => { c.padraoPreenchimento = el.value; },
    cTipo:   (c, el) => { c.tipoObjeto = el.value; },
    cVol:    (c, el) => { c.volume = +el.value; },
    cNGliss: (c, el) => { c.densidadeGliss = Math.max(2, Math.min(100, Math.round(+el.value) || 2)); },
    cDens:   (c, el) => { c.densidadeRitmica = +el.value; },
    cSemente:(c, el) => { c.semente = +el.value; },
    cMudo:   (c, el) => { c.mudo = el.checked; },
    cSolo:   (c, el) => { c.solo = el.checked; },
  };
  for (const [id, aplicar] of Object.entries(camposSimples)) {
    const el = document.getElementById(id);
    el.addEventListener('focus', () => { if (camadaSelecionada()) pushUndo(); });
    el.addEventListener('pointerdown', () => { if (camadaSelecionada()) pushUndo(); });
    el.addEventListener('input', () => {
      const cam = camadaSelecionada(); if (!cam) return;
      aplicar(cam, el);
      if (el.type === 'range') {
        const span = document.getElementById(id + 'Val');
        if (span) span.textContent = (+el.value).toFixed(2);
      }
      if (id === 'cDens') atualizarResumoRitmo();
      if (id === 'cTipo') atualizarPainel();
      atualizarLista(); marcarRender();
    });
  }

  // Pulso / BPM
  const cPulso = document.getElementById('cPulso');
  const cBpm = document.getElementById('cBpm');
  cPulso.addEventListener('focus', () => { if (camadaSelecionada()) pushUndo(); });
  cPulso.addEventListener('pointerdown', () => { if (camadaSelecionada()) pushUndo(); });
  cPulso.addEventListener('input', () => {
    const cam = camadaSelecionada(); if (!cam) return;
    const p = Math.max(0.02, +cPulso.value || 0.5);
    cam.pulso = p; cam.andamento = Math.round(60 / p);
    cBpm.value = cam.andamento;
    atualizarResumoRitmo();
  });
  cBpm.addEventListener('focus', () => { if (camadaSelecionada()) pushUndo(); });
  cBpm.addEventListener('pointerdown', () => { if (camadaSelecionada()) pushUndo(); });
  cBpm.addEventListener('input', () => {
    const cam = camadaSelecionada(); if (!cam) return;
    const b = Math.max(20, Math.min(600, +cBpm.value || 120));
    cam.andamento = b; cam.pulso = 60 / b;
    cPulso.value = cam.pulso.toFixed(3);
    atualizarResumoRitmo();
  });

  // Padrão rítmico
  const elPad = document.getElementById('cPadraoRitmico');
  elPad.addEventListener('focus', () => { if (camadaSelecionada()) pushUndo(); });
  elPad.addEventListener('change', () => {
    const cam = camadaSelecionada(); if (!cam) return;
    const arr = elPad.value.split(',')
      .map(s => s.trim()).filter(s => s !== '')
      .map(s => (s === '1' || s === '0') ? +s : null)
      .filter(v => v !== null);
    if (!arr.length) { elPad.value = cam.padraoRitmico.join(','); return; }
    cam.padraoRitmico = arr;
    elPad.value = arr.join(',');
    atualizarResumoRitmo();
  });

  // Multiplicador e Aleatoriedade da duração
  const cMult = document.getElementById('cMultDur');
  const cAleat = document.getElementById('cAleatDur');
  cMult.addEventListener('focus', () => { if (camadaSelecionada()) pushUndo(); });
  cMult.addEventListener('pointerdown', () => { if (camadaSelecionada()) pushUndo(); });
  cMult.addEventListener('input', () => {
    const cam = camadaSelecionada(); if (!cam) return;
    cam.multiplicadorDuracao = Math.max(0.1, Math.min(10, +cMult.value || 1));
    document.getElementById('cMultDurVal').textContent = cam.multiplicadorDuracao.toFixed(1);
  });
  cAleat.addEventListener('focus', () => { if (camadaSelecionada()) pushUndo(); });
  cAleat.addEventListener('pointerdown', () => { if (camadaSelecionada()) pushUndo(); });
  cAleat.addEventListener('input', () => {
    const cam = camadaSelecionada(); if (!cam) return;
    cam.aleatoriedadeDuracao = Math.max(0, Math.min(100, +cAleat.value || 0));
    document.getElementById('cAleatDurVal').textContent = cam.aleatoriedadeDuracao + '%';
  });

  // Quantização (com 'serie')
  const selQ = document.getElementById('cQuant');
  selQ.addEventListener('pointerdown', () => { if (camadaSelecionada()) pushUndo(); });
  selQ.addEventListener('change', () => {
    const cam = camadaSelecionada(); if (!cam) return;
    const modo = selQ.value;
    if (modo === 'conjunto') {
      const classes = cam.quantizacaoAltura.classes || [0,2,4,5,7,9,11];
      cam.quantizacaoAltura = { modo, classes };
    } else if (modo === 'serie') {
      cam.quantizacaoAltura = { modo: 'serie' };
    } else {
      cam.quantizacaoAltura = { modo };
    }
    atualizarPainel(); marcarRender();
  });

  // Sortear semente
  document.getElementById('btnSortear').onclick = () => {
    const cam = camadaSelecionada(); if (!cam) return;
    pushUndo();
    cam.semente = Math.floor(Math.random() * 1e6);
    document.getElementById('cSemente').value = cam.semente;
  };

  // Timbre
  const selT = document.getElementById('cTimbre');
  selT.addEventListener('pointerdown', () => { if (camadaSelecionada()) pushUndo(); });
  selT.addEventListener('change', () => {
    const cam = camadaSelecionada(); if (!cam) return;
    cam.timbre = timbrePadrao(selT.value);
    renderizarTimbre(cam);
    atualizarAvisoQuant(cam);
    marcarRender();
  });
}

// -------- Painel: Timbre --------
function renderizarTimbre(cam) {
  const box = document.getElementById('timbreParams');
  if (!box) return;
  box.innerHTML = '';
  const t = cam.timbre || { tipo: 'sine' };

  function campo(id, rotulo, min, max, step, valor, unidade) {
    const l = document.createElement('label');
    l.textContent = rotulo + ' ';
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.id = id;
    inp.min = min; inp.max = max; inp.step = step;
    inp.value = valor;
    inp.addEventListener('focus', () => { if (camadaSelecionada()) pushUndo(); });
    inp.addEventListener('change', () => {
      const cam2 = camadaSelecionada(); if (!cam2) return;
      cam2.timbre[id] = +inp.value;
    });
    l.appendChild(inp);
    if (unidade) {
      const sp = document.createElement('span');
      sp.textContent = unidade; l.appendChild(sp);
    }
    box.appendChild(l);
  }

  if (t.tipo === 'sine') {
    const d = document.createElement('div'); d.className = 'dica';
    d.textContent = 'Sem parâmetros.'; box.appendChild(d);
  } else if (t.tipo === 'aditiva') {
    campo('nHarm', 'Harmônicos', 1, 32, 1, t.nHarm ?? 6);
    campo('inclinacao', 'Inclinação', 0.1, 5, 0.1, t.inclinacao ?? 1.5);
  } else if (t.tipo === 'fm') {
    campo('razao', 'Razão', 0.1, 10, 0.1, t.razao ?? 2);
    campo('indice', 'Índice', 0, 20, 0.1, t.indice ?? 3);
  } else if (t.tipo === 'granular') {
    renderizarMaterial(box, cam, t, campo);
    campo('duracaoGraoMs',   'Duração do grão', 10, 100, 1,   t.duracaoGraoMs   ?? 30, 'ms');
    campo('suavizacaoEnv',   'Suavização',      0,  100, 1,   t.suavizacaoEnv   ?? 50, '%');
    campo('aleatoriedadeGrao','Aleatoriedade',  0,  100, 1,   t.aleatoriedadeGrao ?? 0, '%');
    if (cam.tipoObjeto === 'continuo') {
      campo('densidadeGraos', 'Densidade', 1, 2000, 1, t.densidadeGraos ?? 100, 'grãos/s por oitava');
    } else if (cam.tipoObjeto === 'gliss') {
      campo('densidadeGraos', 'Densidade', 1, 2000, 1, t.densidadeGraos ?? 100, 'grãos/s por glissando');
    } else {
      campo('sobreposicao',  'Sobreposição',    0,   50, 1,   t.sobreposicao    ?? 10, '%');
    }
  } else if (t.tipo === 'ruido') {
    if (cam.tipoObjeto === 'continuo') {
      const d = document.createElement('div'); d.className = 'dica';
      d.textContent = 'Ruído branco limitado à área do polígono.'; box.appendChild(d);
    } else if (cam.tipoObjeto === 'gliss') {
      campo('larguraBandaSt', 'Largura da banda', 0.1, 12, 0.1, t.larguraBandaSt ?? 1, 'semitons');
    } else {
      campo('q', 'Q do filtro', 0.1, 30, 0.1, t.q ?? 4);
    }
  }
}

function renderizarMaterial(box, cam, t, campo) {
  const material = t.material === 'arquivo' ? 'arquivo' : 'senoide';
  const rotulo = document.createElement('label');
  rotulo.textContent = 'Material ';
  const sel = document.createElement('select');
  sel.id = 'cMaterial';
  sel.innerHTML = '<option value="senoide">Senoide</option><option value="arquivo">Arquivo de áudio</option>';
  sel.value = material;
  sel.addEventListener('pointerdown', () => { if (camadaSelecionada()) pushUndo(); });
  sel.addEventListener('change', () => {
    const cam2 = camadaSelecionada(); if (!cam2) return;
    cam2.timbre.material = sel.value;
    renderizarTimbre(cam2);
  });
  rotulo.appendChild(sel);
  box.appendChild(rotulo);
  if (material !== 'arquivo') return;

  const linha = document.createElement('label');
  linha.textContent = 'Arquivo ';
  const selA = document.createElement('select');
  selA.id = 'cArquivo';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '↻';
  btn.title = 'Atualizar a lista da pasta audios/';
  linha.appendChild(selA);
  linha.appendChild(btn);
  box.appendChild(linha);

  // Audição direta do arquivo, fora da cadeia de áudio do programa.
  const player = document.createElement('audio');
  player.id = 'cOuvirArquivo';
  player.controls = true;
  player.preload = 'metadata';
  box.appendChild(player);

  const aviso = document.createElement('div');
  aviso.className = 'dica';
  box.appendChild(aviso);

  const mostrarArquivo = (nome) => {
    player.style.display = nome ? 'block' : 'none';
    if (nome) player.src = urlArquivo(nome); else player.removeAttribute('src');
  };

  const preencher = async () => {
    let nomes = [];
    let erro = false;
    try { nomes = await listarArquivos(); } catch (_) { erro = true; }
    const atual = (camadaSelecionada() || cam).timbre.arquivo || '';
    const presente = !atual || nomes.includes(atual);
    selA.innerHTML = '';
    const opcao = (valor, texto) => {
      const o = document.createElement('option');
      o.value = valor; o.textContent = texto;
      selA.appendChild(o);
    };
    opcao('', '— escolher —');
    if (!presente) opcao(atual, atual + ' (ausente)');
    for (const nome of nomes) opcao(nome, nome);
    selA.value = atual;
    if (erro) aviso.textContent = 'Não foi possível ler a pasta audios/.';
    else if (!presente) aviso.textContent = 'Arquivo ausente da pasta audios/: a camada não soará.';
    else if (!nomes.length) aviso.textContent = 'Coloque arquivos na pasta audios/ e clique em ↻.';
    else aviso.textContent = '';
    mostrarArquivo(presente ? atual : '');
  };

  selA.addEventListener('pointerdown', () => { if (camadaSelecionada()) pushUndo(); });
  selA.addEventListener('change', () => {
    const cam2 = camadaSelecionada(); if (!cam2) return;
    cam2.timbre.arquivo = selA.value;
    aviso.textContent = '';
    mostrarArquivo(selA.value);
  });
  btn.addEventListener('click', (e) => { e.preventDefault(); preencher(); });
  preencher();

  const rotuloT = document.createElement('label');
  const chkT = document.createElement('input');
  chkT.type = 'checkbox';
  chkT.id = 'cTransporGrao';
  chkT.checked = t.transporGrao !== false;
  chkT.addEventListener('pointerdown', () => { if (camadaSelecionada()) pushUndo(); });
  rotuloT.appendChild(chkT);
  rotuloT.appendChild(document.createTextNode(' Transpor grãos para a altura-alvo'));
  box.appendChild(rotuloT);
  const dicaT = document.createElement('div');
  dicaT.className = 'dica';
  const atualizarDicaT = () => {
    dicaT.textContent = chkT.checked ? ''
      : 'Só a filtragem delimita o polígono; o nível pode ficar baixo ou chegar ao silêncio.';
  };
  atualizarDicaT();
  box.appendChild(dicaT);
  chkT.addEventListener('change', () => {
    const cam2 = camadaSelecionada(); if (!cam2) return;
    cam2.timbre.transporGrao = chkT.checked;
    atualizarDicaT();
  });

  campo('velocidadePercurso', 'Velocidade do percurso', 1, 1000, 1, t.velocidadePercurso ?? 100, '%');
  campo('aleatoriedadePosicao', 'Aleatoriedade da posição', 0, 100, 1, t.aleatoriedadePosicao ?? 0, '%');
}

// -------- Painel: Envelope --------
function ligarPainelEnvelope() {
  const ids = ['envA','envD','envS','envR','envSustain','envRigor'];
  for (const id of ids) {
    const el = document.getElementById(id); if (!el) continue;
    el.addEventListener('focus', () => { if (camadaSelecionada()) pushUndo(); });
    el.addEventListener('input', () => {
      const cam = camadaSelecionada(); if (!cam) return;
      const env = { ...cam.envelope };
      env.a = +document.getElementById('envA').value;
      env.d = +document.getElementById('envD').value;
      env.s = +document.getElementById('envS').value;
      env.r = +document.getElementById('envR').value;
      env.nivelSustain = +document.getElementById('envSustain').value;
      env.rigor = +document.getElementById('envRigor').value;
      cam.envelope = normalizarEnvelope(env);
      document.getElementById('envA').value = cam.envelope.a.toFixed(1);
      document.getElementById('envD').value = cam.envelope.d.toFixed(1);
      document.getElementById('envS').value = cam.envelope.s.toFixed(1);
      document.getElementById('envR').value = cam.envelope.r.toFixed(1);
      renderizarEnvelope(cam.envelope);
    });
  }
}
function renderizarEnvelope(env) {
  const cv = document.getElementById('envPreview'); if (!cv) return;
  const c = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 280;
  const h = cv.clientHeight || 70;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr); }
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = '#1e1e1e'; c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(255,255,255,0.06)'; c.beginPath();
  for (let i = 1; i < 5; i++) { const x = (w * i) / 5; c.moveTo(x, 0); c.lineTo(x, h); }
  c.stroke();
  const a = Math.max(0, env.a) / 100;
  const d = Math.max(0, env.d) / 100;
  const s = Math.max(0, env.s) / 100;
  const sus = Math.max(0, Math.min(1, env.nivelSustain));
  const xa = a * w, xd = (a + d) * w, xs = (a + d + s) * w, xr = w;
  const yTop = 4, yBase = h - 4;
  const yS = yBase - (yBase - yTop) * sus;
  c.strokeStyle = '#4a7fb5'; c.lineWidth = 1.6;
  c.beginPath();
  c.moveTo(0, yBase); c.lineTo(xa, yTop); c.lineTo(xd, yS); c.lineTo(xs, yS); c.lineTo(xr, yBase);
  c.stroke();
  c.fillStyle = 'rgba(255,255,255,0.5)'; c.font = '9px system-ui'; c.textAlign = 'center';
  c.fillText('A', xa / 2, h - 1);
  c.fillText('D', (xa + xd) / 2, h - 1);
  c.fillText('S', (xd + xs) / 2, h - 1);
  c.fillText('R', (xs + xr) / 2, h - 1);
}

// -------- Painel: Série --------
function ligarPainelSerie() {
  const texto = document.getElementById('cSerieTexto');
  const modo = document.getElementById('cSerieModo');
  const oitava = document.getElementById('cSerieOitava');
  if (texto) {
    texto.addEventListener('focus', () => { if (camadaSelecionada()) pushUndo(); });
    texto.addEventListener('input', () => {
      const cam = camadaSelecionada(); if (!cam) return;
      cam.serieAlturas.texto = texto.value;
      atualizarResumosSerie(cam); marcarRender();
    });
  }
  if (modo) {
    modo.addEventListener('pointerdown', () => { if (camadaSelecionada()) pushUndo(); });
    modo.addEventListener('change', () => {
      const cam = camadaSelecionada(); if (!cam) return;
      cam.serieAlturas.modo = modo.value;
      atualizarOitavaVisivel(modo.value);
      atualizarResumosSerie(cam); marcarRender();
    });
  }
  if (oitava) {
    oitava.addEventListener('pointerdown', () => { if (camadaSelecionada()) pushUndo(); });
    oitava.addEventListener('change', () => {
      const cam = camadaSelecionada(); if (!cam) return;
      cam.serieAlturas.oitava = oitava.value;
      marcarRender();
    });
  }
}
function atualizarOitavaVisivel(modo) {
  const wrap = document.getElementById('serieOitavaWrap');
  if (wrap) wrap.style.display = (modo === 'classe') ? 'flex' : 'none';
}
function atualizarResumosSerie(cam) {
  const el = document.getElementById('cSerieResumo');
  const inp = document.getElementById('cSerieTexto');
  if (!el) return;
  const serie = cam.serieAlturas || { texto: '', modo: 'absoluta' };
  const dens = Math.max(0.1, cam.densidadeRitmica || 1);
  const pulso = cam.pulso > 0 ? cam.pulso : 0.5;
  const passo = pulso / dens;
  const { validos, ignorados, cicloAtaques, cicloSegundos } =
    resumoSerie(serie.texto || '', cam.padraoRitmico || [], passo);
  const tokens = parseSerie(serie.texto || '').valores.slice(0, 8);
  const preview = tokens.map(v => v == null ? '*' : Math.round(v)).join(' ');
  let txt = `${validos} ${validos === 1 ? 'altura' : 'alturas'}`;
  if (validos) txt += `: ${preview}`;
  txt += ` · ciclo de ${cicloAtaques} ataques`;
  if (cicloSegundos != null) txt += ` (${cicloSegundos.toFixed(2)} s)`;
  if (ignorados.length) txt += ` · ${ignorados.length} token(s) ignorado(s): "${ignorados.slice(0, 3).join(' ')}"`;
  el.textContent = txt;
  if (inp) inp.classList.toggle('erro', ignorados.length > 0);
}

// -------- Relações --------
function ligarPainelRelacoes() {
  const btnNova = document.getElementById('btnNovaRelacao');
  if (btnNova) btnNova.onclick = () => {
    if (estado.selecao.length < 2) { setStatus('selecione 2+ camadas (1ª = referência)'); return; }
    pushUndo();
    const r = criarRelacaoDaSelecao();
    if (r) { recalcularAtingidos(); setStatus('relação criada'); atualizarPainel(); }
  };
  const btnRemover = document.getElementById('btnRemoverRelacao');
  if (btnRemover) btnRemover.onclick = () => {
    const sel = estado.relacaoSelecionada;
    if (!sel) { setStatus('nenhuma relação selecionada'); return; }
    pushUndo();
    removerRelacao(sel);
    estado.relacaoSelecionada = null;
    recalcularAtingidos(); atualizarPainel();
    setStatus('relação removida');
  };
}

// -------- Exportação --------
function ligarExportacao() {
  const btn = document.getElementById('btnExportar');
  const dlg = document.getElementById('dlgExportar');
  const btnCancelar = document.getElementById('expCancelar');
  const btnConfirmar = document.getElementById('expConfirmar');
  const progFill = document.getElementById('expProgressoFill');
  const statusEl = document.getElementById('expStatus');
  if (!btn || !dlg) return;
  btn.onclick = () => {
    const cam = camadaSelecionada();
    const selEscopo = document.getElementById('expEscopo');
    if (selEscopo) {
      const optSolo = selEscopo.querySelector('option[value="solo"]');
      if (optSolo) { optSolo.disabled = !cam; if (!cam && selEscopo.value === 'solo') selEscopo.value = 'tudo'; }
    }
    progFill.style.width = '0%'; statusEl.textContent = 'Pronto.';
    dlg.style.display = 'flex';
  };
  btnCancelar.onclick = () => { dlg.style.display = 'none'; };
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.style.display = 'none'; });
  btnConfirmar.onclick = async () => {
    btnConfirmar.disabled = true; btnCancelar.disabled = true;
    statusEl.textContent = 'Renderizando…';
    try {
      const nome = (document.getElementById('expNome').value || 'polifonia').trim();
      const bits = +document.getElementById('expBits').value || 16;
      const sampleRate = +document.getElementById('expSR').value || 44100;
      const escopo = document.getElementById('expEscopo').value;
      const cam = camadaSelecionada();
      const somenteCamadaId = (escopo === 'solo' && cam) ? cam.id : null;
      let aviso = '';
      await exportarWAV(estado.projeto,
        { bits, sampleRate, somenteCamadaId, nome: nome + '.wav', aoAvisar: (txt) => { aviso = txt; } },
        (p) => { progFill.style.width = Math.round(p * 100) + '%'; });
      statusEl.textContent = 'Pronto: ' + nome + '.wav' + (aviso ? ' · ' + aviso : '');
      // Com aviso, o diálogo fica aberto para que ele possa ser lido.
      if (!aviso) setTimeout(() => { dlg.style.display = 'none'; }, 700);
    } catch (e) { statusEl.textContent = 'Erro: ' + e.message; }
    finally { btnConfirmar.disabled = false; btnCancelar.disabled = false; }
  };
}

function onRelacaoSliderChange(relId, campo, valor, elSaida) {
  const rel = estado.projeto.relacoes.find(r => r.id === relId);
  if (!rel) return;
  pushUndo();
  if (valor === null) rel[campo] = null;
  else rel[campo] = Math.max(0, Math.min(100, Math.round(+valor)));
  if (elSaida) elSaida.textContent = rel[campo] == null ? 'inativa' : rel[campo] + '%';
  recalcularAtingidos();
}

// -------- Atualizar painel --------
export function atualizarPainel() {
  const cam = camadaSelecionada();
  const props = document.getElementById('propsCamada');
  const sem = document.getElementById('semCamada');

  const rt = document.getElementById('reverbTempo');
  if (rt) rt.value = estado.projeto.reverbTempo ?? 2.0;
  const vm = document.getElementById('volMaster');
  if (vm) {
    vm.value = estado.projeto.volumeMaster;
    document.getElementById('volMasterVal').textContent = (+estado.projeto.volumeMaster).toFixed(2);
  }
  const dt = document.getElementById('durTotal');
  if (dt) dt.value = estado.projeto.duracaoTotal;

  if (!cam) {
    props.style.display = 'none';
    sem.style.display = 'block';
  } else {
    props.style.display = 'block';
    sem.style.display = 'none';

    document.getElementById('cNome').value = cam.nome;
    document.getElementById('cCor').value = cam.cor;
    document.getElementById('cPadrao').value = cam.padraoPreenchimento;
    document.getElementById('cTipo').value = cam.tipoObjeto;
    document.getElementById('cVol').value = cam.volume;
    document.getElementById('cVolVal').textContent = (+cam.volume).toFixed(2);
    document.getElementById('cPulso').value = cam.pulso;
    document.getElementById('cBpm').value = cam.andamento;
    document.getElementById('cDens').value = cam.densidadeRitmica;
    document.getElementById('cPadraoRitmico').value = cam.padraoRitmico.join(',');
    document.getElementById('cSemente').value = cam.semente;
    document.getElementById('cMudo').checked = cam.mudo;
    document.getElementById('cSolo').checked = cam.solo;

    // Multiplicador / aleatoriedade
    const md = cam.multiplicadorDuracao ?? 1;
    const ad = cam.aleatoriedadeDuracao ?? 0;
    document.getElementById('cMultDur').value = md;
    document.getElementById('cMultDurVal').textContent = md.toFixed(1);
    document.getElementById('cAleatDur').value = ad;
    document.getElementById('cAleatDurVal').textContent = ad + '%';

    // Envelope
    const env = cam.envelope || { a:5, d:10, s:70, r:15, nivelSustain:0.7, rigor:100 };
    document.getElementById('envA').value = env.a.toFixed(1);
    document.getElementById('envD').value = env.d.toFixed(1);
    document.getElementById('envS').value = env.s.toFixed(1);
    document.getElementById('envR').value = env.r.toFixed(1);
    document.getElementById('envSustain').value = env.nivelSustain;
    document.getElementById('envRigor').value = env.rigor;
    renderizarEnvelope(env);

    // Quantização
    const modo = cam.quantizacaoAltura.modo || 'livre';
    const continuo = cam.tipoObjeto === 'continuo';
    const gliss = cam.tipoObjeto === 'gliss';
    // Ritmo e ADSR valem só para Nota. No som contínuo a série fica
    // indisponível; no glissando, toda a quantização. Os dados ficam
    // guardados e voltam se o tipo de objeto mudar.
    document.getElementById('blocoRitmo').style.display = (continuo || gliss) ? 'none' : 'block';
    document.getElementById('blocoEnvelope').style.display = (continuo || gliss) ? 'none' : 'block';
    document.getElementById('blocoAltura').style.display = gliss ? 'none' : 'block';
    document.getElementById('blocoGliss').style.display = gliss ? 'block' : 'none';
    document.getElementById('cNGliss').value = cam.densidadeGliss ?? 24;
    document.getElementById('cQuantSerie').disabled = continuo;
    const modoVisivel = (continuo && modo === 'serie') ? 'livre' : modo;
    document.getElementById('cQuant').value = modoVisivel;
    document.getElementById('conjuntoWrap').style.display = modoVisivel === 'conjunto' ? 'block' : 'none';
    document.getElementById('serieWrap').style.display = modoVisivel === 'serie' ? 'block' : 'none';
    atualizarAvisoQuant(cam);

    if (modo === 'conjunto') {
      const classes = cam.quantizacaoAltura.classes || [];
      const box = document.getElementById('classesBox');
      box.innerHTML = '';
      const nomes = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
      for (let i = 0; i < 12; i++) {
        const l = document.createElement('label');
        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.checked = classes.includes(i);
        inp.addEventListener('change', () => {
          const cam2 = camadaSelecionada(); if (!cam2) return;
          pushUndo();
          const set = new Set(cam2.quantizacaoAltura.classes || []);
          if (inp.checked) set.add(i); else set.delete(i);
          cam2.quantizacaoAltura.classes = [...set].sort((a,b)=>a-b);
        });
        const span = document.createElement('span');
        span.textContent = nomes[i];
        l.appendChild(inp); l.appendChild(span);
        box.appendChild(l);
      }
    }
    if (modo === 'serie') {
      const sa = cam.serieAlturas || { texto:'', modo:'absoluta', oitava:'proxima' };
      document.getElementById('cSerieTexto').value = sa.texto || '';
      document.getElementById('cSerieModo').value = sa.modo || 'absoluta';
      document.getElementById('cSerieOitava').value = sa.oitava || 'proxima';
      atualizarOitavaVisivel(sa.modo || 'absoluta');
      atualizarResumosSerie(cam);
    }

    document.getElementById('cTimbre').value = (cam.timbre && cam.timbre.tipo) || 'sine';
    renderizarTimbre(cam);
    atualizarResumoRitmo();
  }

  atualizarBotaoCamada();
  atualizarLista();
  atualizarListaRelacoes();
  atualizarLegenda();
}

function avisoRender() {
  return motor.avisos.length ? ' · ' + motor.avisos.join(' · ') : '';
}

function atualizarAvisoQuant(cam) {
  const el = document.getElementById('cQuantAviso');
  if (!el) return;
  let txt = '';
  if (cam.tipoObjeto === 'continuo') {
    if (cam.timbre && cam.timbre.tipo === 'ruido') {
      txt = 'O ruído preenche toda a faixa: a quantização não se aplica.';
    } else if (cam.quantizacaoAltura.modo === 'serie') {
      txt = 'Série indisponível no som contínuo: soa como Livre.';
    }
  }
  el.textContent = txt;
  el.style.display = txt ? 'block' : 'none';
}

function atualizarResumoRitmo() {
  const el = document.getElementById('cRitmoResumo'); if (!el) return;
  const cam = camadaSelecionada();
  if (!cam) { el.textContent = ''; return; }
  const dens = Math.max(0.1, cam.densidadeRitmica || 1);
  const pulso = cam.pulso > 0 ? cam.pulso : 0.5;
  const passo = pulso / dens;
  const eventosPorSeg = 1 / passo;
  const nPad = (cam.padraoRitmico && cam.padraoRitmico.length) || 0;
  const ciclo = nPad * passo;
  const md = cam.multiplicadorDuracao ?? 1;
  el.textContent =
    `passo efetivo: ${passo.toFixed(3)} s · ` +
    `${eventosPorSeg.toFixed(2)} eventos/s · ` +
    `padrão de ${nPad} passos = ciclo de ${ciclo.toFixed(2)} s · ` +
    `duração nominal ${(passo * md).toFixed(3)} s`;
}

function atualizarLista() {
  const ul = document.getElementById('listaCamadas');
  ul.innerHTML = '';
  for (const cam of estado.projeto.camadas) {
    const li = document.createElement('li');
    li.className = estaSelecionada(cam.id) ? 'sel' : '';
    li.innerHTML = `<span class="cor" style="background:${cam.cor}"></span><span>${cam.nome}</span>`;
    li.onclick = (e) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        if (estaSelecionada(cam.id)) estado.selecao = estado.selecao.filter(id => id !== cam.id);
        else estado.selecao.push(cam.id);
      } else estado.selecao = [cam.id];
      atualizarPainel(); marcarRender();
    };
    ul.appendChild(li);
  }
}

function atualizarListaRelacoes() {
  const ul = document.getElementById('listaRelacoes');
  const sem = document.getElementById('semRelacoes');
  ul.innerHTML = '';
  if (!estado.projeto.relacoes.length) { sem.style.display = 'block'; return; }
  sem.style.display = 'none';
  const atingidos = (typeof valoresAtingidos === 'function') ? valoresAtingidos() : new Map();
  for (const r of estado.projeto.relacoes) {
    const ref = camadaPorId(r.camadaReferencia);
    const li = document.createElement('li');
    li.className = (estado.relacaoSelecionada === r.id) ? 'sel' : '';
    li.onclick = (e) => {
      if (e.target.closest('input') || e.target.closest('button')) return;
      estado.relacaoSelecionada = (estado.relacaoSelecionada === r.id) ? null : r.id;
      atualizarListaRelacoes();
    };
    const refNome = ref ? ref.nome : '(?)';
    const depsNomes = r.camadasDependentes.map(id => camadaPorId(id))
      .filter(Boolean).map(c => c.nome).join(', ');
    const head = document.createElement('div');
    head.innerHTML = `<span class="tag">ref</span> ${refNome} → ${depsNomes || '(nenhuma)'}`;
    li.appendChild(head);

    const campos = [['ritmo','Ritmo'],['direcao','Direção'],['intervalar','Intervalar']];
    for (const [campo, rotulo] of campos) {
      const linha = document.createElement('div'); linha.className = 'relacaoLinha';
      const lbl = document.createElement('span'); lbl.className = 'relacaoRotulo'; lbl.textContent = rotulo;
      linha.appendChild(lbl);
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = 0; inp.max = 100; inp.step = 1;
      inp.value = r[campo] == null ? 0 : r[campo];
      inp.className = 'relacaoRange'; linha.appendChild(inp);
      const valTxt = document.createElement('span'); valTxt.className = 'relacaoValor';
      valTxt.textContent = r[campo] == null ? 'inativa' : r[campo] + '%';
      linha.appendChild(valTxt);
      const btAtiva = document.createElement('button');
      btAtiva.className = 'relacaoToggle';
      btAtiva.textContent = r[campo] == null ? '—' : '✓';
      btAtiva.onclick = (ev) => {
        ev.stopPropagation(); pushUndo();
        r[campo] = (r[campo] == null) ? 50 : null;
        recalcularAtingidos(); atualizarListaRelacoes();
      };
      linha.appendChild(btAtiva);
      inp.oninput = () => { valTxt.textContent = inp.value + '%'; };
      inp.onchange = () => { onRelacaoSliderChange(r.id, campo, inp.value, valTxt); atualizarListaRelacoes(); };
      li.appendChild(linha);
    }

    const linhaAting = document.createElement('div');
    linhaAting.className = 'relacaoAtingidos';
    const partes = [];
    for (const depId of r.camadasDependentes) {
      const dep = camadaPorId(depId); if (!dep) continue;
      const a = atingidos.get(depId + ':' + r.id) || {};
      const vals = [];
      if (r.ritmo != null) vals.push(`ritmo ${a.ritmo ?? '—'}%`);
      if (r.direcao != null) vals.push(`dir ${a.direcao ?? '—'}%`);
      if (r.intervalar != null) vals.push(`int ${a.intervalar ?? '—'}%`);
      if (a.ajustes) {
        const { oitava, proxima, descartadas } = a.ajustes;
        const aj = [];
        if (oitava) aj.push(`${oitava} por oitava`);
        if (proxima) aj.push(`${proxima} realocada(s)`);
        if (descartadas) aj.push(`${descartadas} descartada(s)`);
        if (aj.length) vals.push('ajustes: ' + aj.join(', '));
      }
      if (vals.length) partes.push(`<b>${dep.nome}</b>: ${vals.join(' · ')}`);
    }
    linhaAting.innerHTML = partes.length ? 'atingido — ' + partes.join(' | ') : '';
    li.appendChild(linhaAting);

    const btRem = document.createElement('button');
    btRem.textContent = 'remover'; btRem.className = 'relacaoRemover';
    btRem.onclick = (ev) => {
      ev.stopPropagation(); pushUndo();
      removerRelacao(r.id);
      if (estado.relacaoSelecionada === r.id) estado.relacaoSelecionada = null;
      recalcularAtingidos(); atualizarListaRelacoes();
    };
    li.appendChild(btRem);
    ul.appendChild(li);
  }
}

function atualizarLegenda() {
  const div = document.getElementById('legendaItens');
  div.innerHTML = '';
  const vistos = new Set();
  for (const cam of estado.projeto.camadas) {
    const chave = cam.tipoObjeto + '|' + cam.padraoPreenchimento + '|' + (cam.timbre && cam.timbre.tipo);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `<span class="amostra" style="background:${cam.cor};opacity:.5"></span>
      <span>${cam.tipoObjeto} + ${(cam.timbre && cam.timbre.tipo) || '?'} · ${cam.padraoPreenchimento}</span>`;
    div.appendChild(item);
  }
}

function setStatus(txt) {
  const el = document.getElementById('statusInfo');
  if (el) el.textContent = txt;
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => { if (el) el.textContent = 'pronto'; }, 2500);
}

export function salvarAgora() { salvarAutosave(); }
export function getCanvas() { return canvas; }