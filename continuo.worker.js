// ============================================================
// continuo.worker.js — Calcula os sons fora da interface
// Polifonia Eletroacústica — Copyright (C) 2026 Rogério Tavares Constante
// Licença GPL-3.0 ou posterior (ver LICENSE).
// ============================================================
import { renderizarContinuo, analisarFonte } from './continuo.js';

// Arquivos de áudio enviados pela interface: chave → { dados, sr, analise }.
const fontes = new Map();

function obterFonte(ref) {
  if (!ref) return null;
  const fonte = fontes.get(ref.chave);
  if (!fonte) throw new Error('arquivo de áudio não carregado: ' + ref.chave);
  if (!fonte.analise) fonte.analise = analisarFonte(fonte.dados, fonte.sr);
  return fonte;
}

self.onmessage = (e) => {
  if (e.data.tipo === 'arquivo') {
    const { chave, dados, sr } = e.data;
    fontes.set(chave, { dados, sr, analise: null });
    return;
  }
  const { id, desc, sr } = e.data;
  try {
    const { dados, omitidos, itens } = renderizarContinuo(desc, sr, obterFonte(desc.fonte));
    self.postMessage({ id, dados, omitidos, itens }, [dados.buffer]);
  } catch (err) {
    self.postMessage({ id, erro: String((err && err.stack) || err) });
  }
};
