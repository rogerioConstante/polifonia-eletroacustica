// ============================================================
// export.js — Renderização offline + codificação WAV
// ============================================================
//
// Usa OfflineAudioContext + a MESMA função construirGrafo() do
// motor online, garantindo fidelidade entre playback e WAV.
//
// No offline, agendamos tudo de uma vez (janelaAte = Infinity),
// incluindo as automações de dinâmica, panorama e reverb — que
// antes ficavam de fora.

import { calcularEventos, construirGrafo, prepararContinuos } from './audio.js';

export async function renderizarOffline(projeto, opcoes = {}, progresso = null) {
  const sampleRate = opcoes.sampleRate || 44100;
  const duracaoExtra = opcoes.duracaoExtra != null ? opcoes.duracaoExtra : 2.0;
  const dur = Math.max(0.5, projeto.duracaoTotal + duracaoExtra);

  const { eventos } = calcularEventos(projeto, opcoes.somenteCamadaId || null);
  const omitidos = await prepararContinuos(eventos, sampleRate, (n, total) => {
    if (progresso && total) progresso(0.02 + 0.03 * n / total);
  });
  if (omitidos) console.warn(`Som contínuo: ${omitidos} parciais fracos omitidos por custo.`);

  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(2, Math.ceil(dur * sampleRate), sampleRate);

  // Um único grafo, com TODOS os eventos e TODAS as automações.
  construirGrafo(ctx, projeto, eventos, {
    somenteCamadaId: opcoes.somenteCamadaId || null,
    inicioCtx: 0,
    deTempo: 0,
    janelaAte: Infinity,
  });

  if (progresso) progresso(0.05);
  const buffer = await ctx.startRendering();
  if (progresso) progresso(1.0);
  return buffer;
}

// ------------------------------------------------------------
// Codificação WAV (PCM) — inalterada
// ------------------------------------------------------------
export function codificarWAV(buffer, bits = 16) {
  const canais = Math.min(2, buffer.numberOfChannels);
  const nFrames = buffer.length;
  const sr = buffer.sampleRate;
  const bytesPorAmostra = bits / 8;
  const blockAlign = canais * bytesPorAmostra;
  const byteRate = sr * blockAlign;
  const dataSize = nFrames * blockAlign;
  const tamanhoTotal = 44 + dataSize;

  const ab = new ArrayBuffer(tamanhoTotal);
  const dv = new DataView(ab);

  let p = 0;
  const writeStr = s => { for (let i = 0; i < s.length; i++) dv.setUint8(p++, s.charCodeAt(i)); };
  const writeU32 = v => { dv.setUint32(p, v, true); p += 4; };
  const writeU16 = v => { dv.setUint16(p, v, true); p += 2; };
  const writeU24 = v => { dv.setUint8(p++, v & 0xFF); dv.setUint8(p++, (v >> 8) & 0xFF); dv.setUint8(p++, (v >> 16) & 0xFF); };

  writeStr('RIFF');
  writeU32(36 + dataSize);
  writeStr('WAVE');
  writeStr('fmt ');
  writeU32(16);
  writeU16(1);
  writeU16(canais);
  writeU32(sr);
  writeU32(byteRate);
  writeU16(blockAlign);
  writeU16(bits);
  writeStr('data');
  writeU32(dataSize);

  const canaisDados = [];
  for (let c = 0; c < canais; c++) canaisDados.push(buffer.getChannelData(c));

  const maxVal = bits === 16 ? 32767 : 8388607;
  const minVal = bits === 16 ? -32768 : -8388608;

  for (let i = 0; i < nFrames; i++) {
    for (let c = 0; c < canais; c++) {
      let s = canaisDados[c][i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      const v = Math.round(s * maxVal);
      const vv = Math.max(minVal, Math.min(maxVal, v));
      if (bits === 16) {
        dv.setInt16(p, vv, true); p += 2;
      } else {
        const u = vv < 0 ? vv + 0x1000000 : vv;
        writeU24(u);
      }
    }
  }

  return new Blob([ab], { type: 'audio/wav' });
}

export function baixarBlob(blob, nome) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportarWAV(projeto, opcoes = {}, onProgresso = null) {
  const buffer = await renderizarOffline(projeto, opcoes, onProgresso);
  const blob = codificarWAV(buffer, opcoes.bits || 16);
  const nome = opcoes.nome || ('polifonia-' + timestamp() + '.wav');
  baixarBlob(blob, nome);
  return blob;
}

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}