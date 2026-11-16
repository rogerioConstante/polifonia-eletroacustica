// ============================================================
// main.js — Ponto de entrada; liga UI e inicia render
// Polifonia Eletroacústica — Copyright (C) 2026 Rogério Tavares Constante
// Licença GPL-3.0 ou posterior (ver LICENSE).
// ============================================================

import { estado } from './model.js';
import { initUI } from './ui.js';
import { iniciarLoop } from './view.js';

const canvas = document.getElementById('grafico');
initUI(canvas);
iniciarLoop();

// Salva ao fechar a aba (best-effort).
window.addEventListener('beforeunload', () => {
  try { localStorage.setItem('polifonia_autosave_v2', JSON.stringify(estado.projeto)); }
  catch (_) {}
});