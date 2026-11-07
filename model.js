// ============================================================
// model.js — Estado do projeto, camadas, relações e histórico
// ============================================================

export function uid() {
  return Math.random().toString(36).slice(2, 9);
}

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

/** Tipos de objeto válidos (natureza temporal do polígono). */
export const TIPOS_OBJETO = ['nota', 'gliss', 'continuo'];

/** Tipos de síntese/timbre válidos. */
export const TIPOS_TIMBRE = ['sine', 'aditiva', 'fm', 'granular', 'ruido'];

/** Timbre padrão por tipo de síntese. */
export function timbrePadrao(tipo) {
  switch (tipo) {
    case 'sine':     return { tipo: 'sine' };
    case 'aditiva':  return { tipo: 'aditiva', nHarm: 6, inclinacao: 1.5 };
    case 'fm':       return { tipo: 'fm', razao: 2, indice: 3 };
    case 'granular':
      return {
        tipo: 'granular',
        duracaoGraoMs: 30,
        suavizacaoEnv: 50,
        aleatoriedadeGrao: 0,
        sobreposicao: 10,
        // Som contínuo: grãos/s por oitava. Glissando: grãos/s por trajetória.
        densidadeGraos: 100,
        // Material do grão: 'senoide' | 'arquivo' (nome em audios/).
        material: 'senoide',
        arquivo: '',
        // Leva a frequência dominante do grão à altura-alvo. Desligado,
        // só a máscara do polígono delimita as frequências.
        transporGrao: true,
        // Percurso do cursor: 100% = velocidade original do arquivo.
        velocidadePercurso: 100,
        // Desvio da posição: 0% = linear; 100% = qualquer ponto do arquivo.
        aleatoriedadePosicao: 0,
      };
    case 'ruido':    return { tipo: 'ruido', q: 4, larguraBandaSt: 1 };
    default:         return { tipo: 'sine' };
  }
}

export function envelopePadrao() {
  return { a: 5, d: 10, s: 70, r: 15, nivelSustain: 0.7, rigor: 100 };
}

export function normalizarEnvelope(env) {
  const base = envelopePadrao();
  const e = { ...base, ...(env || {}) };
  e.a = Math.max(0, +e.a || 0);
  e.d = Math.max(0, +e.d || 0);
  e.s = Math.max(0, +e.s || 0);
  e.r = Math.max(0, +e.r || 0);
  const soma = e.a + e.d + e.s + e.r;
  if (soma <= 0) return base;
  const k = 100 / soma;
  e.a *= k; e.d *= k; e.s *= k; e.r *= k;
  e.a = Math.round(e.a * 10) / 10;
  e.d = Math.round(e.d * 10) / 10;
  e.s = Math.round(e.s * 10) / 10;
  e.r = Math.round((100 - e.a - e.d - e.s) * 10) / 10;
  e.nivelSustain = Math.min(1, Math.max(0, +e.nivelSustain ?? 0.7));
  e.rigor = Math.min(100, Math.max(0, +e.rigor ?? 100));
  return e;
}

export function serieAlturasPadrao() {
  return { ativa: false, texto: '', modo: 'absoluta', oitava: 'proxima' };
}

export function criarCamada(vertices = []) {
  return {
    id: uid(),
    nome: 'Camada ' + Math.floor(Math.random() * 1000),
    vertices,
    cor: corAleatoria(),
    padraoPreenchimento: 'hachura',
    // tipoObjeto: 'nota' | 'gliss' | 'continuo'
    tipoObjeto: 'nota',
    timbre: timbrePadrao('sine'),
    envelope: envelopePadrao(),
    volume: 0.8,
    andamento: 120,
    pulso: 0.5,
    densidadeRitmica: 1,
    // Duração dos eventos, em múltiplos do passo rítmico.
    // multiplicadorDuracao: 0.1..10.0
    // aleatoriedadeDuracao: 0..100 (%)
    multiplicadorDuracao: 1.0,
    aleatoriedadeDuracao: 0,
    // Glissando: quantidade de trajetórias simultâneas (2..100).
    densidadeGliss: 24,
    padraoRitmico: [1, 0, 1, 1],
    semente: Math.floor(Math.random() * 100000),
    quantizacaoAltura: { modo: 'livre' },  // 'livre' | 'semitons' | 'conjunto' | 'serie'
    serieAlturas: serieAlturasPadrao(),
    automacoes: { dinamica: [], panorama: [], reverb: [] },
    mudo: false,
    solo: false,
    origemSlots: 'poligono',
  };
}

export function pontoAutomacao(t, v, curva = 'linear') {
  return { t: Math.max(0, t), v: Math.min(1, Math.max(0, v)), curva };
}

export const AUTOMACAO_PADRAO = {
  dinamica: 1.0,
  panorama: 0.5,
  reverb:   0.0,
};

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

