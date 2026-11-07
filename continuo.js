// ============================================================
// continuo.js — Síntese do objeto "Som contínuo"
// ============================================================
//
// O polígono funciona como MÁSCARA no plano tempo × log-frequência:
// o material sonoro tem altura fixa e só soa onde está dentro da
// área. A interpolação das bordas é feita em log-frequência, igual
// ao desenho (eixo vertical logarítmico).
//
//  - sine     → cluster de senoides na grade de alturas
//  - aditiva  → cluster + harmônicos de cada altura
//  - fm       → cluster + espectro calculado (bandas de Bessel)
//  - granular → grãos sorteados dentro da área
//  - ruido    → ruído branco filtrado por STFT
//
// Grade de alturas (quantização):
//  - livre / série → quarto de tom
//  - semitons      → semitom
//  - conjunto      → somente as classes escolhidas
//
// Um parcial soa apenas enquanto sua voz (a altura da grade que o
// gerou) e ele próprio estiverem dentro do polígono. Os parciais
// mantêm a frequência natural: não são quantizados.
//
// Módulo puro: sem DOM e sem Web Audio. Roda dentro do Worker.
// ============================================================

const ALVO_PICO = 0.7;           // pico do material normalizado
const FADE_S = 0.005;            // fade das bordas de cada segmento
const SEGMENTO_MIN_S = 0.002;    // segmentos menores são descartados
const AMP_MIN = 1e-3;            // parciais mais fracos são ignorados
// Limite de custo: amostras de oscilador somadas num render.
const ORCAMENTO_AMOSTRAS = 6e9;
const MAX_GRAOS = 2e6;
const STFT_N = 4096;
const STFT_HOP = 1024;
const DENSIDADE_GRAOS_PADRAO = 100;

// ------------------------------------------------------------
// PRNG (a mesma família usada em audio.js)
// ------------------------------------------------------------
function prng(semente) {
  let a = (semente >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midiParaHz = m => 440 * Math.pow(2, (m - 69) / 12);
const hzParaMidi = f => 69 + 12 * Math.log2(f / 440);

// ------------------------------------------------------------
// Geometria (t, l), com l = log2(f)
// ------------------------------------------------------------
export function poligonoLog(vertices) {
  return vertices.map(v => ({ t: v.t, l: Math.log2(Math.max(1, v.f)) }));
}

/** Intervalos de log-frequência dentro do polígono no instante t. */
export function intervalosEmTempo(poly, t) {
  const c = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if ((a.t <= t && b.t > t) || (b.t <= t && a.t > t)) {
      c.push(a.l + (t - a.t) / (b.t - a.t) * (b.l - a.l));
    }
  }
  return pares(c);
}

/** Intervalos de tempo em que a log-frequência l está no polígono. */
export function intervalosEmAltura(poly, l) {
  const c = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if ((a.l <= l && b.l > l) || (b.l <= l && a.l > l)) {
      c.push(a.t + (l - a.l) / (b.l - a.l) * (b.t - a.t));
    }
  }
  return pares(c);
}

function pares(c) {
  c.sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i + 1 < c.length; i += 2) out.push([c[i], c[i + 1]]);
  return out;
}

function intersecao(A, B) {
  const out = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    const ini = Math.max(A[i][0], B[j][0]);
    const fim = Math.min(A[i][1], B[j][1]);
    if (fim > ini) out.push([ini, fim]);
    if (A[i][1] < B[j][1]) i++; else j++;
  }
  return out;
}

// ------------------------------------------------------------
// Grade de alturas
// ------------------------------------------------------------
export function gradeDeAlturas(quant, fMin, fMax) {
  const modo = quant && quant.modo;
  const passo = (modo === 'semitons' || modo === 'conjunto') ? 1 : 0.5;
  const classes = modo === 'conjunto'
    ? (Array.isArray(quant.classes) ? quant.classes : [0,2,4,5,7,9,11])
    : null;
  const inicio = Math.ceil(hzParaMidi(fMin) / passo - 1e-9) * passo;
  const fim = hzParaMidi(fMax) + 1e-9;
  const out = [];
  for (let m = inicio; m <= fim; m += passo) {
    if (classes && !classes.includes(((m % 12) + 12) % 12)) continue;
    out.push(midiParaHz(m));
  }
  return out;
}

// ------------------------------------------------------------
// Espectros
// ------------------------------------------------------------
/** Função de Bessel J_n(x), n ≥ 0, pela integral de Bessel. */
export function besselJ(n, x) {
  const M = Math.max(64, 2 * (n + Math.ceil(Math.abs(x))) + 32);
  let soma = 0;
  for (let i = 0; i < M; i++) {
    const tau = Math.PI * (i + 0.5) / M;
    soma += Math.cos(n * tau - x * Math.sin(tau));
  }
  return soma / M;
}

