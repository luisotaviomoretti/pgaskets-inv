/**
 * Inventory Store (Zustand + Immer + Persist)
 * Inicial simples para estado de Inventário e actions básicas.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

import {
  UISKUOption,
  VendorSuggestion,
  LayerLite,
  InventoryFilters,
} from '../types/inventory.types';

// -------------------------------------------------------------
// Tipagem do estado e actions
// -------------------------------------------------------------
export interface InventoryState {
  // Estado
  skus: Map<string, UISKUOption>;
  vendors: VendorSuggestion[];
  layers: Map<string, LayerLite[]>;
  filters: InventoryFilters;

  // Actions
  setSKUs: (skus: UISKUOption[] | Map<string, UISKUOption>) => void;
  setVendors: (vendors: VendorSuggestion[]) => void;
  setLayers: (layers: Record<string, LayerLite[]> | Map<string, LayerLite[]>) => void;
  updateSKU: (id: string, patch: Partial<UISKUOption>) => void;
}

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
const toSkuMap = (input: UISKUOption[] | Map<string, UISKUOption>): Map<string, UISKUOption> => {
  if (input instanceof Map) return new Map(input);
  const m = new Map<string, UISKUOption>();
  for (const s of input) m.set((s.id as unknown as string), s);
  return m;
};

const toLayerMap = (input: Record<string, LayerLite[]> | Map<string, LayerLite[]>): Map<string, LayerLite[]> => {
  if (input instanceof Map) return new Map(input);
  return new Map<string, LayerLite[]>(Object.entries(input));
};

// -------------------------------------------------------------
// Store
// -------------------------------------------------------------
export const useInventoryStore = create<InventoryState>()(
  persist(
    // Tipamos o "set" para evitar implicit any nos callbacks do immer
    immer((set: (recipe: (state: InventoryState) => void) => void) => ({
      // Estado inicial
      skus: new Map<string, UISKUOption>(),
      vendors: [],
      layers: new Map<string, LayerLite[]>(),
      filters: {},

      // Actions
      setSKUs: (skus: UISKUOption[] | Map<string, UISKUOption>) =>
        set((state: InventoryState) => {
          state.skus = toSkuMap(skus);
        }),

      setVendors: (vendors: VendorSuggestion[]) =>
        set((state: InventoryState) => {
          state.vendors = vendors.slice();
        }),

      setLayers: (layers: Record<string, LayerLite[]> | Map<string, LayerLite[]>) =>
        set((state: InventoryState) => {
          state.layers = toLayerMap(layers);
        }),

      updateSKU: (id: string, patch: Partial<UISKUOption>) =>
        set((state: InventoryState) => {
          const existing = state.skus.get(id);
          if (!existing) return;
          state.skus.set(id, { ...existing, ...patch });
        }),
    })),
    {
      name: 'inventory-store',
      storage: createJSONStorage(() => localStorage),
      // Persistir somente filtros para evitar grandes blobs no localStorage
      partialize: (state) => ({ filters: state.filters }),
    }
  )
);