export function extensaoTemporal(cam) {
  if (!cam || !Array.isArray(cam.vertices) || cam.vertices.length < 3) return null;
  let t0 = Infinity, t1 = -Infinity;
  for (const v of cam.vertices) {
    if (v.t < t0) t0 = v.t;
    if (v.t > t1) t1 = v.t;
  }
  return { t0: Math.max(0, t0), t1: Math.max(0, t1) };
}

export function criarRelacao(camadaReferencia, camadasDependentes) {
  return {
    id: uid(),
    camadaReferencia,
    camadasDependentes,
    ritmo: null,
    direcao: null,
    intervalar: null,
    parametros: { compararPorClasse: false, maxTentativas: 8 },
  };
}

export function criarProjeto() {
  return {
    versao: 5,
    volumeMaster: 0.8,
    duracaoTotal: 30,
    reverbTempo: 2.0,
    camadas: [],
    relacoes: [],
  };
}

export const estado = {
  projeto: criarProjeto(),
  selecao: [],
  ferramenta: 'select',
  desenhando: null,
  relacaoSelecionada: null,
  scrollX: 0,
  zoomX: 80,
  zoomY: 90,
  fMin: 55,
  oitavasVisiveis: 4,
  snapAltura: false,
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
  for (const k of ['cor','padraoPreenchimento','volume','andamento',
                   'pulso','densidadeRitmica','padraoRitmico','semente',
                   'mudo','solo','origemSlots',
                   'multiplicadorDuracao','aleatoriedadeDuracao',
                   'densidadeGliss']) {
    if (c[k] !== undefined) base[k] = c[k];
  }

  // tipoObjeto: migra legado 'granular'/'ruido' (que eram tipos de
  // objeto) para tipo de objeto + tipo de síntese.
  const tipoAntigo = c.tipoObjeto;
  if (tipoAntigo === 'granular') {
    base.tipoObjeto = 'nota';
    base.timbre = { ...timbrePadrao('granular'),
                    ...(c.timbre && typeof c.timbre === 'object' ? c.timbre : {}) };
    base.timbre.tipo = 'granular';
  } else if (tipoAntigo === 'ruido') {
    base.tipoObjeto = 'nota';
    base.timbre = { ...timbrePadrao('ruido'),
                    ...(c.timbre && typeof c.timbre === 'object' ? c.timbre : {}) };
    base.timbre.tipo = 'ruido';
  } else if (tipoAntigo === 'nota' || tipoAntigo === 'gliss' || tipoAntigo === 'continuo') {
    base.tipoObjeto = tipoAntigo;
  } else {
    base.tipoObjeto = 'nota';
  }

  // timbre: mescla e valida.
  if (c.timbre && typeof c.timbre === 'object') {
    const t = c.timbre.tipo || 'sine';
    if (TIPOS_TIMBRE.includes(t)) {
      base.timbre = { ...timbrePadrao(t), ...c.timbre };
    } else {
      base.timbre = { ...base.timbre, ...c.timbre };
    }
  }

  if (c.envelope && typeof c.envelope === 'object') {
    base.envelope = normalizarEnvelope({ ...base.envelope, ...c.envelope });
  }
  if (typeof c.quantizacaoAltura === 'string') {
    base.quantizacaoAltura = { modo: c.quantizacaoAltura };
  } else if (c.quantizacaoAltura && typeof c.quantizacaoAltura === 'object') {
    base.quantizacaoAltura = { ...base.quantizacaoAltura, ...c.quantizacaoAltura };
  }
  if (c.serieAlturas && typeof c.serieAlturas === 'object') {
    base.serieAlturas = { ...serieAlturasPadrao(), ...c.serieAlturas };
  }
  if (base.serieAlturas && base.serieAlturas.ativa === true &&
      base.quantizacaoAltura.modo !== 'serie') {
    base.quantizacaoAltura = { modo: 'serie' };
    base.serieAlturas.ativa = false;
  }
  if (c.automacoes && typeof c.automacoes === 'object') {
    base.automacoes = {
      dinamica: Array.isArray(c.automacoes.dinamica) ? c.automacoes.dinamica : [],
      panorama: Array.isArray(c.automacoes.panorama) ? c.automacoes.panorama : [],
      reverb:   Array.isArray(c.automacoes.reverb)   ? c.automacoes.reverb   : [],
    };
  }
  return base;
}

export function relacaoDaDependente(id) {
  return estado.projeto.relacoes.find(r => r.camadasDependentes.includes(id)) || null;
}

export function removerRelacao(id) {
  estado.projeto.relacoes = estado.projeto.relacoes.filter(r => r.id !== id);
}

export function criarRelacaoDaSelecao() {
  if (estado.selecao.length < 2) return null;
  const [ref, ...deps] = estado.selecao;
  const r = criarRelacao(ref, deps.slice());
  estado.projeto.relacoes.push(r);
  return r;
}