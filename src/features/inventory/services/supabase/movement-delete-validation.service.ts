/**
 * Movement Delete Validation Service
 * Prevents deletion of RECEIVE movements that have created consumed FIFO layers
 * 
 * This service protects against data corruption that would occur if a user
 * deletes a receiving movement after its FIFO layers have been consumed
 * by Work Orders.
 */

import { supabase, handleSupabaseError } from '@/lib/supabase';

export interface DeleteValidationResult {
  canDelete: boolean;
  reason?: string;
  affectedLayers?: LayerConsumptionInfo[];
  totalConsumed?: number;
  totalRemaining?: number;
  workOrdersAffected?: string[];
}

export interface LayerConsumptionInfo {
  layerId: string;
  skuId: string;
  originalQuantity: number;
  remainingQuantity: number;
  consumedQuantity: number;
  unitCost: number;
  consumedValue: number;
}

export interface BulkDeleteValidationResult {
  allowed: number[];
  blocked: Array<{
    movementId: number;
    reason: string;
    affectedLayers: LayerConsumptionInfo[];
    workOrdersAffected: string[];
  }>;
  summary: {
    totalMovements: number;
    allowedCount: number;
    blockedCount: number;
  };
}

/**
 * Check if a RECEIVE movement can be safely deleted
 * 
 * @param movementId - ID of the movement to validate
 * @returns Promise<DeleteValidationResult>
 */
export async function canDeleteReceivingMovement(movementId: number): Promise<DeleteValidationResult> {
  try {
    // First, verify this is actually a RECEIVE movement
    const { data: movement, error: movementError } = await supabase
      .from('movements')
      .select('id, type, sku_id, quantity, total_value')
      .eq('id', movementId)
      .is('deleted_at', null)
      .single();

    if (movementError) {
      if (movementError.code === 'PGRST116') {
        return {
          canDelete: false,
          reason: 'Movement not found or already deleted'
        };
      }
      throw movementError;
    }

    if (movement.type !== 'RECEIVE') {
      return {
        canDelete: false,
        reason: `Invalid movement type: ${movement.type}. Only RECEIVE movements are validated.`
      };
    }

    // Find FIFO layers created by this movement
    const { data: layers, error: layersError } = await supabase
      .from('fifo_layers')
      .select('id, sku_id, original_quantity, remaining_quantity, unit_cost, status')
      .eq('created_by_movement_id', movementId)
      .eq('status', 'ACTIVE');

    if (layersError) {
      throw layersError;
    }

    if (!layers || layers.length === 0) {
      return {
        canDelete: true,
        reason: 'No FIFO layers found - safe to delete'
      };
    }

    // Check each layer for consumption
    const affectedLayers: LayerConsumptionInfo[] = [];
    const workOrdersAffected = new Set<string>();
    let totalConsumed = 0;
    let totalRemaining = 0;

    for (const layer of layers) {
      const consumedQuantity = layer.original_quantity - layer.remaining_quantity;
      
      if (consumedQuantity > 0) {
        // Get work orders that consumed from this layer
        const { data: consumptions, error: consumptionsError } = await supabase
          .from('layer_consumptions')
          .select(`
            quantity_consumed,
            total_cost,
            movement_id,
            movements!inner (
              work_order_id,
              type,
              reference
            )
          `)
          .eq('layer_id', layer.id)
          .is('deleted_at', null);

        if (consumptionsError) {
          throw consumptionsError;
        }

        // Collect unique work orders
        consumptions?.forEach(consumption => {
          if (consumption.movements?.work_order_id) {
            workOrdersAffected.add(consumption.movements.work_order_id);
          }
        });

        affectedLayers.push({
          layerId: layer.id,
          skuId: layer.sku_id,
          originalQuantity: layer.original_quantity,
          remainingQuantity: layer.remaining_quantity,
          consumedQuantity,
          unitCost: layer.unit_cost,
          consumedValue: consumedQuantity * layer.unit_cost
        });

        totalConsumed += consumedQuantity;
      }
      
      totalRemaining += layer.remaining_quantity;
    }

    // If any layers have been consumed, block deletion
    if (affectedLayers.length > 0) {
      return {
        canDelete: false,
        reason: `Cannot delete: ${affectedLayers.length} FIFO layer(s) have been consumed by Work Orders`,
        affectedLayers,
        totalConsumed,
        totalRemaining,
        workOrdersAffected: Array.from(workOrdersAffected)
      };
    }

    return {
      canDelete: true,
      reason: 'All FIFO layers are unused - safe to delete',
      totalRemaining
    };

  } catch (error) {
    console.error('Error validating movement deletion:', error);
    handleSupabaseError(error);
    
    return {
      canDelete: false,
      reason: 'Error occurred during validation - deletion blocked for safety'
    };
  }
}

