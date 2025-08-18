/**
 * Movement Service - Supabase Implementation
 * Handles all inventory movement operations (RECEIVE, ISSUE, WASTE, PRODUCE)
 */

import { supabase, handleSupabaseError } from '@/lib/supabase';
import type { Database } from '@/types/supabase';
import type { MovementType, MovementWithDetails } from '@/features/inventory/types/inventory.types';
import { toMovementId } from '@/features/inventory/types/inventory.types';
import { calculateFIFOPlan, executeFIFOConsumption, createFIFOLayer } from './fifo.service';
import { createOrGetVendorByName } from './vendor.service';

type MovementRow = Database['public']['Tables']['movements']['Row'];
type MovementInsert = Database['public']['Tables']['movements']['Insert'];

/**
 * Convert database movement row to UI format
 */
function mapMovementRowToUI(row: MovementRow & { 
  skus?: { id: string; description: string; unit: string } | null;
  vendors?: { name: string } | null;
}): MovementWithDetails {
  return {
    id: toMovementId(row.id.toString()),
    date: new Date(row.datetime),
    type: row.type as MovementType,
    skuId: row.sku_id || '',
    skuDescription: row.skus?.description || row.product_name || row.sku_id || '',
    unit: row.skus?.unit || 'unit',
    quantity: row.quantity,
    unitCost: row.unit_cost || 0,
    totalCost: row.total_value || 0,
    vendor: row.vendors?.name,
    reference: row.reference,
    notes: row.notes || undefined,
  };
}

/**
 * Get production group deletion info by reference (PRODUCE + related ISSUE/WASTE)
 */
export async function getProductionGroupDeletionInfo(reference: string): Promise<{
  reference: string;
  canDelete: boolean;
  hasProduce: boolean;
  anyReversed: boolean;
  movements: Array<{ id: number; type: MovementType; sku_id: string | null; quantity: number; total_value: number; datetime: string; reversed_at: string | null }>
}> {
  const { data, error } = await supabase.rpc('get_production_group_deletion_info', {
    p_reference: reference
  });
  if (error) throw error;
  return {
    reference: data.reference,
    canDelete: data.can_delete,
    hasProduce: data.has_produce,
    anyReversed: data.any_reversed,
    movements: (data.movements || []).map((m: any) => ({
      id: m.id,
      type: m.type,
      sku_id: m.sku_id,
      quantity: m.quantity,
      total_value: m.total_value,
      datetime: m.datetime,
      reversed_at: m.reversed_at,
    })),
  };
}

/**
 * Get movements with filtering and pagination
 */
export async function getMovements(filters?: {
  skuId?: string;
  type?: MovementType;
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  offset?: number;
}): Promise<{ movements: MovementWithDetails[]; total: number }> {
  let query = supabase
    .from('movements')
    .select(`
      *,
      skus!movements_sku_id_fkey (
        id,
        description,
        unit,
        type,
        product_category
      )
    `, { count: 'exact' })
    .order('datetime', { ascending: false });

  // Apply filters
  if (filters?.skuId) {
    query = query.eq('sku_id', filters.skuId);
  }
  if (filters?.type) {
    query = query.eq('type', filters.type);
  }
  if (filters?.dateFrom) {
    query = query.gte('datetime', filters.dateFrom.toISOString());
  }
  if (filters?.dateTo) {
    query = query.lte('datetime', filters.dateTo.toISOString());
  }
  if (filters?.limit) {
    query = query.limit(filters.limit);
  }
  if (filters?.offset) {
    query = query.range(filters.offset, (filters.offset + (filters.limit || 50)) - 1);
  }

  const { data, error, count } = await query;
  if (error) throw error;

  const movements = (data || []).map(mapMovementRowToUI);
  return { movements, total: count || 0 };
}

/**
 * Create RECEIVE movement with FIFO layer creation using transactional RPC
 */
export async function createReceiveMovement(params: {
  skuId: string;
  quantity: number;
  unitCost: number;
  date: Date;
  vendorName: string;
  packingSlipNo?: string;
  lotNumber?: string;
  notes?: string;
}): Promise<MovementWithDetails> {
  try {
    // Get or create vendor
    const vendor = await createOrGetVendorByName(params.vendorName);

    console.log('Creating receive movement with transactional RPC:', {
      skuId: params.skuId,
      quantity: params.quantity,
      unitCost: params.unitCost,
      vendorId: vendor.id
    });

    // Call transactional RPC
    const { data: result, error } = await supabase.rpc('create_receiving_transaction', {
      p_sku_id: params.skuId,
      p_quantity: params.quantity,
      p_unit_cost: params.unitCost,
      p_receiving_date: params.date.toISOString().split('T')[0], // Date only
      p_vendor_id: vendor.id,
      p_packing_slip_no: params.packingSlipNo || null,
      p_reference: params.packingSlipNo || `RCV-${Date.now()}`,
      p_notes: params.notes || null
    });

    if (error) {
      console.error('Error creating receive movement via RPC:', error);
      throw error;
    }

    if (!result?.success) {
      throw new Error('Receive movement creation failed');
    }

    console.log('Receive movement created successfully:', result);

    // Fetch the created movement for return
    const { data: movement, error: fetchError } = await supabase
      .from('movements')
      .select(`
        *,
        skus (id, description, unit),
        vendors (name)
      `)
      .eq('id', result.movement_id)
      .single();

    if (fetchError) throw fetchError;

    return mapMovementRowToUI(movement);

  } catch (error) {
    console.error('Error creating receive movement:', error);
    throw error;
  }
}

