/**
 * Work Order Validation Utilities
 * Critical integrity checks for Work Order calculations
 */

import { supabase } from '@/lib/supabase';

export interface WorkOrderValidationResult {
  workOrderId: string;
  isValid: boolean;
  discrepancy: number;
  expectedProduceValue: number;
  actualProduceValue: number;
  issues: string[];
  movements: MovementValidation[];
}

export interface MovementValidation {
  id: number;
  type: string;
  skuId?: string;
  quantity: number;
  movementValue: number;
  layerConsumptionTotal: number;
  discrepancy: number;
  isValid: boolean;
}

/**
 * Validate a specific Work Order's financial integrity
 */
export async function validateWorkOrder(workOrderId: string): Promise<WorkOrderValidationResult> {
  try {
    // Get all movements for this work order
    const { data: movements, error: movError } = await supabase
      .from('movements')
      .select('id, type, sku_id, quantity, unit_cost, total_value')
      .eq('work_order_id', workOrderId)
      .is('deleted_at', null);

    if (movError) throw movError;

    const issues: string[] = [];
    const movementValidations: MovementValidation[] = [];
    let totalIssueValue = 0;
    let actualProduceValue = 0;

    // Validate each movement
    for (const movement of movements || []) {
      if (movement.type === 'PRODUCE') {
        actualProduceValue = movement.total_value;
        movementValidations.push({
          id: movement.id,
          type: movement.type,
          quantity: movement.quantity,
          movementValue: movement.total_value,
          layerConsumptionTotal: 0, // PRODUCE doesn't have layer consumptions
          discrepancy: 0,
          isValid: true,
        });
        continue;
      }

      if (movement.type === 'ISSUE' || movement.type === 'WASTE') {
        // Get layer consumptions for this movement
        const { data: consumptions, error: consError } = await supabase
          .from('layer_consumptions')
          .select('total_cost')
          .eq('movement_id', movement.id)
          .is('deleted_at', null);

        if (consError) throw consError;

        const layerConsumptionTotal = consumptions?.reduce((sum, c) => sum + c.total_cost, 0) || 0;
        const movementValueAbs = Math.abs(movement.total_value);
        const discrepancy = Math.abs(movementValueAbs - layerConsumptionTotal);

        totalIssueValue += layerConsumptionTotal;

        const isMovementValid = discrepancy < 0.01; // 1 cent tolerance
        
        if (!isMovementValid) {
          issues.push(`Movement ${movement.id} (${movement.type}) has cost mismatch: movement=${movementValueAbs}, layers=${layerConsumptionTotal}`);
        }

        movementValidations.push({
          id: movement.id,
          type: movement.type,
          skuId: movement.sku_id,
          quantity: movement.quantity,
          movementValue: movementValueAbs,
          layerConsumptionTotal,
          discrepancy,
          isValid: isMovementValid,
        });
      }
    }

    // Calculate overall discrepancy
    const expectedProduceValue = totalIssueValue;
    const overallDiscrepancy = Math.abs(actualProduceValue - expectedProduceValue);
    const isValid = overallDiscrepancy < 0.01 && issues.length === 0;

    if (overallDiscrepancy >= 0.01) {
      issues.push(`PRODUCE value mismatch: expected=${expectedProduceValue}, actual=${actualProduceValue}`);
    }

    return {
      workOrderId,
      isValid,
      discrepancy: overallDiscrepancy,
      expectedProduceValue,
      actualProduceValue,
      issues,
      movements: movementValidations,
    };

  } catch (error) {
    console.error('Error validating work order:', error);
    throw error;
  }
}

/**
 * Repair a Work Order's cost calculations
 */
export async function repairWorkOrder(workOrderId: string): Promise<any> {
  try {
    const { data, error } = await supabase.rpc('repair_work_order_costs', {
      p_work_order_id: workOrderId
    });

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error repairing work order:', error);
    throw error;
  }
}

/**
 * Validate all Work Orders in the system
 */
export async function validateAllWorkOrders(): Promise<any> {
  try {
    const { data, error } = await supabase.rpc('validate_all_work_orders');
    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error validating all work orders:', error);
    throw error;
  }
}

/**
 * Get detailed analysis of a Work Order's movements
 */
export async function analyzeWorkOrderMovements(workOrderId: string): Promise<any> {
  try {
    const { data, error } = await supabase.rpc('analyze_work_order_movements', {
      p_work_order_id: workOrderId
    });

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error analyzing work order movements:', error);
    throw error;
  }
}

/**
 * Validate FIFO layer integrity across the entire system
 */
export async function validateFIFOIntegrity(): Promise<any> {
  try {
    const { data, error } = await supabase.rpc('validate_fifo_layer_integrity');
    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error validating FIFO integrity:', error);
    throw error;
  }
}

/**
 * Check if a Work Order can be created with the given materials
 */
export interface WorkOrderFeasibilityCheck {
  canCreate: boolean;
  totalRawCost: number;
  totalWasteCost: number;
  netProduceCost: number;
  insufficientSKUs: string[];
  details: Array<{
    skuId: string;
    requestedQty: number;
    availableQty: number;
    canFulfill: boolean;
    estimatedCost: number;
  }>;
}

export async function checkWorkOrderFeasibility(
  materials: Array<{ skuId: string; quantity: number; type?: 'ISSUE' | 'WASTE' }>
): Promise<WorkOrderFeasibilityCheck> {
  try {
    let totalRawCost = 0;
    let totalWasteCost = 0;
    const insufficientSKUs: string[] = [];
    const details = [];

    for (const material of materials) {
      // Get available quantity and calculate cost
      const { data: layers, error } = await supabase
        .from('fifo_layers')
        .select('remaining_quantity, unit_cost')
        .eq('sku_id', material.skuId)
        .eq('status', 'ACTIVE')
        .gt('remaining_quantity', 0)
        .order('receiving_date')
        .order('created_at');

      if (error) throw error;

      const totalAvailable = layers?.reduce((sum, layer) => sum + layer.remaining_quantity, 0) || 0;
      const canFulfill = totalAvailable >= material.quantity;

      if (!canFulfill) {
        insufficientSKUs.push(material.skuId);
      }

      // Calculate estimated cost using FIFO
      let remainingNeeded = material.quantity;
      let estimatedCost = 0;

      for (const layer of layers || []) {
        if (remainingNeeded <= 0) break;
        
        const consumeQty = Math.min(remainingNeeded, layer.remaining_quantity);
        estimatedCost += consumeQty * layer.unit_cost;
        remainingNeeded -= consumeQty;
      }

      if (material.type === 'WASTE') {
        totalWasteCost += estimatedCost;
      } else {
        totalRawCost += estimatedCost;
      }

      details.push({
        skuId: material.skuId,
        requestedQty: material.quantity,
        availableQty: totalAvailable,
        canFulfill,
        estimatedCost,
      });
    }

    return {
      canCreate: insufficientSKUs.length === 0,
      totalRawCost,
      totalWasteCost,
      netProduceCost: totalRawCost - totalWasteCost,
      insufficientSKUs,
      details,
    };

  } catch (error) {
    console.error('Error checking work order feasibility:', error);
    throw error;
  }
}