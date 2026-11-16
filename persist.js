// ============================================================
// persist.js — Salvar/abrir JSON e autosave em localStorage
// Polifonia Eletroacústica — Copyright (C) 2026 Rogério Tavares Constante
// Licença GPL-3.0 ou posterior (ver LICENSE).
// ============================================================

import { estado, criarProjeto, migrarProjeto } from './model.js';

const CHAVE_AUTOSAVE = 'polifonia_autosave_v2';
const CHAVE_BACKUP   = 'polifonia_autosave_backup_v2';
const INTERVALO_AUTOSAVE = 2000; // ms

let timerAutosave = null;

/** Serializa o projeto atual como JSON formatado. */
export function serializarProjeto() {
  return JSON.stringify(estado.projeto, null, 2);
}

/** Baixa o projeto como arquivo .json. */
export function baixarProjeto() {
  const json = serializarProjeto();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'projeto-polifonia-' + timestamp() + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Abre o seletor de arquivo e carrega o JSON escolhido. */
export function abrirProjetoDialogo() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) { resolve(false); return; }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const raw = JSON.parse(reader.result);
          const projeto = migrarProjeto(raw);
          aplicarProjeto(projeto);
          resolve(true);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(f);
    };
    input.click();
  });
}

/** Aplica um projeto carregado ao estado global. */
export function aplicarProjeto(projeto) {
  estado.projeto = projeto;
  estado.selecao = [];
  estado.desenhando = null;
  estado._undo.length = 0;
  estado._redo.length = 0;
  // reseta visualização para caber o projeto
  estado.scrollX = 0;
  // autosave imediato
  salvarAutosave();
}

/** Formata timestamp YYYYMMDD-HHMMSS. */
function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ------------------------------------------------------------
// Autosave em localStorage
// ------------------------------------------------------------

/** Salva o estado atual em localStorage (com backup do anterior). */
export function salvarAutosave() {
  try {
    const anterior = localStorage.getItem(CHAVE_AUTOSAVE);
    if (anterior) localStorage.setItem(CHAVE_BACKUP, anterior);
    localStorage.setItem(CHAVE_AUTOSAVE, JSON.stringify(estado.projeto));
  } catch (e) {
    // localStorage cheio ou indisponível; ignora silenciosamente
  }
}

/** Lê o autosave se existir, migra e aplica. Retorna true se carregou. */
export function restaurarAutosave() {
  try {
    const raw = localStorage.getItem(CHAVE_AUTOSAVE);
    if (!raw) return false;
    const projeto = migrarProjeto(JSON.parse(raw));
    if (!projeto.camadas.length && !projeto.relacoes.length) return false;
    estado.projeto = projeto;
    estado.selecao = [];
    return true;
  } catch (e) {
    return false;
  }
}

/** Limpa o autosave (usado por "Novo projeto"). */
export function limparAutosave() {
  try {
    localStorage.removeItem(CHAVE_AUTOSAVE);
    localStorage.removeItem(CHAVE_BACKUP);
  } catch (_) {}
}

/** Inicia o autosave periódico (a cada INTERVALO_AUTOSAVE ms). */
export function iniciarAutosave() {
  if (timerAutosave) clearInterval(timerAutosave);
  timerAutosave = setInterval(salvarAutosave, INTERVALO_AUTOSAVE);
}

/** Para o autosave (usado ao fechar a aba, opcional). */
export function pararAutosave() {
  if (timerAutosave) clearInterval(timerAutosave);
  timerAutosave = null;
}

/** Cria um projeto novo (vazio), limpando autosave e estado. */
export function novoProjeto() {
  aplicarProjeto(criarProjeto());
  limparAutosave();
}