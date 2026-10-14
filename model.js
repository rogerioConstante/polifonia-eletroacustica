// ============================================================
// model.js — Estado do projeto, camadas, relações e histórico
// ============================================================

/** Gera id curto único. */
export function uid() {
  return Math.random().toString(36).slice(2, 9);
}

/** Cor HSL -> hex, para gerar cores agradáveis para novas camadas. */
export function hslParaHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = x => Math.round(255 * x).toString(16).padStart(2, '0');
  return '#' + to(f(0)) + to(f(8)) + to(f(4));
}

export function corAleatoria() {
  const h = Math.floor(Math.random() * 360);
  return hslParaHex(h, 60, 55);
}

/** Timbre padrão por tipo de objeto sonoro. */
export function timbrePadrao(tipo) {
  switch (tipo) {
    case 'sine':
      return { tipo: 'sine' };
    case 'aditiva':
      return { tipo: 'aditiva', nHarm: 6, inclinacao: 1.5 };
    case 'fm':
      return { tipo: 'fm', razao: 2, indice: 3 };
    case 'ruido':
      return { tipo: 'ruido', q: 4 };
    default:
      return { tipo: 'sine' };
  }
}

/** Envelope ADSR padrão. Valores em % da duração do evento (a+d+s+r = 100). */
export function envelopePadrao() {
  return {
    a: 5,             // ataque (% da duração)
    d: 10,            // decaimento (% da duração)
    s: 70,            // sustentação (% da duração)
    r: 15,            // release (% da duração)
    nivelSustain: 0.7,// 0..1: nível da etapa S em relação ao pico
    rigor: 100,       // 0..100: fidelidade ao envelope definido
  };
}

/**
 * Normaliza um envelope: a+d+s+r = 100 (garantido por construção),
 * valores ≥ 0, nivelSustain e rigor em faixa.
 */
export function normalizarEnvelope(env) {
  const base = envelopePadrao();
  const e = { ...base, ...(env || {}) };
  // garante não-negativos
  e.a = Math.max(0, +e.a || 0);
  e.d = Math.max(0, +e.d || 0);
  e.s = Math.max(0, +e.s || 0);
  e.r = Math.max(0, +e.r || 0);
  const soma = e.a + e.d + e.s + e.r;
  if (soma <= 0) return base;
  const k = 100 / soma;
  e.a *= k; e.d *= k; e.s *= k; e.r *= k;
  // arredonda para 1 decimal mantendo soma 100
  e.a = Math.round(e.a * 10) / 10;
  e.d = Math.round(e.d * 10) / 10;
  e.s = Math.round(e.s * 10) / 10;
  e.r = Math.round((100 - e.a - e.d - e.s) * 10) / 10;
  e.nivelSustain = Math.min(1, Math.max(0, +e.nivelSustain ?? 0.7));
  e.rigor = Math.min(100, Math.max(0, +e.rigor ?? 100));
  return e;
}

/** Cria uma camada com valores padrão. */
export function criarCamada(vertices = []) {
  return {
    id: uid(),
    nome: 'Camada ' + Math.floor(Math.random() * 1000),
    vertices,                        // [{t, f}] em segundos e Hz
    cor: corAleatoria(),
    padraoPreenchimento: 'hachura',  // hachura | pontos | linhas | xadrez
    tipoObjeto: 'nota',              // nota | gliss | granular | ruido
    timbre: timbrePadrao('sine'),
    envelope: envelopePadrao(),      // ADSR por evento (Etapa 7)
    volume: 0.8,
    andamento: 120,                  // BPM individual da camada
    pulso: 0.5,                      // segundos por pulso (uso sonoro)
    densidadeRitmica: 1,             // eventos por pulso
    padraoRitmico: [1, 0, 1, 1],     // 1 = ataque, 0 = pausa (cíclico)
    semente: Math.floor(Math.random() * 100000),
    // quantizacaoAltura:
    //   { modo: 'livre' }
    //   { modo: 'semitons' }
    //   { modo: 'conjunto', classes: [0,2,4,5,7,9,11] }  // 0=C
    quantizacaoAltura: { modo: 'livre' },
    // automacoes: cada curva é uma lista de {t, v} com v em 0..1
    automacoes: { dinamica: [], panorama: [], reverb: [] },
    mudo: false,
    solo: false,
    // origem dos slots (informativo por ora; sem efeito sonoro):
    //   'poligono' = ataques começam no início do polígono (padrão atual)
    //   'zero'     = ataques começam em t=0 absoluto
    origemSlots: 'poligono',
  };
}

/** Cria um ponto de automação. */
export function pontoAutomacao(t, v, curva = 'linear') {
  return { t: Math.max(0, t), v: Math.min(1, Math.max(0, v)), curva };
}

/** Valor padrão (sem pontos) de cada automação. */
export const AUTOMACAO_PADRAO = {
  dinamica: 1.0,
  panorama: 0.5,   // 0.5 = centro
  reverb:   0.0,
};

/** Avalia uma automação em t; retorna valor normalizado 0..1. */
export function valorAutomacao(cam, tipo, t) {
  const pts = (cam.automacoes && cam.automacoes[tipo]) || [];
  if (!pts.length) return AUTOMACAO_PADRAO[tipo];
  const arr = pts.slice().sort((a, b) => a.t - b.t);
  if (t <= arr[0].t) return arr[0].v;
  if (t >= arr[arr.length - 1].t) return arr[arr.length - 1].v;
  let i = 0;
  for (; i < arr.length - 1; i++) {
    if (t >= arr[i].t && t <= arr[i + 1].t) break;
  }
  const a = arr[i], b = arr[i + 1];
  const u = (t - a.t) / Math.max(1e-9, b.t - a.t);
  let k;
  if (a.curva === 'suave') k = 0.5 - 0.5 * Math.cos(Math.PI * u);
  else k = u;
  return a.v + (b.v - a.v) * k;
}

