// ============================================================
// serie.js — Série de alturas (item 5). Módulo puro.
// Polifonia Eletroacústica — Copyright (C) 2026 Rogério Tavares Constante
// Licença GPL-3.0 ou posterior (ver LICENSE).
// ============================================================
//
// Sem imports de view/ui. Convenção de oitavas igual à do
// view.nomeNota: C3 = dó central = MIDI 60 (científica menos 1).
//
// Tokens aceitos:
//   - Notas: C3, C#3, Bb2, Fb4, etc. (case-insensitive).
//     Solfejo: do re mi fa sol la si, com #/b, sem acentos
//     (mib3, fa#4, sola? não — si, sol, la, do, re, mi, fa).
//   - Número MIDI: 60, 60.5 (quarto de tom).
//   - Frequência: 440hz.
//   - `*`: altura livre (usa o sorteio normal da camada).
// ============================================================

// Nomes de classe (0 = C).
const NOMES_CLASSE = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// Solfejo (case-insensitive, sem acentos). Alguns sinônimos úteis.
const SOLFEJO = {
  'do': 0, 'dó': 0,
  'do#': 1, 'dó#': 1, 'dób': 0, // aceitar dób => 0 (compatibilidade)
  're': 2, 'ré': 2,
  're#': 3, 'ré#': 3,
  'reb': 1, 'réb': 1,
  'mi': 4,
  'mi#': 5,
  'mib': 3,
  'fa': 5,
  'fa#': 6,
  'fab': 4,
  'sol': 7,
  'sol#': 8,
  'solb': 6,
  'la': 9, 'lá': 9,
  'la#': 10, 'lá#': 10,
  'lab': 8, 'láb': 8,
  'si': 11,
  'si#': 0,
  'sib': 10,
};

function normalizar(s) {
  // minúsculo, sem acentos
  return s.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Converte nome de nota em MIDI. Aceita `C3`, `C#3`, `Bb2`,
 * `do3`, `mib4`, `sol#5`, etc. Devolve `null` se não reconhecer.
 */
export function nomeNotaParaMidi(nome) {
  if (typeof nome !== 'string') return null;
  const s = nome.trim();
  if (!s) return null;

  // tenta nome de nota ocidental: [A-Ga-g] [#b]? -?\d+
  let m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(s);
  if (m) {
    const letra = m[1].toUpperCase();
    const acc = m[2];
    const oitava = parseInt(m[3], 10);
    const idx = NOMES_CLASSE.indexOf(letra) + (acc === '#' ? 1 : 0) + (acc === 'b' ? -1 : 0);
    if (idx < -1 || idx > 12) return null;
    const classe = ((idx % 12) + 12) % 12;
    // Científica menos 1: C3 = 60. Portanto MIDI = (oitava + 2) * 12 + classe.
    return (oitava + 2) * 12 + classe;
  }

  // tenta solfejo: <nome>[#b]? -?\d+
  m = /^([a-z#]+)(-?\d+)$/.exec(normalizar(s).replace(/\s+/g, ''));
  if (m) {
    const nomeSol = m[1];
    const oitava = parseInt(m[2], 10);
    if (!(nomeSol in SOLFEJO)) return null;
    const classe = SOLFEJO[nomeSol];
    return (oitava + 2) * 12 + classe;
  }

  return null;
}

/** MIDI → Hz (A4 = 69 = 440 Hz). */
export function midiParaHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
/** Hz → MIDI (fracionário). */
export function hzParaMidi(f) { return 69 + 12 * Math.log2(f / 440); }

/**
 * Parse de uma série de alturas.
 * Retorna { valores: (number|null)[], ignorados: string[] }.
 * `null` representa `*` (altura livre).
 */
export function parseSerie(texto) {
  const valores = [];
  const ignorados = [];
  if (typeof texto !== 'string' || !texto.trim()) return { valores, ignorados };

  // separadores: vírgula ou espaço
  const tokens = texto.split(/[,\s]+/).filter(t => t.length > 0);
  for (const tok of tokens) {
    const s = tok.trim();
    if (!s) continue;

    if (s === '*') { valores.push(null); continue; }

    // Hz: termina com "hz"
    const mHz = /^([0-9]*\.?[0-9]+)hz$/i.exec(s);
    if (mHz) {
      const f = parseFloat(mHz[1]);
      if (f > 0) { valores.push(hzParaMidi(f)); continue; }
    }

    // Número MIDI (possivelmente fracionário)
    if (/^-?[0-9]+(\.[0-9]+)?$/.test(s)) {
      const m = parseFloat(s);
      if (isFinite(m)) { valores.push(m); continue; }
    }

    // Nome de nota
    const midi = nomeNotaParaMidi(s);
    if (midi != null) { valores.push(midi); continue; }

    ignorados.push(tok);
  }
  return { valores, ignorados };
}

/**
 * Resumo para exibição no painel.
 * Retorna { validos, ignorados, cicloAtaques, cicloSegundos }.
 * `passo` em segundos; `padraoRitmico` como lista de 0/1.
 */
export function resumoSerie(texto, padraoRitmico, passo) {
  const { valores, ignorados } = parseSerie(texto);
  const validos = valores.length;
  const nAtaques = (padraoRitmico || []).filter(x => x === 1).length;
  const M = (padraoRitmico || []).length || 1;
  let cicloAtaques = validos;
  let cicloSegundos = null;

  if (validos > 0 && nAtaques > 0) {
    // lcm(a, N) onde a = ataques por ciclo do padrão, N = tamanho da série
    cicloAtaques = Math.floor((nAtaques * validos) / mdc(nAtaques, validos));
    // ciclo em segundos = (cicloAtaques / nAtaques) * M * passo
    cicloSegundos = (cicloAtaques / nAtaques) * M * passo;
  }
  return { validos, ignorados, cicloAtaques, cicloSegundos };
}

function mdc(a, b) { while (b) { const t = b; b = a % b; a = t; } return a; }