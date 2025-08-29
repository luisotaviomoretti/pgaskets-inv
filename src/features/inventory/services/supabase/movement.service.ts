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
import { 
  canDeleteReceivingMovement,
  type DeleteValidationResult 
} from './movement-delete-validation.service';

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
  includeDeleted?: boolean;
}): Promise<{ movements: MovementWithDetails[]; total: number }> {
  try {
    // Use the new stored procedure for consistent filtering
    const { data, error } = await supabase.rpc('get_movements_filtered', {
      p_sku_id: filters?.skuId || null,
      p_type: filters?.type || null,
      p_date_from: filters?.dateFrom?.toISOString() || null,
      p_date_to: filters?.dateTo?.toISOString() || null,
      p_include_deleted: filters?.includeDeleted || false,
      p_limit: filters?.limit || 100,
      p_offset: filters?.offset || 0
    });

    if (error) throw error;

    const movements = (data || []).map((row: any) => ({
      id: toMovementId(row.id.toString()),
      date: new Date(row.datetime),
      type: row.type as MovementType,
      skuId: row.sku_id || '',
      skuDescription: row.sku_description || row.product_name || row.sku_id || '',
      unit: row.sku_unit || 'unit',
      quantity: row.quantity,
      unitCost: row.unit_cost || 0,
      totalCost: row.total_value || 0,
      vendor: row.vendor_name,
      reference: row.reference,
      notes: row.notes || undefined,
      deletedAt: row.deleted_at ? new Date(row.deleted_at) : undefined,
      deletedBy: row.deleted_by || undefined,
      deletionReason: row.deletion_reason || undefined,
    }));

    // Get total count separately for pagination
    const { count } = await supabase
      .from('movements')
      .select('*', { count: 'exact', head: true })
      .is('deleted_at', filters?.includeDeleted ? undefined : null);

    return { movements, total: count || 0 };
  } catch (error) {
    console.error('Error fetching movements:', error);
    throw error;
  }
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
 * Create DAMAGE movement (similar to WASTE but with different semantic context)
 */
export async function createDamageMovement(params: {
  skuId: string;
  quantity: number;
  unitCost?: number;
  date: Date;
  reference?: string;
  notes?: string;
  generalNotes?: string;
  damageNotes?: string;
}): Promise<{ movement: MovementWithDetails; totalCost: number }> {
  try {
    // Get SKU to use last cost or default cost
    const { data: sku, error: skuError } = await supabase
      .from('skus')
      .select('last_cost, average_cost')
      .eq('id', params.skuId)
      .single();
      
    if (skuError) throw skuError;
    
    // Use provided unit cost, or fall back to last_cost, then average_cost, then 0
    const unitCost = params.unitCost || sku.last_cost || sku.average_cost || 0;
    const totalCost = params.quantity * unitCost;

    try {
      // Combine all notes into a single notes field
      const allNotes = [params.generalNotes, params.damageNotes, params.notes]
        .filter(note => note?.trim())
        .join(' | ');

      // Create movement record - DAMAGE doesn't consume inventory, just tracks rejected items
      const movementData: MovementInsert = {
        type: 'DAMAGE',
        sku_id: params.skuId,
        quantity: -params.quantity, // Negative for damage
        unit_cost: unitCost,
        total_value: -totalCost, // Negative value
        datetime: params.date.toISOString(),
        reference: params.reference || `DMG-${Date.now()}`,
        notes: allNotes || null,
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

      // NO FIFO CONSUMPTION for DAMAGE - these items were never added to inventory
      // DAMAGE movements just track rejected items during receiving

      return {
        movement: mapMovementRowToUI(movement),
        totalCost: totalCost,
      };

    } catch (error) {
      console.error('Error within createDamageMovement flow:', error);
      throw error;
    }
  } catch (error) {
    console.error('Error creating damage movement:', error);
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
 * Create ADJUSTMENT movement for FIFO layer quantity adjustments
 */
export async function createAdjustmentMovement(params: {
  skuId: string;
  layerId: string;
  quantity: number; // Can be positive (increase) or negative (decrease)
  date: Date;
  reference?: string;
  reason: string; // Mandatory adjustment reason
  notes?: string;
  adjustedBy?: string;
}): Promise<MovementWithDetails> {
  try {
    // Import FIFO functions
    const { adjustLayerQuantity, getLayerAdjustmentInfo } = await import('./fifo.service');
    
    // Validate layer can be adjusted
    const layerInfo = await getLayerAdjustmentInfo(params.layerId);
    
    if (!layerInfo.canAdjust) {
      throw new Error(`Cannot adjust layer ${params.layerId}: status=${layerInfo.status}, remaining=${layerInfo.remaining}`);
    }

    if (layerInfo.skuId !== params.skuId) {
      throw new Error(`Layer ${params.layerId} belongs to SKU ${layerInfo.skuId}, not ${params.skuId}`);
    }

    // Validate adjustment quantity
    if (params.quantity === 0) {
      throw new Error('Adjustment quantity cannot be zero');
    }

    if (params.quantity < 0 && Math.abs(params.quantity) > layerInfo.remaining) {
      throw new Error(
        `Insufficient quantity in layer: available=${layerInfo.remaining}, requested=${Math.abs(params.quantity)}`
      );
    }

    try {
      // Create movement record first
      const adjustmentValue = params.quantity * layerInfo.cost;
      const movementData: MovementInsert = {
        type: 'ADJUSTMENT',
        sku_id: params.skuId,
        quantity: params.quantity, // Positive for increases, negative for decreases
        unit_cost: layerInfo.cost,
        total_value: adjustmentValue,
        datetime: params.date.toISOString(),
        reference: params.reference || `ADJ-${Date.now()}-${params.layerId}`,
        notes: `Layer Adjustment: ${params.reason}${params.notes ? ` | ${params.notes}` : ''}`,
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

      // Adjust the specific FIFO layer
      const adjustmentResult = await adjustLayerQuantity(
        params.layerId,
        params.quantity,
        params.reason,
        params.adjustedBy
      );

      if (!adjustmentResult.success) {
        throw new Error('Failed to adjust layer quantity');
      }

      return mapMovementRowToUI(movement);

    } catch (error) {
      console.error('Error within createAdjustmentMovement flow:', error);
      throw error;
    }
  } catch (error) {
    console.error('Error creating adjustment movement:', error);
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
 * Check if a movement can be safely reversed
 */
export async function canReverseMovement(movementId: number): Promise<{
  canReverse: boolean;
  reason: string;
  currentStock?: number;
  requiredQuantity?: number;
  remainingAfterReversal?: number;
}> {
  const { data, error } = await supabase.rpc('can_reverse_movement', {
    p_movement_id: movementId
  });

  if (error) throw error;

  return {
    canReverse: data.can_reverse,
    reason: data.reason,
    currentStock: data.current_stock,
    requiredQuantity: data.movement_quantity,
    remainingAfterReversal: data.remaining_after_reversal
  };
}

/**
 * Validate Work Order state
 */
export async function validateWorkOrderState(reference: string): Promise<{
  reference: string;
  isValid: boolean;
  canDelete: boolean;
  canRestore: boolean;
  hasProduce: boolean;
  hasIssue: boolean;
  hasWaste: boolean;
  activeCount: number;
  deletedCount: number;
  issues: Array<{ type: string; message: string }>;
  movements: Array<any>;
}> {
  const { data, error } = await supabase.rpc('validate_work_order_state', {
    p_reference: reference
  });

  if (error) throw error;

  return {
    reference: data.reference,
    isValid: data.is_valid,
    canDelete: data.can_delete,
    canRestore: data.can_restore,
    hasProduce: data.has_produce,
    hasIssue: data.has_issue,
    hasWaste: data.has_waste,
    activeCount: data.active_count,
    deletedCount: data.deleted_count,
    issues: data.issues || [],
    movements: data.movements || []
  };
}

/**
 * Delete Work Order atomically
 */
export async function deleteWorkOrderAtomic(
  reference: string,
  options?: {
    reason?: string;
    deletedBy?: string;
  }
): Promise<{
  success: boolean;
  reference: string;
  deletedMovementsCount: number;
  affectedSkus: string[];
  deletedMovements: Array<any>;
}> {
  const { data, error } = await supabase.rpc('delete_work_order_atomic', {
    p_reference: reference,
    p_deletion_reason: options?.reason || null,
    p_deleted_by: options?.deletedBy || 'system'
  });

  if (error) throw error;
  if (!data?.success) throw new Error('Failed to delete Work Order atomically');

  return {
    success: data.success,
    reference: data.reference,
    deletedMovementsCount: data.deleted_movements_count,
    affectedSkus: data.affected_skus || [],
    deletedMovements: data.deleted_movements || []
  };
}

/**
 * Restore Work Order atomically
 */
export async function restoreWorkOrderAtomic(
  reference: string,
  restoredBy?: string
): Promise<{
  success: boolean;
  reference: string;
  restoredMovementsCount: number;
  affectedSkus: string[];
  restoredMovements: Array<any>;
}> {
  const { data, error } = await supabase.rpc('restore_work_order_atomic', {
    p_reference: reference,
    p_restored_by: restoredBy || 'system'
  });

  if (error) throw error;
  if (!data?.success) throw new Error('Failed to restore Work Order atomically');

  return {
    success: data.success,
    reference: data.reference,
    restoredMovementsCount: data.restored_movements_count,
    affectedSkus: data.affected_skus || [],
    restoredMovements: data.restored_movements || []
  };
}

/**
 * Diagnose Work Order integrity
 */
export async function diagnoseWorkOrderIntegrity(reference: string): Promise<{
  reference: string;
  validation: any;
  skuIntegrity: Array<{
    skuId: string;
    skuOnHand: number;
    layerTotal: number;
    isSynchronized: boolean;
    difference: number;
  }>;
  overallIntegrity: boolean;
}> {
  const { data, error } = await supabase.rpc('diagnose_work_order_integrity', {
    p_reference: reference
  });

  if (error) throw error;

  return {
    reference: data.reference,
    validation: data.validation,
    skuIntegrity: data.sku_integrity || [],
    overallIntegrity: data.overall_integrity
  };
}

/**
 * Repair SKU integrity
 */
export async function repairSkuIntegrity(skuId: string): Promise<{
  skuId: string;
  oldOnHand: number;
  layerTotal: number;
  newOnHand: number;
  wasRepaired: boolean;
  isNowSynchronized: boolean;
}> {
  const { data, error } = await supabase.rpc('repair_sku_integrity', {
    p_sku_id: skuId
  });

  if (error) throw error;

  return {
    skuId: data.sku_id,
    oldOnHand: data.old_on_hand,
    layerTotal: data.layer_total,
    newOnHand: data.new_on_hand,
    wasRepaired: data.was_repaired,
    isNowSynchronized: data.is_now_synchronized
  };
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
 * Soft delete a movement (with FIFO validation for RECEIVE movements)
 */
export async function softDeleteMovement(
  movementId: number,
  options?: {
    reason?: string;
    deletedBy?: string;
    bypassValidation?: boolean; // For admin overrides
  }
): Promise<{
  success: boolean;
  movementId: number;
  movementType: MovementType;
  deletedAt: string;
  deletedBy: string;
  deletionReason?: string;
  validationResult?: DeleteValidationResult;
}> {
  try {
    // Validate RECEIVE movements unless bypassed
    let validationResult: DeleteValidationResult | undefined;
    
    if (!options?.bypassValidation) {
      validationResult = await canDeleteReceivingMovement(movementId);
      
      if (!validationResult.canDelete) {
        throw new Error(
          `Cannot delete movement: ${validationResult.reason}\n` +
          `This would cause data inconsistency. ` +
          (validationResult.workOrdersAffected?.length 
            ? `Affected Work Orders: ${validationResult.workOrdersAffected.join(', ')}`
            : '')
        );
      }
    }

    // Proceed with deletion
    const { data, error } = await supabase.rpc('soft_delete_movement', {
      p_movement_id: movementId,
      p_deletion_reason: options?.reason || null,
      p_deleted_by: options?.deletedBy || 'system'
    });

    if (error) throw error;
    if (!data?.success) throw new Error('Failed to soft delete movement');

    return {
      success: data.success,
      movementId: data.movement_id,
      movementType: data.movement_type,
      deletedAt: data.deleted_at,
      deletedBy: data.deleted_by,
      deletionReason: data.deletion_reason,
      validationResult
    };

  } catch (error) {
    console.error('Error in softDeleteMovement:', error);
    throw error;
  }
}

/**
 * Restore a soft deleted movement
 */
export async function restoreMovement(
  movementId: number,
  restoredBy?: string
): Promise<{
  success: boolean;
  movementId: number;
  movementType: MovementType;
  restoredAt: string;
  restoredBy: string;
}> {
  const { data, error } = await supabase.rpc('restore_movement', {
    p_movement_id: movementId,
    p_restored_by: restoredBy || 'system'
  });

  if (error) throw error;
  if (!data?.success) throw new Error('Failed to restore movement');

  return {
    success: data.success,
    movementId: data.movement_id,
    movementType: data.movement_type,
    restoredAt: data.restored_at,
    restoredBy: data.restored_by
  };
}

/**
 * Delete a movement (now uses soft delete by default)
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
  restoredLayers?: Array<{
    layerId: string;
    restoredQuantity?: number;
    remainingQuantity?: number;
    originalQuantity?: number;
    newRemaining?: number;
  }>;
  deleted: boolean;
  deletedAt?: string;
  auditId?: number;
  deletionAuditId?: number;
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

  // Otherwise, delete single movement using soft delete RPC
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