/** Cria uma relação entre camadas. */
export function criarRelacao(camadaReferencia, camadasDependentes) {
  return {
    id: uid(),
    camadaReferencia,
    camadasDependentes,
    ritmo: null,
    direcao: null,
    intervalar: null,
    parametros: {
      compararPorClasse: false,
      maxTentativas: 8,
    },
  };
}

/** Cria o projeto vazio. */
export function criarProjeto() {
  return {
    versao: 3,
    volumeMaster: 0.8,
    duracaoTotal: 30,
    reverbTempo: 2.0,
    camadas: [],
    relacoes: [],
  };
}

/** Estado global mutável + pilha de undo/redo. */
export const estado = {
  projeto: criarProjeto(),
  selecao: [],
  ferramenta: 'select',   // select | draw
  desenhando: null,
  relacaoSelecionada: null,
  // Visualização
  scrollX: 0,
  zoomX: 80,
  zoomY: 90,
  fMin: 55,
  oitavasVisiveis: 4,
  snapAltura: false,
  // Histórico
  _undo: [],
  _redo: [],
};

export function pushUndo() {
  estado._undo.push(JSON.stringify(estado.projeto));
  if (estado._undo.length > 100) estado._undo.shift();
  estado._redo.length = 0;
}

export function undo() {
  if (!estado._undo.length) return false;
  estado._redo.push(JSON.stringify(estado.projeto));
  estado.projeto = JSON.parse(estado._undo.pop());
  limparSelecaoInvalida();
  return true;
}

export function redo() {
  if (!estado._redo.length) return false;
  estado._undo.push(JSON.stringify(estado.projeto));
  estado.projeto = JSON.parse(estado._redo.pop());
  limparSelecaoInvalida();
  return true;
}

function limparSelecaoInvalida() {
  const ids = new Set(estado.projeto.camadas.map(c => c.id));
  estado.selecao = estado.selecao.filter(id => ids.has(id));
}

export function camadaPorId(id) {
  return estado.projeto.camadas.find(c => c.id === id);
}
export function camadaSelecionada() {
  if (estado.selecao.length === 0) return null;
  return camadaPorId(estado.selecao[0]);
}
export function estaSelecionada(id) {
  return estado.selecao.includes(id);
}

/**
 * Migração de projetos antigos. Aceita versões 1 e 2 e produz
 * a versão 3, sem perder informação existente.
 */
export function migrarProjeto(p) {
  if (!p || typeof p !== 'object') return criarProjeto();
  const novo = criarProjeto();
  novo.volumeMaster = typeof p.volumeMaster === 'number' ? p.volumeMaster : 0.8;
  novo.duracaoTotal = typeof p.duracaoTotal === 'number' ? p.duracaoTotal : 30;
  novo.reverbTempo  = typeof p.reverbTempo  === 'number' ? p.reverbTempo  : 2.0;
  novo.camadas = Array.isArray(p.camadas) ? p.camadas.map(migrarCamada) : [];
  novo.relacoes = Array.isArray(p.relacoes) ? p.relacoes : [];
  return novo;
}

function migrarCamada(c) {
  const base = criarCamada(Array.isArray(c.vertices) ? c.vertices : []);
  if (c.id) base.id = c.id;
  if (c.nome) base.nome = c.nome;
  // Campos simples copiados diretamente, se existirem.
  for (const k of ['cor','padraoPreenchimento','tipoObjeto','volume','andamento',
                   'pulso','densidadeRitmica','padraoRitmico','semente',
                   'mudo','solo','origemSlots']) {
    if (c[k] !== undefined) base[k] = c[k];
  }
  // timbre (objeto)
  if (c.timbre && typeof c.timbre === 'object') base.timbre = { ...base.timbre, ...c.timbre };
  // envelope (objeto novo; normaliza)
  if (c.envelope && typeof c.envelope === 'object') {
    base.envelope = normalizarEnvelope({ ...base.envelope, ...c.envelope });
  }
  // quantizacaoAltura: aceita string antiga ou objeto novo
  if (typeof c.quantizacaoAltura === 'string') {
    base.quantizacaoAltura = { modo: c.quantizacaoAltura };
  } else if (c.quantizacaoAltura && typeof c.quantizacaoAltura === 'object') {
    base.quantizacaoAltura = { ...base.quantizacaoAltura, ...c.quantizacaoAltura };
  }
  // automacoes
  if (c.automacoes && typeof c.automacoes === 'object') {
    base.automacoes = {
      dinamica: Array.isArray(c.automacoes.dinamica) ? c.automacoes.dinamica : [],
      panorama: Array.isArray(c.automacoes.panorama) ? c.automacoes.panorama : [],
      reverb:   Array.isArray(c.automacoes.reverb)   ? c.automacoes.reverb   : [],
    };
  }
  return base;
}

/** Retorna a relação que envolve esta camada como dependente, se houver. */
export function relacaoDaDependente(id) {
  return estado.projeto.relacoes.find(r => r.camadasDependentes.includes(id)) || null;
}

/** Remove uma relação pelo id. */
export function removerRelacao(id) {
  estado.projeto.relacoes = estado.projeto.relacoes.filter(r => r.id !== id);
}

/** Cria uma relação a partir da seleção atual (1ª = referência, resto = dependentes). */
export function criarRelacaoDaSelecao() {
  if (estado.selecao.length < 2) return null;
  const [ref, ...deps] = estado.selecao;
  const r = criarRelacao(ref, deps.slice());
  estado.projeto.relacoes.push(r);
  return r;
}