/**
 * Serviço mockado de Inventário
 * Fornece dados locais simulando respostas de API com atraso artificial (300ms).
 *
 * Origem: baseado no wireframe (inventory_fifo_dashboard_react_v_2.jsx)
 * Convertido para tipos modernos (SKUId, LayerId, enums, etc.).
 */

import {
  // Tipos de UI/domínio necessários
  UISKUOption,
  VendorSuggestion,
  LayerLite,
  SKUId,
  ProductCategory,
  MaterialType,
  // Helpers de construção/validação
  toSKUId,
  toLayerId,
} from '../types/inventory.types';

// ---------------------------------------------------------------------------
// Fixtures (dados estáticos)
// ---------------------------------------------------------------------------

// Vendors (sugestões para autocomplete)
const MOCK_VENDORS: VendorSuggestion[] = [
  { name: 'Acme Supplies Co.', address: '123 Industrial Rd, Dallas, TX' },
  { name: 'Industrial Materials Inc.', address: '90-1200 1st Ave, Seattle, WA' },
  { name: 'Gasket & Seals Partners', address: '55 Supply Way, Phoenix, AZ' },
];

// SKUs (opções simplificadas usadas no wireframe)
const MOCK_SKUS: UISKUOption[] = [
  {
    id: toSKUId('SKU-001'),
    description: 'GAX-12',
    type: MaterialType.RAW,
    productCategory: ProductCategory.CORK_RUBBER,
    unit: 'unit',
    min: 100,
    onHand: 80,
  },
  {
    id: toSKUId('SKU-002'),
    description: 'GAX-16',
    type: MaterialType.RAW,
    productCategory: ProductCategory.ADHESIVES,
    unit: 'unit',
    min: 150,
    onHand: 200,
  },
  {
    id: toSKUId('P-001'),
    description: 'Gasket P-001',
    type: MaterialType.SELLABLE,
    productCategory: ProductCategory.FIBRE_FOAM,
    unit: 'unit',
    min: 180,
    onHand: 210,
  },
];

// Camadas FIFO iniciais por SKU
const INITIAL_LAYERS: Record<SKUId, LayerLite[]> = {
  [toSKUId('SKU-001')]: [
    { id: toLayerId('SKU-001-L1'), date: new Date('2025-07-01'), remaining: 60, cost: 5.20 },
    { id: toLayerId('SKU-001-L2'), date: new Date('2025-07-15'), remaining: 20, cost: 5.40 },
  ],
  [toSKUId('SKU-002')]: [
    { id: toLayerId('SKU-002-L1'), date: new Date('2025-08-01'), remaining: 150, cost: 5.40 },
    { id: toLayerId('SKU-002-L2'), date: new Date('2025-08-10'), remaining: 50, cost: 5.50 },
  ],
  [toSKUId('P-001')]: [
    { id: toLayerId('P-001-L1'), date: new Date('2025-08-02'), remaining: 120, cost: 12.73 },
    { id: toLayerId('P-001-L2'), date: new Date('2025-08-06'), remaining: 90, cost: 12.91 },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// API mock (Promise com atraso de ~300ms)
// ---------------------------------------------------------------------------

/** Retorna SKUs simplificados para uso na UI. */
export const getSKUs = async (): Promise<UISKUOption[]> => {
  await delay(300);
  // Retornamos uma cópia para evitar mutações externas
  return MOCK_SKUS.map((s) => ({ ...s }));
};

/** Retorna sugestões de vendors para autocomplete. */
export const getVendors = async (): Promise<VendorSuggestion[]> => {
  await delay(300);
  return MOCK_VENDORS.map((v) => ({ ...v }));
};

/** Retorna camadas FIFO agrupadas por SKUId. */
export const getLayers = async (): Promise<Record<SKUId, LayerLite[]>> => {
  await delay(300);
  const out: Record<SKUId, LayerLite[]> = {} as any;
  for (const [k, v] of Object.entries(INITIAL_LAYERS)) {
    out[k as SKUId] = v.map((l) => ({ ...l }));
  }
  return out;
};