/**
 * Create ISSUE movement with FIFO consumption
 */
export async function createIssueMovement(params: {
  skuId: string;
  quantity: number;
  date: Date;
  reference?: string;
  notes?: string;
}): Promise<{ movement: MovementWithDetails; totalCost: number }> {
  try {
    // Calculate FIFO plan
    const fifoPlan = await calculateFIFOPlan(params.skuId, params.quantity);
    
    if (!fifoPlan.canFulfill) {
      throw new Error(`Insufficient inventory. Available: ${fifoPlan.totalQty}, Requested: ${params.quantity}`);
    }

    try {
      // Create movement record
      const movementData: MovementInsert = {
        type: 'ISSUE',
        sku_id: params.skuId,
        quantity: -params.quantity, // Negative for issues
        unit_cost: fifoPlan.totalCost / params.quantity, // Average cost
        total_value: -fifoPlan.totalCost, // Negative value
        datetime: params.date.toISOString(),
        reference: params.reference || `ISS-${Date.now()}`,
        notes: params.notes,
      };

      const { data: movement, error: movementError } = await supabase
        .from('movements')
        .insert(movementData)
        .select(`
          *,
          skus (id, description, unit),
          vendors (name)
        `)
        .single();

      if (movementError) throw movementError;

      // Execute FIFO consumption
      await executeFIFOConsumption(fifoPlan.plan, movement.id);

      // SKU on_hand is automatically updated by database trigger

      return {
        movement: mapMovementRowToUI(movement),
        totalCost: fifoPlan.totalCost,
      };

    } catch (error) {
      console.error('Error within createIssueMovement flow:', error);
      throw error;
    }
  } catch (error) {
    console.error('Error creating issue movement:', error);
    throw error;
  }
}

/**
 * Create WASTE movement with FIFO consumption
 */
export async function createWasteMovement(params: {
  skuId: string;
  quantity: number;
  date: Date;
  reference?: string;
  notes?: string;
}): Promise<{ movement: MovementWithDetails; totalCost: number }> {
  try {
    // Calculate FIFO plan
    const fifoPlan = await calculateFIFOPlan(params.skuId, params.quantity);
    
    if (!fifoPlan.canFulfill) {
      throw new Error(`Insufficient inventory. Available: ${fifoPlan.totalQty}, Requested: ${params.quantity}`);
    }

    try {
      // Create movement record
      const movementData: MovementInsert = {
        type: 'WASTE',
        sku_id: params.skuId,
        quantity: -params.quantity, // Negative for waste
        unit_cost: fifoPlan.totalCost / params.quantity, // Average cost
        total_value: -fifoPlan.totalCost, // Negative value
        datetime: params.date.toISOString(),
        reference: params.reference || `WST-${Date.now()}`,
        notes: params.notes,
      };

      const { data: movement, error: movementError } = await supabase
        .from('movements')
        .insert(movementData)
        .select(`
          *,
          skus (id, description, unit),
          vendors (name)
        `)
        .single();

      if (movementError) throw movementError;

      // Execute FIFO consumption
      await executeFIFOConsumption(fifoPlan.plan, movement.id);

      // SKU on_hand is automatically updated by database trigger

      return {
        movement: mapMovementRowToUI(movement),
        totalCost: fifoPlan.totalCost,
      };

    } catch (error) {
      console.error('Error within createWasteMovement flow:', error);
      throw error;
    }
  } catch (error) {
    console.error('Error creating waste movement:', error);
    throw error;
  }
}

/**
 * Create PRODUCE movement with FIFO layer creation
 */
export async function createProduceMovement(params: {
  skuId?: string;
  productName?: string;
  quantity: number;
  unitCost: number;
  date: Date;
  reference?: string;
  notes?: string;
}): Promise<MovementWithDetails> {
  try {
    try {
      // Create movement record
      const movementData: MovementInsert = {
        type: 'PRODUCE',
        sku_id: params.skuId || null,
        product_name: params.skuId ? null : (params.productName || 'Produced Item'),
        quantity: params.quantity,
        unit_cost: params.unitCost,
        total_value: params.quantity * params.unitCost,
        datetime: params.date.toISOString(),
        reference: params.reference || `PRD-${Date.now()}`,
        notes: params.notes,
      };

      const { data: movement, error: movementError } = await supabase
        .from('movements')
        .insert(movementData)
        .select(`
          *,
          skus (id, description, unit),
          vendors (name)
        `)
        .single();

      if (movementError) throw movementError;

      // Create FIFO layer for produced goods only when SKU is provided
      if (params.skuId) {
        const layerId = `L-${movement.id}-${params.skuId}`;
        await createFIFOLayer({
          id: layerId,
          skuId: params.skuId,
          receivingDate: params.date,
          quantity: params.quantity,
          unitCost: params.unitCost,
        });
      }

      // SKU on_hand is automatically updated by database trigger

      return mapMovementRowToUI(movement);

    } catch (error) {
      console.error('Error within createProduceMovement flow:', error);
      throw error;
    }
  } catch (error) {
    console.error('Error creating produce movement:', error);
    throw error;
  }
}

