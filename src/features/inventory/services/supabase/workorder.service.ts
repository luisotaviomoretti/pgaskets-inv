/**
 * Work Order Service - Supabase Implementation
 * Handles work order operations with multi-SKU RAW consumption and production
 */

import { supabase, handleSupabaseError } from '@/lib/supabase';
import type { Database } from '@/types/supabase';
import { calculateFIFOPlan, type FIFOPlanResult } from './fifo.service';

type WorkOrderRow = Database['public']['Tables']['work_orders']['Row'];

export interface RawMaterialLine {
  skuId: string;
  quantity: number;
}

export interface WasteLine {
  skuId: string;
  quantity: number;
}

export interface WorkOrderParams {
  outputName: string; // free-text finished product name
  outputSkuId?: string; // optional SELLABLE SKU
  outputQuantity: number;
  rawMaterials: RawMaterialLine[];
  wasteLines: WasteLine[];
  date: Date;
  reference?: string;
  notes?: string;
}

export interface MultiSKUFIFOPlan {
  skuId: string;
  requestedQty: number;
  plan: FIFOPlanResult;
}

export interface WorkOrderResult {
  workOrderId: string;
  totalRawCost: number;
  totalWasteCost: number;
  outputUnitCost: number;
  rawPlans: MultiSKUFIFOPlan[];
  wastePlans: MultiSKUFIFOPlan[];
}

/**
 * Calculate multi-SKU FIFO plans for work order
 */
export async function calculateWorkOrderFIFOPlans(
  rawMaterials: RawMaterialLine[],
  wasteLines: WasteLine[]
): Promise<{
  rawPlans: MultiSKUFIFOPlan[];
  wastePlans: MultiSKUFIFOPlan[];
  totalRawCost: number;
  totalWasteCost: number;
  canFulfill: boolean;
  insufficientSKUs: string[];
}> {
  try {
    const rawPlans: MultiSKUFIFOPlan[] = [];
    const wastePlans: MultiSKUFIFOPlan[] = [];
    let totalRawCost = 0;
    let totalWasteCost = 0;
    const insufficientSKUs: string[] = [];

    // Calculate RAW material plans
    for (const raw of rawMaterials) {
      const plan = await calculateFIFOPlan(raw.skuId, raw.quantity);
      rawPlans.push({
        skuId: raw.skuId,
        requestedQty: raw.quantity,
        plan,
      });
      
      if (!plan.canFulfill) {
        insufficientSKUs.push(raw.skuId);
      }
      
      totalRawCost += plan.totalCost;
    }

    // Calculate WASTE plans
    for (const waste of wasteLines) {
      if (waste.quantity > 0) {
        const plan = await calculateFIFOPlan(waste.skuId, waste.quantity);
        wastePlans.push({
          skuId: waste.skuId,
          requestedQty: waste.quantity,
          plan,
        });
        
        totalWasteCost += plan.totalCost;
      }
    }

    return {
      rawPlans,
      wastePlans,
      totalRawCost,
      totalWasteCost,
      canFulfill: insufficientSKUs.length === 0,
      insufficientSKUs,
    };
  } catch (error) {
    console.error('Error calculating work order FIFO plans:', error);
    throw error;
  }
}

/**
 * Create and execute work order with multi-SKU processing using transactional RPC
 */
export async function createWorkOrder(params: WorkOrderParams): Promise<WorkOrderResult> {
  try {
    // Prepare materials array for RPC
    const materials = params.rawMaterials.map(raw => ({
      sku_id: raw.skuId,
      quantity: raw.quantity,
      type: 'ISSUE'
    }));

    // Add waste materials (if any)
    const wasteMaterials = params.wasteLines
      .filter(waste => waste.quantity > 0)
      .map(waste => ({
        sku_id: waste.skuId,
        quantity: waste.quantity,
        type: 'WASTE'
      }));

    // Combine all materials for consumption
    const allMaterials = [...materials, ...wasteMaterials];

    console.log('Creating work order with transactional RPC:', {
      outputName: params.outputName,
      outputQuantity: params.outputQuantity,
      materials: allMaterials
    });

    // Call transactional RPC
    const rpcParams = {
      p_output_name: params.outputName,
      p_output_quantity: params.outputQuantity,
      p_output_unit: 'unit',
      p_mode: 'AUTO',
      p_client_name: null,
      p_invoice_no: params.reference || null,
      p_notes: params.notes || null,
      p_materials: allMaterials
    };

    console.log('RPC parameters:', rpcParams);

    const { data: result, error } = await supabase.rpc('create_work_order_transaction', rpcParams);

    if (error) {
      console.error('Error creating work order via RPC:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
      throw error;
    }

    if (!result?.success) {
      throw new Error('Work order creation failed');
    }

    console.log('Work order created successfully:', result);

    // Calculate plans for return data (for UI compatibility)
    const fifoPlans = await calculateWorkOrderFIFOPlans(params.rawMaterials, params.wasteLines);

    return {
      workOrderId: result.work_order_id,
      totalRawCost: result.total_cost || fifoPlans.totalRawCost,
      totalWasteCost: fifoPlans.totalWasteCost,
      outputUnitCost: (result.total_cost || fifoPlans.totalRawCost) / params.outputQuantity,
      rawPlans: fifoPlans.rawPlans,
      wastePlans: fifoPlans.wastePlans,
    };

  } catch (error) {
    console.error('Error creating work order:', error);
    throw error;
  }
}

/**
 * Get work orders with filtering
 */
export async function getWorkOrders(filters?: {
  outputSkuId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ workOrders: WorkOrderRow[]; total: number }> {
  try {
    let query = supabase
      .from('work_orders')
      .select('*', { count: 'exact' });

    // Apply filters
    if (filters?.outputSkuId) {
      query = query.eq('output_sku_id', filters.outputSkuId);
    }
    
    if (filters?.dateFrom) {
      query = query.gte('work_order_date', filters.dateFrom.toISOString().split('T')[0]);
    }
    
    if (filters?.dateTo) {
      query = query.lte('work_order_date', filters.dateTo.toISOString().split('T')[0]);
    }
    
    if (filters?.status) {
      query = query.eq('status', filters.status);
    }

    // Apply pagination
    if (filters?.limit) {
      query = query.limit(filters.limit);
    }
    
    if (filters?.offset) {
      query = query.range(filters.offset, (filters.offset + (filters?.limit || 50)) - 1);
    }

    // Order by date desc
    query = query.order('work_order_date', { ascending: false })
                  .order('created_at', { ascending: false });

    const { data, error, count } = await query;

    if (error) {
      handleSupabaseError(error);
    }

    return {
      workOrders: data || [],
      total: count || 0,
    };
  } catch (error) {
    console.error('Error fetching work orders:', error);
    throw error;
  }
}

/**
 * Get work order details with lines
 */
export async function getWorkOrderById(id: string) {
  try {
    const { data: workOrder, error: woError } = await supabase
      .from('work_orders')
      .select(`
        *,
        skus (id, description, unit)
      `)
      .eq('id', id)
      .single();

    if (woError) {
      if (woError.code === 'PGRST116') {
        return null;
      }
      handleSupabaseError(woError);
    }

    const { data: lines, error: linesError } = await supabase
      .from('work_order_lines')
      .select(`
        *,
        skus (id, description, unit),
        movements (id, type, datetime)
      `)
      .eq('work_order_id', id)
      .order('type')
      .order('created_at');

    if (linesError) {
      handleSupabaseError(linesError);
    }

    return {
      workOrder,
      lines: lines || [],
    };
  } catch (error) {
    console.error('Error fetching work order details:', error);
    throw error;
  }
}
