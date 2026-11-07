// ============================================================
// continuo.worker.js — Calcula o som contínuo fora da interface
// ============================================================
import { renderizarContinuo } from './continuo.js';

self.onmessage = (e) => {
  const { id, desc, sr } = e.data;
  try {
    const { dados, omitidos, itens } = renderizarContinuo(desc, sr);
    self.postMessage({ id, dados, omitidos, itens }, [dados.buffer]);
  } catch (err) {
    self.postMessage({ id, erro: String((err && err.stack) || err) });
  }
};
