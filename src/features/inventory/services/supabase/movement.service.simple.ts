/**
 * Simplified Movement Service - Supabase Implementation
 * Handles basic inventory movement operations
 */

import { supabase, handleSupabaseError } from '@/lib/supabase';
import type { Database } from '@/types/supabase';
import type { MovementType, MovementWithDetails } from '@/features/inventory/types/inventory.types';
import { toMovementId } from '@/features/inventory/types/inventory.types';

type MovementRow = Database['public']['Tables']['movements']['Row'];
type MovementInsert = Database['public']['Tables']['movements']['Insert'];

/**
 * Convert database movement row to UI format
 */
function mapMovementRowToUI(row: MovementRow): MovementWithDetails {
  return {
    id: toMovementId(row.id.toString()),
    date: new Date(row.datetime),
    type: row.type as MovementType,
    skuId: row.sku_id || '',
    skuDescription: row.product_name || row.sku_id || '',
    unit: 'unit',
    quantity: row.quantity,
    unitCost: row.unit_cost || 0,
    totalCost: row.total_value || 0,
    reference: row.reference,
    notes: row.notes || undefined,
  };
}

/**
 * Get movements with basic filtering
 */
export async function getMovements(filters?: {
  skuId?: string;
  type?: MovementType;
  limit?: number;
  offset?: number;
}): Promise<{ movements: MovementWithDetails[]; total: number }> {
  try {
    let query = supabase
      .from('movements')
      .select('*', { count: 'exact' });

    if (filters?.skuId) {
      query = query.eq('sku_id', filters.skuId);
    }
    
    if (filters?.type) {
      query = query.eq('type', filters.type);
    }

    if (filters?.limit) {
      query = query.limit(filters.limit);
    }
    
    if (filters?.offset) {
      query = query.range(filters.offset, (filters.offset + (filters?.limit || 50)) - 1);
    }

    query = query.order('datetime', { ascending: false });

    const { data, error, count } = await query;

    if (error) {
      handleSupabaseError(error);
    }

    return {
      movements: data?.map(mapMovementRowToUI) || [],
      total: count || 0,
    };
  } catch (error) {
    console.error('Error fetching movements:', error);
    throw error;
  }
}

/**
 * Create RECEIVE movement
 */
export async function createReceiveMovement(params: {
  skuId: string;
  quantity: number;
  unitCost: number;
  date: Date;
  vendorName: string;
  packingSlipNo?: string;
  notes?: string;
}): Promise<MovementWithDetails> {
  try {
    const movementData: MovementInsert = {
      type: 'RECEIVE',
      sku_id: params.skuId,
      quantity: params.quantity,
      unit_cost: params.unitCost,
      total_value: params.quantity * params.unitCost,
      datetime: params.date.toISOString(),
      reference: params.packingSlipNo || `RCV-${Date.now()}`,
      notes: params.notes,
    };

    const { data, error } = await supabase
      .from('movements')
      .insert(movementData)
      .select()
      .single();

    if (error) {
      handleSupabaseError(error);
    }

    return mapMovementRowToUI(data);
  } catch (error) {
    console.error('Error creating receive movement:', error);
    throw error;
  }
}

/**
 * Create ISSUE movement
 */
export async function createIssueMovement(params: {
  skuId: string;
  quantity: number;
  date: Date;
  reference?: string;
  notes?: string;
}): Promise<{ movement: MovementWithDetails; totalCost: number }> {
  try {
    // For now, use a simple average cost calculation
    const avgCost = 10; // TODO: Calculate from FIFO layers
    const totalCost = params.quantity * avgCost;

    const movementData: MovementInsert = {
      type: 'ISSUE',
      sku_id: params.skuId,
      quantity: -params.quantity, // Negative for issues
      unit_cost: avgCost,
      total_value: -totalCost,
      datetime: params.date.toISOString(),
      reference: params.reference || `ISS-${Date.now()}`,
      notes: params.notes,
    };

    const { data, error } = await supabase
      .from('movements')
      .insert(movementData)
      .select()
      .single();

    if (error) {
      handleSupabaseError(error);
    }

    return {
      movement: mapMovementRowToUI(data),
      totalCost,
    };
  } catch (error) {
    console.error('Error creating issue movement:', error);
    throw error;
  }
}

/**
 * Create WASTE movement
 */
export async function createWasteMovement(params: {
  skuId: string;
  quantity: number;
  date: Date;
  reference?: string;
  notes?: string;
}): Promise<{ movement: MovementWithDetails; totalCost: number }> {
  try {
    // For now, use a simple average cost calculation
    const avgCost = 10; // TODO: Calculate from FIFO layers
    const totalCost = params.quantity * avgCost;

    const movementData: MovementInsert = {
      type: 'WASTE',
      sku_id: params.skuId,
      quantity: -params.quantity, // Negative for waste
      unit_cost: avgCost,
      total_value: -totalCost,
      datetime: params.date.toISOString(),
      reference: params.reference || `WST-${Date.now()}`,
      notes: params.notes,
    };

    const { data, error } = await supabase
      .from('movements')
      .insert(movementData)
      .select()
      .single();

    if (error) {
      handleSupabaseError(error);
    }

    return {
      movement: mapMovementRowToUI(data),
      totalCost,
    };
  } catch (error) {
    console.error('Error creating waste movement:', error);
    throw error;
  }
}

/**
 * Create PRODUCE movement
 */
export async function createProduceMovement(params: {
  skuId: string;
  quantity: number;
  unitCost: number;
  date: Date;
  reference?: string;
  notes?: string;
}): Promise<MovementWithDetails> {
  try {
    const movementData: MovementInsert = {
      type: 'PRODUCE',
      sku_id: params.skuId,
      quantity: params.quantity,
      unit_cost: params.unitCost,
      total_value: params.quantity * params.unitCost,
      datetime: params.date.toISOString(),
      reference: params.reference || `PRD-${Date.now()}`,
      notes: params.notes,
    };

    const { data, error } = await supabase
      .from('movements')
      .insert(movementData)
      .select()
      .single();

    if (error) {
      handleSupabaseError(error);
    }

    return mapMovementRowToUI(data);
  } catch (error) {
    console.error('Error creating produce movement:', error);
    throw error;
  }
}
