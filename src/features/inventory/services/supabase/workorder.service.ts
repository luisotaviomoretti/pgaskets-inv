/**
 * Work Order Service - Supabase Implementation
 * Handles work order operations with multi-SKU RAW consumption and production
 */

import { supabase, handleSupabaseError } from '@/lib/supabase';
import type { Database } from '@/types/supabase';
import { calculateFIFOPlan, type FIFOPlanResult } from './fifo.service';
import { telemetry } from '@/features/inventory/services/telemetry';
import { parseRpcError } from '@/features/inventory/types/errors';
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
  /**
   * Client-generated UUID v4 used for atomic dedup (migration 044).
   * The same submission must reuse this UUID across retries; a NEW
   * submission must generate a fresh UUID. The frontend is responsible
   * for that lifecycle.
   */
  clientRequestId?: string;
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
  /** True when the server returned a previously-persisted WO (idempotency hit). */
  wasDuplicate?: boolean;
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

/**
 * Look up an existing WO by client_request_id. Used as the post-failure fallback
 * for the network-reply-lost case: the RPC may have committed before the network
 * dropped, so on retry exhaustion we check whether the row already exists by
 * its idempotency nonce. The dedup itself is now done server-side (migration
 * 044), so this function intentionally does NOT fall back to (invoice_no,
 * name, qty) — that key collided across legitimate distinct submissions.
 */
async function findWorkOrderByClientRequestId(clientRequestId?: string) {
  try {
    if (!clientRequestId) return null;
    const { data, error } = await supabase
      .from('work_orders')
      .select('*')
      .eq('client_request_id', clientRequestId)
      .limit(1);
    if (error) handleSupabaseError(error);
    if (!data || data.length === 0) return null;
    return data[0];
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[findWorkOrderByClientRequestId] lookup failed:', e);
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

    telemetry.event('wo.submit.started', {
      outputQuantity: params.outputQuantity,
      materialCount: allMaterials.length,
      hasClientRequestId: !!params.clientRequestId,
    });

    // Call transactional RPC (with retry for serialization/deadlock/lock errors).
    // The RPC itself is now atomically idempotent (migration 044) — same
    // client_request_id => returns existing WO with was_duplicate=true.
    const rpcParams = {
      p_output_name: params.outputName,
      p_output_quantity: params.outputQuantity,
      p_output_unit: 'unit',
      p_mode: 'AUTO',
      p_client_name: null,
      p_invoice_no: params.reference || null,
      p_notes: params.notes || null,
      p_materials: allMaterials,
      p_work_order_date: params.date instanceof Date
        ? params.date.toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0],
      p_client_request_id: params.clientRequestId || null,
    };

    let result: any;
    try {
      result = await rpcWithRetry<any>(() => supabase.rpc('create_work_order_transaction', rpcParams), 3, 100);
    } catch (err) {
      const parsed = parseRpcError(err);
      telemetry.error('wo.submit.failed', err, { code: parsed.code });

      // Network-reply-lost recovery: the RPC may have committed before the
      // reply made it back. If we have a client_request_id, look up by it.
      if (params.clientRequestId) {
        const fallbackWO = await findWorkOrderByClientRequestId(params.clientRequestId);
        if (fallbackWO) {
          telemetry.event('wo.submit.recovered_after_failure', { workOrderId: fallbackWO.id });
          const fifoPlans = await calculateWorkOrderFIFOPlans(params.rawMaterials, params.wasteLines);
          return {
            workOrderId: fallbackWO.id,
            totalRawCost: fifoPlans.totalRawCost,
            totalWasteCost: fifoPlans.totalWasteCost,
            outputUnitCost: fifoPlans.totalRawCost > 0 && params.outputQuantity > 0 ? (fifoPlans.totalRawCost - fifoPlans.totalWasteCost) / params.outputQuantity : 0,
            rawPlans: fifoPlans.rawPlans,
            wastePlans: fifoPlans.wastePlans,
            netProduceCost: (fifoPlans.totalRawCost - fifoPlans.totalWasteCost),
            wasDuplicate: true,
            details: {
              rawCost: fifoPlans.totalRawCost,
              wasteCost: fifoPlans.totalWasteCost,
              netCost: (fifoPlans.totalRawCost - fifoPlans.totalWasteCost),
              unitCost: fifoPlans.totalRawCost > 0 && params.outputQuantity > 0 ? (fifoPlans.totalRawCost - fifoPlans.totalWasteCost) / params.outputQuantity : 0,
              consumptions: [],
            },
          } as any;
        }
      }
      throw err;
    }

    if (!result?.success) {
      throw new Error('Work order creation failed');
    }

    if (result.was_duplicate) {
      telemetry.event('wo.submit.dedup_hit', { workOrderId: result.work_order_id });
    } else {
      telemetry.event('wo.submit.succeeded', { workOrderId: result.work_order_id });
    }

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
      wasDuplicate: !!result.was_duplicate,
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
 * Get work order details with associated movements (RAW/WASTE/PRODUCE)
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

    // Derive WO lines from movements linked to this work order
    const { data: movements, error: movError } = await supabase
      .from('movements')
      .select(`
        id,
        type,
        sku_id,
        quantity,
        unit_cost,
        total_value,
        datetime,
        notes,
        skus (id, description, unit)
      `)
      .eq('work_order_id', id)
      .is('deleted_at', null)
      .order('type')
      .order('created_at');

    if (movError) {
      handleSupabaseError(movError);
    }

    // Map movements to a lines-like shape for API compatibility
    const lines = (movements || []).map((m: any) => ({
      id: m.id,
      work_order_id: id,
      type: m.type === 'PRODUCE' ? 'OUTPUT' : m.type === 'WASTE' ? 'WASTE' : 'RAW',
      sku_id: m.sku_id,
      quantity: Math.abs(m.quantity),
      unit_cost: m.unit_cost,
      total_cost: Math.abs(m.total_value),
      movement_id: m.id,
      created_at: m.datetime,
      skus: m.skus,
    }));

    return {
      workOrder,
      lines,
    };
  } catch (error) {
    console.error('Error fetching work order details:', error);
    throw error;
  }
}