/**
 * Validate multiple RECEIVE movements for bulk deletion
 * 
 * @param movementIds - Array of movement IDs to validate
 * @returns Promise<BulkDeleteValidationResult>
 */
export async function validateBulkReceivingDelete(
  movementIds: number[]
): Promise<BulkDeleteValidationResult> {
  const allowed: number[] = [];
  const blocked: BulkDeleteValidationResult['blocked'] = [];

  for (const movementId of movementIds) {
    try {
      const validation = await canDeleteReceivingMovement(movementId);
      
      if (validation.canDelete) {
        allowed.push(movementId);
      } else {
        blocked.push({
          movementId,
          reason: validation.reason || 'Cannot delete',
          affectedLayers: validation.affectedLayers || [],
          workOrdersAffected: validation.workOrdersAffected || []
        });
      }
    } catch (error) {
      console.error(`Error validating movement ${movementId}:`, error);
      blocked.push({
        movementId,
        reason: 'Validation error - blocked for safety',
        affectedLayers: [],
        workOrdersAffected: []
      });
    }
  }

  return {
    allowed,
    blocked,
    summary: {
      totalMovements: movementIds.length,
      allowedCount: allowed.length,
      blockedCount: blocked.length
    }
  };
}

/**
 * Get detailed consumption information for a RECEIVE movement
 * Useful for showing users exactly why a deletion is blocked
 * 
 * @param movementId - ID of the RECEIVE movement
 * @returns Promise with detailed consumption breakdown
 */
export async function getReceivingConsumptionDetails(movementId: number) {
  try {
    const validation = await canDeleteReceivingMovement(movementId);
    
    if (validation.canDelete || !validation.affectedLayers) {
      return {
        hasConsumptions: false,
        details: []
      };
    }

    // Get detailed consumption breakdown per work order
    const consumptionDetails = [];

    for (const layer of validation.affectedLayers) {
      const { data: consumptions, error } = await supabase
        .from('layer_consumptions')
        .select(`
          quantity_consumed,
          total_cost,
          created_at,
          movements!inner (
            id,
            work_order_id,
            type,
            reference,
            work_orders (
              output_name,
              output_quantity,
              completed_at
            )
          )
        `)
        .eq('layer_id', layer.layerId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });

      if (error) throw error;

      consumptionDetails.push({
        layer,
        consumptions: consumptions?.map(c => ({
          movementId: c.movements?.id,
          workOrderId: c.movements?.work_order_id,
          workOrderName: c.movements?.work_orders?.output_name,
          quantityConsumed: c.quantity_consumed,
          cost: c.total_cost,
          consumedAt: c.created_at,
          completedAt: c.movements?.work_orders?.completed_at
        })) || []
      });
    }

    return {
      hasConsumptions: true,
      totalConsumed: validation.totalConsumed,
      totalValue: validation.affectedLayers.reduce((sum, layer) => sum + layer.consumedValue, 0),
      workOrdersCount: validation.workOrdersAffected?.length || 0,
      details: consumptionDetails
    };

  } catch (error) {
    console.error('Error getting consumption details:', error);
    throw error;
  }
}

/**
 * Quick check if a movement can be deleted (lightweight version)
 * Returns only boolean result for performance-critical scenarios
 * 
 * @param movementId - ID of the movement to check
 * @returns Promise<boolean>
 */
export async function canDeleteMovementQuick(movementId: number): Promise<boolean> {
  try {
    // Quick check using optimized query
    const { data, error } = await supabase
      .from('movements')
      .select(`
        type,
        fifo_layers!created_by_movement_id (
          id,
          original_quantity,
          remaining_quantity
        )
      `)
      .eq('id', movementId)
      .is('deleted_at', null)
      .single();

    if (error || !data) return false;
    if (data.type !== 'RECEIVE') return false;

    // Check if any layer has been consumed
    const hasConsumedLayers = data.fifo_layers?.some(
      (layer: any) => layer.remaining_quantity < layer.original_quantity
    );

    return !hasConsumedLayers;

  } catch (error) {
    console.error('Error in quick delete check:', error);
    return false; // Fail safe - block deletion on error
  }
}