/**
 * Get movement by ID with details
 */
export async function getMovementById(id: number): Promise<MovementWithDetails | null> {
  try {
    const { data, error } = await supabase
      .from('movements')
      .select(`
        *,
        skus (id, description, unit),
        vendors (name)
      `)
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      handleSupabaseError(error);
    }

    return data ? mapMovementRowToUI(data) : null;
  } catch (error) {
    console.error('Error fetching movement by ID:', error);
    throw error;
  }
}

/**
 * Get movement deletion information (for confirmation dialogs)
 */
export async function getMovementDeletionInfo(movementId: number): Promise<{
  canDelete: boolean;
  movementType: MovementType;
  skuId: string;
  quantity: number;
  totalValue: number;
  reference: string;
  consumptions: Array<{
    layerId: string;
    quantityConsumed: number;
    unitCost: number;
    totalCost: number;
    layerRemaining: number;
    layerOriginal: number;
  }>;
  isReversed: boolean;
}> {
  const { data, error } = await supabase.rpc('get_movement_deletion_info', {
    p_movement_id: movementId
  });

  if (error) throw error;
  if (data?.error) throw new Error(data.error);

  return {
    canDelete: data.can_delete,
    movementType: data.type,
    skuId: data.sku_id,
    quantity: data.quantity,
    totalValue: data.total_value,
    reference: data.reference,
    consumptions: data.consumptions || [],
    isReversed: data.is_reversed
  };
}

/**
 * Reverse a movement (mark as reversed and restore FIFO layers)
 */
export async function reverseMovement(
  movementId: number, 
  options?: {
    reason?: string;
    deletedBy?: string;
  }
): Promise<{
  success: boolean;
  movementId: number;
  movementType: MovementType;
  restoredLayers: Array<{
    layerId: string;
    restoredQuantity?: number;
    remainingQuantity?: number;
    originalQuantity?: number;
    newRemaining?: number;
  }>;
  reversedAt: string;
  auditId: number;
}> {
  const { data, error } = await supabase.rpc('reverse_movement', {
    p_movement_id: movementId,
    p_deletion_reason: options?.reason || null,
    p_deleted_by: options?.deletedBy || 'system'
  });

  if (error) throw error;
  if (!data?.success) throw new Error('Failed to reverse movement');

  return {
    success: data.success,
    movementId: data.movement_id,
    movementType: data.movement_type,
    restoredLayers: data.restored_layers || [],
    reversedAt: data.reversed_at,
    auditId: data.audit_id
  };
}

/**
 * Delete a movement completely (reverse + delete record)
 */
export async function deleteMovement(
  movementId: number,
  options?: {
    reason?: string;
    deletedBy?: string;
  }
): Promise<{
  success: boolean;
  movementId: number;
  movementType: MovementType;
  restoredLayers: Array<{
    layerId: string;
    restoredQuantity?: number;
    remainingQuantity?: number;
    originalQuantity?: number;
    newRemaining?: number;
  }>;
  deleted: boolean;
  auditId: number;
  deletionAuditId: number;
}>{
  // First, determine type and reference
  const info = await getMovementDeletionInfo(movementId);

  // If PRODUCE, delete entire production group by reference
  if (info.movementType === 'PRODUCE') {
    const { data, error } = await supabase.rpc('delete_production_group', {
      p_reference: info.reference,
      p_deletion_reason: options?.reason || null,
      p_deleted_by: options?.deletedBy || 'system'
    });
    if (error) throw error;
    if (!data?.success) throw new Error('Failed to delete production group');

    return {
      success: true,
      movementId,
      movementType: info.movementType,
      restoredLayers: [],
      deleted: true,
      auditId: 0,
      deletionAuditId: 0,
    };
  }

  // Otherwise, delete single movement using existing RPC
  const { data, error } = await supabase.rpc('delete_movement', {
    p_movement_id: movementId,
    p_deletion_reason: options?.reason || null,
    p_deleted_by: options?.deletedBy || 'system'
  });

  if (error) throw error;
  if (!data?.success) throw new Error('Failed to delete movement');

  return {
    success: data.success,
    movementId: data.movement_id,
    movementType: data.movement_type,
    restoredLayers: data.restored_layers || [],
    deleted: data.deleted,
    auditId: data.audit_id,
    deletionAuditId: data.deletion_audit_id
  };
}