/** Fatores de frequência e amplitudes, relativos à fundamental. */
function moldeEspectral(timbre) {
  if (timbre.tipo === 'aditiva') {
    const n = Math.max(1, Math.min(32, Math.round(timbre.nHarm ?? 6)));
    const incl = timbre.inclinacao ?? 1.5;
    const out = [];
    for (let h = 1; h <= n; h++) out.push({ r: h, a: 1 / Math.pow(h, incl) });
    return out;
  }
  if (timbre.tipo === 'fm') return espectroFM(timbre.razao ?? 2, timbre.indice ?? 3);
  return [{ r: 1, a: 1 }];
}

/** Bandas laterais fc + k·fm. O desvio da FM é f·índice, então
 *  beta = índice / razão. Frequências negativas são rebatidas com
 *  inversão de fase e somadas às positivas coincidentes. */
export function espectroFM(razaoBruta, indice) {
  const razao = razaoBruta > 0 ? razaoBruta : 2;
  const beta = Math.max(0, indice) / razao;
  const kMax = Math.min(400, Math.ceil(beta) + 8);
  const mapa = new Map();
  for (let k = -kMax; k <= kMax; k++) {
    const n = Math.abs(k);
    let a = besselJ(n, beta);
    if (k < 0 && n % 2 === 1) a = -a;
    let r = 1 + k * razao;
    if (r < 0) { r = -r; a = -a; }
    if (r < 1e-9) continue;
    const chave = Math.round(r * 1e6);
    const atual = mapa.get(chave);
    mapa.set(chave, { r, a: (atual ? atual.a : 0) + a });
  }
  return [...mapa.values()]
    .filter(p => Math.abs(p.a) >= AMP_MIN)
    .map(p => ({ r: p.r, a: Math.abs(p.a) }));
}

// ------------------------------------------------------------
// Render: cluster (senoidal, aditiva, FM)
// ------------------------------------------------------------
function listarParciais(desc, sr, poly, lMin, lMax) {
  const { t0, t1, timbre, quant } = desc;
  const r = prng((desc.semente ^ 0x2F0B4A87) >>> 0);
  const fTeto = Math.min(Math.pow(2, lMax), sr * 0.49);
  const vozes = gradeDeAlturas(quant, Math.pow(2, lMin), fTeto);
  const molde = moldeEspectral(timbre);
  const lista = [];
  for (const fV of vozes) {
    const lV = Math.log2(fV);
    const segV = intersecao(intervalosEmAltura(poly, lV), [[t0, t1]]);
    for (const p of molde) {
      const fase = r() * 2 * Math.PI;
      const f = fV * p.r;
      if (f > fTeto) continue;
      const l = Math.log2(f);
      if (l < lMin || l > lMax) continue;
      const segs = intersecao(segV, intervalosEmAltura(poly, l))
        .filter(([a, b]) => b - a >= SEGMENTO_MIN_S);
      if (segs.length) lista.push({ f, a: p.a, fase, segs });
    }
  }
  return lista;
}

function somarParcial(saida, p, sr, t0) {
  const w = 2 * Math.PI * p.f / sr;
  const cr = Math.cos(w), ci = Math.sin(w);
  const BLOCO = 4096;  // refaz a fase exata para não acumular erro
  for (const [ta, tb] of p.segs) {
    const iA = Math.max(0, Math.round((ta - t0) * sr));
    const iB = Math.min(saida.length, Math.round((tb - t0) * sr));
    const L = iB - iA;
    if (L <= 1) continue;
    const F = Math.min(Math.round(FADE_S * sr), L >> 1);
    const dG = F > 0 ? Math.PI / F : 0;
    for (let ini = iA; ini < iB; ini += BLOCO) {
      const fim = Math.min(iB, ini + BLOCO);
      const fase = p.fase + w * ini;
      let re = Math.cos(fase), im = Math.sin(fase);
      if (ini - iA >= F && iB - fim >= F) {  // miolo do segmento, sem fade
        const a = p.a;
        for (let i = ini; i < fim; i++) {
          saida[i] += a * im;
          const nr = re * cr - im * ci;
          im = re * ci + im * cr;
          re = nr;
        }
        continue;
      }
      for (let i = ini; i < fim; i++) {
        let g = p.a;
        const dA = i - iA, dB = iB - 1 - i;
        if (dA < F) g *= 0.5 - 0.5 * Math.cos(dG * dA);
        else if (dB < F) g *= 0.5 - 0.5 * Math.cos(dG * dB);
        saida[i] += g * im;
        const nr = re * cr - im * ci;
        im = re * ci + im * cr;
        re = nr;
      }
    }
  }
}

