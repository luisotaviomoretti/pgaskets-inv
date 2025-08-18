/**
 * FIFO Layer Service - Supabase Implementation
 * Handles FIFO inventory layer operations and consumption logic
 */

import { supabase, handleSupabaseError } from '@/lib/supabase';
import type { Database } from '@/types/supabase';
import type { LayerLite, SKUId } from '@/features/inventory/types/inventory.types';
import { toLayerId, toSKUId } from '@/features/inventory/types/inventory.types';

type LayerRow = Database['public']['Tables']['fifo_layers']['Row'];
type LayerInsert = Database['public']['Tables']['fifo_layers']['Insert'];
type LayerUpdate = Database['public']['Tables']['fifo_layers']['Update'];

/**
 * Convert database layer row to UI layer format
 */
function mapLayerRowToLite(row: LayerRow): LayerLite {
  return {
    id: toLayerId(row.id),
    date: new Date(row.receiving_date),
    remaining: row.remaining_quantity,
    cost: row.unit_cost,
  };
}

/**
 * Get FIFO layers for a specific SKU (ordered by date for FIFO)
 */
export async function getFIFOLayers(skuId: string): Promise<LayerLite[]> {
  try {
    const { data, error } = await supabase
      .from('fifo_layers')
      .select('*')
      .eq('sku_id', skuId)
      .eq('status', 'ACTIVE')
      .gt('remaining_quantity', 0)
      .order('receiving_date', { ascending: true }) // FIFO: oldest first
      .order('created_at', { ascending: true }); // Secondary sort for same-day receipts

    if (error) {
      handleSupabaseError(error);
    }

    return data?.map(mapLayerRowToLite) || [];
  } catch (error) {
    console.error('Error fetching FIFO layers:', error);
    throw error;
  }
}

/**
 * Get all layers grouped by SKU ID
 */
export async function getAllFIFOLayers(): Promise<Record<string, LayerLite[]>> {
  try {
    const { data, error } = await supabase
      .from('fifo_layers')
      .select('*')
      .eq('status', 'ACTIVE')
      .gt('remaining_quantity', 0)
      .order('sku_id')
      .order('receiving_date', { ascending: true });

    if (error) {
      handleSupabaseError(error);
    }

    // Group by SKU ID
    const layersBySku: Record<string, LayerLite[]> = {};
    data?.forEach(row => {
      const skuId = row.sku_id;
      if (!layersBySku[skuId]) {
        layersBySku[skuId] = [];
      }
      layersBySku[skuId].push(mapLayerRowToLite(row));
    });

    return layersBySku;
  } catch (error) {
    console.error('Error fetching all FIFO layers:', error);
    throw error;
  }
}

/**
 * Create new FIFO layer (from receiving)
 */
export async function createFIFOLayer(layer: {
  id: string;
  skuId: string;
  receivingDate: Date;
  quantity: number;
  unitCost: number;
  vendorId?: string;
  packingSlipNo?: string;
  lotNumber?: string;
}): Promise<LayerLite> {
  try {
    const insertData: LayerInsert = {
      id: layer.id,
      sku_id: layer.skuId,
      receiving_date: layer.receivingDate.toISOString().split('T')[0], // Date only
      original_quantity: layer.quantity,
      remaining_quantity: layer.quantity,
      unit_cost: layer.unitCost,
      vendor_id: layer.vendorId,
      packing_slip_no: layer.packingSlipNo,
      lot_number: layer.lotNumber,
      status: 'ACTIVE',
    };

    const { data, error } = await supabase
      .from('fifo_layers')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      handleSupabaseError(error);
    }

    return mapLayerRowToLite(data);
  } catch (error) {
    console.error('Error creating FIFO layer:', error);
    throw error;
  }
}

/**
 * FIFO Consumption Plan - Calculate which layers to consume for a given quantity
 */
export interface FIFOConsumptionPlan {
  layerId: string;
  consumeQty: number;
  unitCost: number;
  totalCost: number;
}

export interface FIFOPlanResult {
  plan: FIFOConsumptionPlan[];
  totalCost: number;
  totalQty: number;
  canFulfill: boolean;
}

/**
 * Calculate FIFO consumption plan for a SKU
 */
