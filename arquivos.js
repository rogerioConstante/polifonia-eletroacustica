// ============================================================
// arquivos.js — Arquivos de áudio da pasta audios/
// Polifonia Eletroacústica — Copyright (C) 2026 Rogério Tavares Constante
// Licença GPL-3.0 ou posterior (ver LICENSE).
// ============================================================
//
// O navegador não lê pastas do disco: a lista vem da página de
// diretório gerada pelo servidor local (iniciar-servidor.sh). Onde não
// há listagem de pasta (por exemplo, no GitHub Pages), usa-se a lista
// fixa audios/lista.json.

export const PASTA_AUDIOS = 'audios/';
const EXTENSOES = /\.(wav|wave|flac|mp3|ogg|oga|opus|m4a|aac)$/i;

export function urlArquivo(nome) {
  return PASTA_AUDIOS + encodeURIComponent(nome);
}

/** Nomes dos arquivos de áudio da pasta, em ordem alfabética. */
export async function listarArquivos() {
  let nomes = [];
  try {
    const resp = await fetch(PASTA_AUDIOS, { cache: 'no-store' });
    if (resp.ok) {
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      for (const a of doc.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href');
        if (href.includes('/') || href.startsWith('?')) continue;
        const nome = decodeURIComponent(href);
        if (EXTENSOES.test(nome)) nomes.push(nome);
      }
    }
  } catch (_) { /* sem listagem de pasta: tenta a lista fixa */ }
  if (!nomes.length) nomes = await listarArquivosFixos();
  return nomes.sort((x, y) => x.localeCompare(y, 'pt-BR'));
}

/** Lista fixa (audios/lista.json), para servidores sem listagem de pasta. */
async function listarArquivosFixos() {
  try {
    const resp = await fetch(PASTA_AUDIOS + 'lista.json', { cache: 'no-store' });
    if (!resp.ok) return [];
    const lista = await resp.json();
    return Array.isArray(lista) ? lista.filter(n => typeof n === 'string' && EXTENSOES.test(n)) : [];
  } catch (_) {
    return [];
  }
}

/** Identifica o conteúdo do arquivo sem baixá-lo. */
export async function versaoArquivo(nome) {
  const resp = await fetch(urlArquivo(nome), { method: 'HEAD', cache: 'no-store' });
  if (!resp.ok) throw new Error(`arquivo não encontrado: ${nome}`);
  return `${resp.headers.get('last-modified')}|${resp.headers.get('content-length')}`;
}

/** Decodifica para mono, na taxa de amostragem pedida. */
export async function decodificarArquivo(nome, sampleRate) {
  const resp = await fetch(urlArquivo(nome), { cache: 'no-store' });
  if (!resp.ok) throw new Error(`arquivo não encontrado: ${nome}`);
  const bytes = await resp.arrayBuffer();
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(1, 1, sampleRate);
  let buf;
  try {
    buf = await ctx.decodeAudioData(bytes);
  } catch (_) {
    throw new Error(`formato não reconhecido: ${nome}`);
  }
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const canal = buf.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += canal[i] / buf.numberOfChannels;
  }
  return mono;
}