function renderCluster(desc, sr, n, poly, lMin, lMax) {
  const saida = new Float64Array(n);
  const lista = listarParciais(desc, sr, poly, lMin, lMax);
  lista.sort((a, b) => b.a - a.a);
  let custo = 0, omitidos = 0;
  for (const p of lista) {
    const dur = p.segs.reduce((s, [a, b]) => s + (b - a), 0);
    custo += dur * sr;
    if (custo > ORCAMENTO_AMOSTRAS) { omitidos++; continue; }
    somarParcial(saida, p, sr, desc.t0);
  }
  return { saida, omitidos, itens: lista.length };
}

// ------------------------------------------------------------
// Render: granular
// ------------------------------------------------------------
function renderGranular(desc, sr, n, poly, lMin, lMax) {
  const { t0, t1, timbre, quant } = desc;
  const saida = new Float64Array(n);
  const r = prng((desc.semente ^ 0x7C15AD3B) >>> 0);
  const durBase = (timbre.duracaoGraoMs ?? 30) / 1000;
  const aleat = (timbre.aleatoriedadeGrao ?? 0) / 100;
  const suav = Math.min(100, Math.max(0, timbre.suavizacaoEnv ?? 50)) / 100;
  const dens = Math.max(0.1, timbre.densidadeGraos ?? DENSIDADE_GRAOS_PADRAO);

  // Em "livre" a altura do grão é contínua; nos demais, segue a grade.
  const modo = quant && quant.modo;
  const grade = (modo === 'semitons' || modo === 'conjunto')
    ? gradeDeAlturas(quant, Math.pow(2, lMin), Math.min(Math.pow(2, lMax), sr * 0.49))
    : null;
  if (grade && !grade.length) return { saida, omitidos: 0, itens: 0 };

  // Sorteio uniforme no retângulo envolvente, rejeitando o que cai
  // fora: a densidade por área não depende da forma do polígono.
  const area = (t1 - t0) * (lMax - lMin);
  const nTentativas = Math.min(MAX_GRAOS, Math.ceil(dens * area));
  const lTeto = Math.log2(sr * 0.49);
  let itens = 0;
  for (let i = 0; i < nTentativas; i++) {
    const tC = t0 + r() * (t1 - t0);
    const sorteioL = r(), sorteioFase = r(), sorteioDur = r();
    const l = grade
      ? Math.log2(grade[Math.min(grade.length - 1, Math.floor(sorteioL * grade.length))])
      : lMin + sorteioL * (lMax - lMin);
    if (l > lTeto) continue;
    const seg = intervalosEmAltura(poly, l).find(([a, b]) => tC >= a && tC <= b);
    if (!seg) continue;
    const d = Math.max(0.002, durBase * (1 + aleat * (sorteioDur * 2 - 1)));
    // O grão é recortado para não atravessar a borda do polígono.
    const ini = Math.max(seg[0], t0, tC - d / 2);
    const fim = Math.min(seg[1], t1, tC + d / 2);
    const L = Math.round((fim - ini) * sr);
    if (L < 8) continue;
    const i0 = Math.round((ini - t0) * sr);
    const w = 2 * Math.PI * Math.pow(2, l) / sr;
    const fase = sorteioFase * 2 * Math.PI;
    const R = Math.max(Math.round(0.0005 * sr), Math.round(0.5 * suav * L));
    const Rlim = Math.min(R, L >> 1);
    for (let k = 0; k < L && i0 + k < n; k++) {
      const borda = Math.min(k, L - 1 - k);
      const g = borda < Rlim ? (borda + 0.5) / Rlim : 1;
      saida[i0 + k] += g * Math.sin(fase + w * k);
    }
    itens++;
  }
  return { saida, omitidos: 0, itens };
}