export async function calculateFIFOPlan(skuId: string, requestedQty: number): Promise<FIFOPlanResult> {
  try {
    const layers = await getFIFOLayers(skuId);
    const plan: FIFOConsumptionPlan[] = [];
    let remainingQty = requestedQty;
    let totalCost = 0;
    let totalQty = 0;

    for (const layer of layers) {
      if (remainingQty <= 0) break;

      const consumeQty = Math.min(remainingQty, layer.remaining);
      const layerCost = consumeQty * layer.cost;

      plan.push({
        layerId: layer.id as string,
        consumeQty,
        unitCost: layer.cost,
        totalCost: layerCost,
      });

      totalCost += layerCost;
      totalQty += consumeQty;
      remainingQty -= consumeQty;
    }

    return {
      plan,
      totalCost,
      totalQty,
      canFulfill: remainingQty <= 0,
    };
  } catch (error) {
    console.error('Error calculating FIFO plan:', error);
    throw error;
  }
}

/**
 * Execute FIFO consumption (update layer quantities)
 */
export async function executeFIFOConsumption(
  consumptionPlan: FIFOConsumptionPlan[],
  movementId: number
): Promise<void> {
  try {
    // Start transaction
    const { error: txError } = await supabase.rpc('begin_transaction');
    if (txError) throw txError;

    try {
      let totalConsumed = 0;
      let skuId = '';

      for (const item of consumptionPlan) {
        // Update layer remaining quantity
        const { error: layerError } = await supabase
          .rpc('update_layer_quantity', {
            p_layer_id: item.layerId,
            p_quantity_change: -item.consumeQty
          });

        if (layerError) throw layerError;

        // Get SKU ID from layer
        if (!skuId) {
          const { data: layerData } = await supabase
            .from('fifo_layers')
            .select('sku_id')
            .eq('id', item.layerId)
            .single();
          skuId = layerData?.sku_id || '';
        }

        // Record layer consumption
        const { error: consumptionError } = await supabase
          .from('layer_consumptions')
          .insert({
            movement_id: movementId,
            layer_id: item.layerId,
            quantity_consumed: item.consumeQty,
            unit_cost: item.unitCost,
            total_cost: item.totalCost,
          });

        if (consumptionError) throw consumptionError;
        
        totalConsumed += item.consumeQty;
      }

      // Update SKU on_hand
      if (skuId && totalConsumed > 0) {
        // Defensive check: ensure on_hand won't go negative
        const { data: skuRow, error: skuFetchError } = await supabase
          .from('skus')
          .select('on_hand')
          .eq('id', skuId)
          .single();

        if (skuFetchError) throw skuFetchError;

        const currentOnHand = skuRow?.on_hand ?? 0;
        if (currentOnHand < totalConsumed) {
          throw new Error(
            `INSUFFICIENT_STOCK_ON_HAND: sku=${skuId}, on_hand=${currentOnHand}, required=${totalConsumed}`
          );
        }

        const { error: skuError } = await supabase
          .rpc('update_sku_quantity', {
            p_sku_id: skuId,
            p_quantity_change: -totalConsumed
          });

        if (skuError) throw skuError;
      }

      // Commit transaction
      const { error: commitError } = await supabase.rpc('commit_transaction');
      if (commitError) throw commitError;

    } catch (error) {
      // Rollback on error
      await supabase.rpc('rollback_transaction');
      throw error;
    }
  } catch (error) {
    console.error('Error executing FIFO consumption:', error);
    throw error;
  }
}

/**
 * Get layer consumption history for a movement
 */
export async function getLayerConsumptions(movementId: number) {
  try {
    const { data, error } = await supabase
      .from('layer_consumptions')
      .select(`
        *,
        fifo_layers (
          id,
          sku_id,
          receiving_date,
          unit_cost
        )
      `)
      .eq('movement_id', movementId);

    if (error) {
      handleSupabaseError(error);
    }

    return data || [];
  } catch (error) {
    console.error('Error fetching layer consumptions:', error);
    throw error;
  }
}

/**
 * Update layer remaining quantity directly (for corrections)
 */
export async function updateLayerQuantity(layerId: string, newQuantity: number): Promise<void> {
  try {
    const { error } = await supabase
      .from('fifo_layers')
      .update({
        remaining_quantity: newQuantity,
        last_movement_at: new Date().toISOString(),
      })
      .eq('id', layerId);

    if (error) {
      handleSupabaseError(error);
    }
  } catch (error) {
    console.error('Error updating layer quantity:', error);
    throw error;
  }
}

/**
 * Get available quantity for a SKU (sum of all active layers)
 */
export async function getAvailableQuantity(skuId: string): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('fifo_layers')
      .select('remaining_quantity')
      .eq('sku_id', skuId)
      .eq('status', 'ACTIVE');

    if (error) {
      handleSupabaseError(error);
    }

    return data?.reduce((sum, layer) => sum + layer.remaining_quantity, 0) || 0;
  } catch (error) {
    console.error('Error getting available quantity:', error);
    throw error;
  }
}
