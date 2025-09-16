/**
 * Work Order Service - Supabase Implementation
 * Handles work order operations with multi-SKU RAW consumption and production
 */

import { supabase, handleSupabaseError } from '@/lib/supabase';
import type { Database } from '@/types/supabase';
import { calculateFIFOPlan, type FIFOPlanResult } from './fifo.service';
// Temporarily commented out to avoid import conflicts
// import { 
//   validateWorkOrder, 
//   checkWorkOrderFeasibility
// } from '@/features/inventory/utils/work-order-validation';
// import type { WorkOrderValidationResult } from '@/features/inventory/utils/work-order-validation';

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
  // validation?: WorkOrderValidationResult; // Temporarily disabled
}

// ------------------------------
// Concurrency helpers (Retry & Idempotency)
// ------------------------------
const RETRIABLE_PG_CODES = new Set(['40001', '40P01', '55P03']);

function isRetriableError(err: any): boolean {
  const code = err?.code || err?.details || err?.hint;
  const msg = String(err?.message || err?.details || '').toLowerCase();
  return (
    (code && RETRIABLE_PG_CODES.has(code)) ||
    msg.includes('could not serialize') ||
    msg.includes('deadlock') ||
    msg.includes('lock not available')
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpcWithRetry<T>(exec: () => Promise<{ data: T | null; error: any }>, maxRetries = 3, baseDelayMs = 100): Promise<T> {
  let attempt = 0;
  let lastError: any = null;
  while (attempt < maxRetries) {
    const { data, error } = await exec();
    if (!error) {
      // data may be null if RPC returns void; caller should handle
      return data as T;
    }
    lastError = error;
    if (!isRetriableError(error)) {
      throw error;
    }
    // exponential backoff: 100, 200, 400ms ...
    const delay = baseDelayMs * Math.pow(2, attempt);
    // eslint-disable-next-line no-console
    console.warn(`[rpcWithRetry] Retriable error (attempt ${attempt + 1}/${maxRetries}):`, error?.code || error?.message);
    await sleep(delay);
    attempt++;
  }
  throw lastError || new Error('RPC failed after retries');
}

async function findExistingWorkOrderByReference(reference?: string, outputName?: string, outputQty?: number) {
  try {
    if (!reference) return null;
    let query = supabase
      .from('work_orders')
      .select('*')
      .eq('invoice_no', reference)
      .order('created_at', { ascending: false })
      .limit(1);

    if (outputName) query = query.eq('output_name', outputName);
    if (typeof outputQty === 'number' && !Number.isNaN(outputQty)) query = query.eq('output_quantity', outputQty);

    const { data, error } = await query;
    if (error) handleSupabaseError(error);
    if (!data || data.length === 0) return null;
    return data[0];
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[findExistingWorkOrderByReference] lookup failed:', e);
    return null;
  }
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
    // Pre-validate feasibility (simplified for now)
    // TODO: Re-enable full validation after debugging
    // const feasibilityMaterials = [
    //   ...params.rawMaterials.map(r => ({ skuId: r.skuId, quantity: r.quantity, type: 'ISSUE' as const })),
    //   ...params.wasteLines.map(w => ({ skuId: w.skuId, quantity: w.quantity, type: 'WASTE' as const }))
    // ];

    // const feasibility = await checkWorkOrderFeasibility(feasibilityMaterials);
    
    // if (!feasibility.canCreate) {
    //   throw new Error(`Insufficient inventory for SKUs: ${feasibility.insufficientSKUs.join(', ')}`);
    // }

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

    // Idempotency soft-check: if a work order with this external reference already exists, return it
    const existingWO = await findExistingWorkOrderByReference(params.reference, params.outputName, params.outputQuantity);
    if (existingWO) {
      // Compute plans to keep return shape consistent with UI expectations
      const fifoPlans = await calculateWorkOrderFIFOPlans(params.rawMaterials, params.wasteLines);
      return {
        workOrderId: existingWO.id,
        totalRawCost: fifoPlans.totalRawCost,
        totalWasteCost: fifoPlans.totalWasteCost,
        outputUnitCost: fifoPlans.totalRawCost > 0 && params.outputQuantity > 0 ? (fifoPlans.totalRawCost - fifoPlans.totalWasteCost) / params.outputQuantity : 0,
        rawPlans: fifoPlans.rawPlans,
        wastePlans: fifoPlans.wastePlans,
        // extra details to maintain compatibility
        netProduceCost: (fifoPlans.totalRawCost - fifoPlans.totalWasteCost),
        details: {
          rawCost: fifoPlans.totalRawCost,
          wasteCost: fifoPlans.totalWasteCost,
          netCost: (fifoPlans.totalRawCost - fifoPlans.totalWasteCost),
          unitCost: fifoPlans.totalRawCost > 0 && params.outputQuantity > 0 ? (fifoPlans.totalRawCost - fifoPlans.totalWasteCost) / params.outputQuantity : 0,
          consumptions: []
        }
      } as any;
    }

    // Call transactional RPC (with retry for serialization/deadlock/lock errors)
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

    let result: any;
    try {
      result = await rpcWithRetry<any>(() => supabase.rpc('create_work_order_transaction', rpcParams), 3, 100);
    } catch (err) {
      console.error('Error creating work order via RPC (after retries):', err);
      // As a last attempt for idempotency, check again by reference (in case first attempt actually succeeded but reply failed)
      const fallbackWO = await findExistingWorkOrderByReference(params.reference, params.outputName, params.outputQuantity);
      if (fallbackWO) {
        const fifoPlans = await calculateWorkOrderFIFOPlans(params.rawMaterials, params.wasteLines);
        return {
          workOrderId: fallbackWO.id,
          totalRawCost: fifoPlans.totalRawCost,
          totalWasteCost: fifoPlans.totalWasteCost,
          outputUnitCost: fifoPlans.totalRawCost > 0 && params.outputQuantity > 0 ? (fifoPlans.totalRawCost - fifoPlans.totalWasteCost) / params.outputQuantity : 0,
          rawPlans: fifoPlans.rawPlans,
          wastePlans: fifoPlans.wastePlans,
          netProduceCost: (fifoPlans.totalRawCost - fifoPlans.totalWasteCost),
          details: {
            rawCost: fifoPlans.totalRawCost,
            wasteCost: fifoPlans.totalWasteCost,
            netCost: (fifoPlans.totalRawCost - fifoPlans.totalWasteCost),
            unitCost: fifoPlans.totalRawCost > 0 && params.outputQuantity > 0 ? (fifoPlans.totalRawCost - fifoPlans.totalWasteCost) / params.outputQuantity : 0,
            consumptions: []
          }
        } as any;
      }
      throw err;
    }

    if (!result?.success) {
      throw new Error('Work order creation failed');
    }

    console.log('Work order created successfully:', result);

    // Calculate plans for return data (for UI compatibility)
    const fifoPlans = await calculateWorkOrderFIFOPlans(params.rawMaterials, params.wasteLines);

    // Post-creation validation to ensure integrity (temporarily disabled)
    // TODO: Re-enable after debugging
    // let validation: WorkOrderValidationResult | undefined;
    // try {
    //   validation = await validateWorkOrder(result.work_order_id);
      
    //   if (!validation.isValid) {
    //     console.warn(`Work Order ${result.work_order_id} validation failed:`, validation.issues);
    //     // Optionally auto-repair if validation fails
    //     // await repairWorkOrder(result.work_order_id);
    //   }
    // } catch (validationError) {
    //   console.error('Work order validation failed:', validationError);
    // }

    return {
      workOrderId: result.work_order_id,
      totalRawCost: result.total_raw_cost || fifoPlans.totalRawCost,
      totalWasteCost: result.total_waste_cost || fifoPlans.totalWasteCost,
      outputUnitCost: result.produce_unit_cost || ((result.net_produce_cost || fifoPlans.totalRawCost) / params.outputQuantity),
      rawPlans: fifoPlans.rawPlans,
      wastePlans: fifoPlans.wastePlans,
      // validation, // Temporarily disabled
      // Additional details for verification
      netProduceCost: result.net_produce_cost,
      details: {
        rawCost: result.total_raw_cost,
        wasteCost: result.total_waste_cost,
        netCost: result.net_produce_cost,
        unitCost: result.produce_unit_cost,
        consumptions: result.material_consumptions
      }
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