// ------------------------------------------------------------
// Render: ruído branco filtrado por STFT
// ------------------------------------------------------------
/** FFT complexa radix-2, in-place. inversa = true não divide por N. */
export function fft(re, im, inversa = false) {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let x = re[i]; re[i] = re[j]; re[j] = x;
      x = im[i]; im[i] = im[j]; im[j] = x;
    }
  }
  const sinal = inversa ? 1 : -1;
  for (let L = 2; L <= N; L <<= 1) {
    const ang = sinal * 2 * Math.PI / L;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const meio = L >> 1;
    for (let i = 0; i < N; i += L) {
      let cr = 1, ci = 0;
      for (let k = 0; k < meio; k++) {
        const a = i + k, b = a + meio;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function renderRuido(desc, sr, n, poly) {
  const { t0, t1 } = desc;
  const N = STFT_N, H = STFT_HOP;
  const saida = new Float64Array(n);
  const r = prng((desc.semente ^ 0xC0FFEE) >>> 0);

  // Ruído branco com margem de um quadro em cada lado.
  const ruido = new Float32Array(n + 2 * N);
  for (let i = 0; i < ruido.length; i++) ruido[i] = r() * 2 - 1;

  const janela = new Float64Array(N);
  for (let i = 0; i < N; i++) janela[i] = Math.sin(Math.PI * (i + 0.5) / N);
  const ganhoOLA = 1 / (N / H / 2);  // soma de sen² com sobreposição N/H

  const re = new Float64Array(N), im = new Float64Array(N);
  const pesos = new Float64Array(N / 2 + 1);
  const df = sr / N;
  const eps = 1e-6;

  for (let s = H - N; s < n; s += H) {
    // Quadros além das extremidades usam a máscara da extremidade,
    // para que o início e o fim do objeto não sejam arredondados.
    const tC = Math.min(t1 - eps, Math.max(t0 + eps, t0 + (s + N / 2) / sr));
    const ints = intervalosEmTempo(poly, tC);
    if (!ints.length) continue;

    pesos.fill(0);
    for (const [la, lb] of ints) {
      const fa = Math.pow(2, la), fb = Math.min(Math.pow(2, lb), sr / 2);
      const kA = Math.max(1, Math.floor(fa / df - 0.5));
      const kB = Math.min(N / 2, Math.ceil(fb / df + 0.5));
      for (let k = kA; k <= kB; k++) {
        const cob = Math.min((k + 0.5) * df, fb) - Math.max((k - 0.5) * df, fa);
        if (cob > 0) pesos[k] += cob / df;
      }
    }

    for (let i = 0; i < N; i++) {
      re[i] = ruido[s + N + i] * janela[i];
      im[i] = 0;
    }
    fft(re, im);
    // Raiz do peso: a potência é proporcional à largura coberta.
    re[0] = im[0] = 0;
    for (let k = 1; k < N / 2; k++) {
      const g = Math.sqrt(Math.min(1, pesos[k]));
      re[k] *= g; im[k] *= g;
      re[N - k] *= g; im[N - k] *= g;
    }
    const gN = Math.sqrt(Math.min(1, pesos[N / 2]));
    re[N / 2] *= gN; im[N / 2] *= gN;
    fft(re, im, true);

    for (let i = 0; i < N; i++) {
      const idx = s + i;
      if (idx >= 0 && idx < n) saida[idx] += re[i] / N * janela[i] * ganhoOLA;
    }
  }
  return { saida, omitidos: 0, itens: 0 };
}

// ------------------------------------------------------------
// Entrada
// ------------------------------------------------------------
/** desc: { vertices, timbre, quant, semente, t0, t1 }.
 *  Devolve { dados: Float32Array, omitidos, itens, pico }. */
export function renderizarContinuo(desc, sr) {
  const n = Math.max(1, Math.round((desc.t1 - desc.t0) * sr));
  const poly = poligonoLog(desc.vertices);
  const ls = poly.map(p => p.l);
  const lMin = Math.min(...ls), lMax = Math.max(...ls);

  let res;
  if (desc.timbre.tipo === 'ruido') res = renderRuido(desc, sr, n, poly);
  else if (desc.timbre.tipo === 'granular') res = renderGranular(desc, sr, n, poly, lMin, lMax);
  else res = renderCluster(desc, sr, n, poly, lMin, lMax);

  const { saida } = res;

  // Bordas do objeto: evita clique nos extremos do buffer.
  const F = Math.min(Math.round(FADE_S * sr), n >> 1);
  for (let i = 0; i < F; i++) {
    const g = 0.5 - 0.5 * Math.cos(Math.PI * i / F);
    saida[i] *= g; saida[n - 1 - i] *= g;
  }

  let pico = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(saida[i]);
    if (v > pico) pico = v;
  }
  const k = pico > 1e-9 ? ALVO_PICO / pico : 0;
  const dados = new Float32Array(n);
  for (let i = 0; i < n; i++) dados[i] = saida[i] * k;
  return { dados, omitidos: res.omitidos, itens: res.itens, pico };
}
