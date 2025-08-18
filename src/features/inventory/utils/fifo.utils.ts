import { LayerLite } from '../types/inventory.types';

/**
 * Utilitários FIFO de estoque
 * Lógica copiada do wireframe `inventory_fifo_dashboard_react_v_2.jsx` com type-safety adicional.
 */

/** Item do plano FIFO (saída). */
export interface FifoPlanItem {
  layerId: string;
  qty: number;
  cost: number;
}

/**
 * Calcula o custo médio ponderado (por quantidade remanescente) das camadas FIFO.
 *
 * Regras (idênticas ao wireframe):
 * - Se não houver camadas ou soma de quantidades for 0, retorna null.
 * - Usa somente `remaining` e `cost` (quantidades negativas são tratadas como 0).
 *
 * @param layers Lista de camadas FIFO (LayerLite[])
 * @returns number | null — custo médio ou null se não aplicável
 *
 * @example
 * const avg = fifoAvgCost([
 *   { id: 'L1', date: '2025-01-01', remaining: 10, cost: 2 },
 *   { id: 'L2', date: '2025-01-02', remaining: 10, cost: 4 },
 * ]);
 * // avg === 3
 */
export function fifoAvgCost(layers: LayerLite[] | undefined): number | null {
  if (layers === undefined) return null;
  if (!Array.isArray(layers)) throw new Error('fifoAvgCost: layers deve ser um array');
  if (layers.length === 0) return null;

  // Validação básica dos itens
  for (const l of layers) {
    if (typeof l !== 'object' || l === null) throw new Error('fifoAvgCost: camada inválida');
    if (typeof (l as any).remaining !== 'number' || !Number.isFinite((l as any).remaining)) {
      throw new Error('fifoAvgCost: "remaining" deve ser número finito');
    }
    if (typeof (l as any).cost !== 'number' || !Number.isFinite((l as any).cost)) {
      throw new Error('fifoAvgCost: "cost" deve ser número finito');
    }
  }

  const totalQty = layers.reduce((s, l) => s + Math.max(0, l.remaining), 0);
  if (totalQty <= 0) return null;
  const totalVal = layers.reduce((s, l) => s + Math.max(0, l.remaining) * l.cost, 0);
  return totalVal / totalQty;
}

/**
 * Planeja a baixa FIFO para uma emissão (issue) de quantidade `issueQty`.
 *
 * Regras (idênticas ao wireframe):
 * - Se `issueQty` <= 0 ou `layers` vazio/indefinido, retorna array vazio.
 * - Consume na ordem das camadas, respeitando `remaining` (valores negativos tratados como 0).
 *
 * @param layers Lista de camadas FIFO (LayerLite[])
 * @param issueQty Quantidade a emitir (deve ser número finito)
 * @returns Array<{layerId, qty, cost}>
 *
 * @example
 * const plan = fifoPlan([
 *   { id: 'L1', date: '2025-01-01', remaining: 5, cost: 2 },
 *   { id: 'L2', date: '2025-01-02', remaining: 7, cost: 3 },
 * ], 8);
 * // plan => [ { layerId: 'L1', qty: 5, cost: 2 }, { layerId: 'L2', qty: 3, cost: 3 } ]
 */
export function fifoPlan(layers: LayerLite[] | undefined, issueQty: number): FifoPlanItem[] {
  if (layers === undefined || layers.length === 0) return [];
  if (!Array.isArray(layers)) throw new Error('fifoPlan: layers deve ser um array');
  if (typeof issueQty !== 'number' || !Number.isFinite(issueQty)) {
    throw new Error('fifoPlan: issueQty deve ser um número finito');
  }
  if (issueQty <= 0) return [];

  // Validação básica dos itens
  for (const l of layers) {
    if (typeof l !== 'object' || l === null) throw new Error('fifoPlan: camada inválida');
    if (typeof (l as any).id !== 'string') throw new Error('fifoPlan: "id" da camada deve ser string');
    if (typeof (l as any).remaining !== 'number' || !Number.isFinite((l as any).remaining)) {
      throw new Error('fifoPlan: "remaining" deve ser número finito');
    }
    if (typeof (l as any).cost !== 'number' || !Number.isFinite((l as any).cost)) {
      throw new Error('fifoPlan: "cost" deve ser número finito');
    }
  }

  let need = Math.max(0, Math.floor(issueQty));
  const plan: FifoPlanItem[] = [];
  for (const l of layers) {
    if (need <= 0) break;
    const take = Math.min(need, Math.max(0, l.remaining));
    if (take > 0) {
      plan.push({ layerId: String(l.id), qty: take, cost: l.cost });
      need -= take;
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Inline self-tests (dev only) — usa console.assert, não lança exceções em prod
// ---------------------------------------------------------------------------
(() => {
  try {
    const avg = fifoAvgCost([
      { id: 'L1', date: '2025-01-01', remaining: 10, cost: 2 },
      { id: 'L2', date: '2025-01-02', remaining: 10, cost: 4 },
    ] as unknown as LayerLite[]);
    console.assert(avg !== null && Math.abs((avg as number) - 3) < 1e-6, 'fifoAvgCost esperado 3');

    const plan = fifoPlan([
      { id: 'L1', date: '2025-01-01', remaining: 5, cost: 2 },
      { id: 'L2', date: '2025-01-02', remaining: 7, cost: 3 },
    ] as unknown as LayerLite[], 8);
    console.assert(plan.length === 2 && plan[0].qty === 5 && plan[1].qty === 3, 'fifoPlan esperado [5,3]');
  } catch {
    // silencioso — apenas evita quebrar em ambientes sem console ou sem TS configs
  }
})();

