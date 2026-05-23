/**
 * Inventory Query Service — Supabase Implementation
 *
 * Read-only access to the two as-of-date reconstruction RPCs introduced in
 * migrations 049/050 (snapshot) and 051 (drill-down). All math is performed
 * by Postgres; this module only wraps the RPC calls and maps the rows to
 * UI-friendly shapes.
 *
 * Semantics:
 *   - Cutoff is end-of-day in the requested IANA timezone (default
 *     America/Toronto). The RPC interprets `target_date` as the calendar
 *     day in that TZ and reconstructs state at start-of-next-day.
 *   - Soft-deleted (deleted_at) and reversed (reversed_at) movements are
 *     excluded regardless of when they were deleted/reversed.
 *   - Orphan FIFO layers (created_by_movement_id IS NULL) are treated as
 *     originating at the layer's created_at — see migration 050.
 */

import { supabase } from '@/lib/supabase';

export const INVENTORY_QUERY_DEFAULT_TZ = 'America/Toronto';

export type InventoryQuerySort =
  | 'sku_code_asc'
  | 'sku_code_desc'
  | 'on_hand_desc'
  | 'on_hand_asc'
  | 'total_value_desc'
  | 'total_value_asc';

export interface InventorySnapshotFilters {
  targetDate: Date;
  tz?: string;
  skuFilter?: string | null;
  limit?: number;
  offset?: number;
  sort?: InventoryQuerySort;
}

export interface InventorySnapshotRow {
  skuId: string;
  description: string;
  productType: string;
  productCategory: string;
  unit: string;
  onHand: number;
  averageCost: number;
  totalValue: number;
  activeLayers: number;
  totalCount: number;
}

export interface SkuDetailLayer {
  layerId: string;
  receivingDate: string;
  vendorId: string | null;
  vendorName: string | null;
  packingSlipNo: string | null;
  lotNumber: string | null;
  unitCost: number;
  originalQuantity: number;
  qtyRemainingAsOf: number;
  valueAsOf: number;
}

export interface SkuDetailMovement {
  movementId: number;
  datetime: string;
  type: string;
  quantity: number;
  unitCost: number | null;
  totalValue: number;
  reference: string;
  workOrderId: string | null;
  notes: string | null;
}

export interface SkuDetailTotals {
  onHand: number;
  averageCost: number;
  totalValue: number;
  layerCount: number;
  hasAdjustments: boolean;
}

export interface SkuDetailAsOf {
  skuId: string;
  targetDate: string;
  tz: string;
  layers: SkuDetailLayer[];
  dayMovements: SkuDetailMovement[];
  totals: SkuDetailTotals;
}

/**
 * Convert a calendar Date to the YYYY-MM-DD string the RPC expects.
 * We intentionally use the *local* (browser) calendar components rather
 * than UTC, because the user picked the date from a `<input type="date">`
 * which carries no timezone — the literal Y-M-D is what they meant.
 */
function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toNumber(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mapSnapshotRow(row: any): InventorySnapshotRow {
  return {
    skuId: row.sku_id,
    description: row.description ?? '',
    productType: row.product_type ?? '',
    productCategory: row.product_category ?? '',
    unit: row.unit ?? '',
    onHand: toNumber(row.on_hand),
    averageCost: toNumber(row.average_cost),
    totalValue: toNumber(row.total_value),
    activeLayers: toNumber(row.active_layers),
    totalCount: toNumber(row.total_count),
  };
}

function mapDetailLayer(j: any): SkuDetailLayer {
  return {
    layerId: j.layer_id,
    receivingDate: j.receiving_date,
    vendorId: j.vendor_id ?? null,
    vendorName: j.vendor_name ?? null,
    packingSlipNo: j.packing_slip_no ?? null,
    lotNumber: j.lot_number ?? null,
    unitCost: toNumber(j.unit_cost),
    originalQuantity: toNumber(j.original_quantity),
    qtyRemainingAsOf: toNumber(j.qty_remaining_as_of),
    valueAsOf: toNumber(j.value_as_of),
  };
}

function mapDetailMovement(j: any): SkuDetailMovement {
  return {
    movementId: Number(j.movement_id),
    datetime: j.datetime,
    type: j.type,
    quantity: toNumber(j.quantity),
    unitCost: j.unit_cost === null || j.unit_cost === undefined ? null : toNumber(j.unit_cost),
    totalValue: toNumber(j.total_value),
    reference: j.reference ?? '',
    workOrderId: j.work_order_id ?? null,
    notes: j.notes ?? null,
  };
}

/**
 * Paged per-SKU inventory snapshot as of end-of-day target_date in `tz`.
 * Returns the page of rows plus a totalCount on each row (the RPC returns
 * it via a window function so we don't make a second roundtrip).
 */
export async function getInventorySnapshotAsOf(
  filters: InventorySnapshotFilters
): Promise<{ rows: InventorySnapshotRow[]; total: number }> {
  const {
    targetDate,
    tz = INVENTORY_QUERY_DEFAULT_TZ,
    skuFilter = null,
    limit = 100,
    offset = 0,
    sort = 'sku_code_asc',
  } = filters;

  const { data, error } = await supabase.rpc('get_inventory_snapshot_as_of', {
    p_target_date: toYmd(targetDate),
    p_tz: tz,
    p_sku_filter: skuFilter && skuFilter.trim().length > 0 ? skuFilter.trim() : null,
    p_limit: limit,
    p_offset: offset,
    p_sort: sort,
  });

  if (error) throw error;

  const rows = (data ?? []).map(mapSnapshotRow);
  const total = rows.length > 0 ? rows[0].totalCount : 0;
  return { rows, total };
}

/**
 * Drill-down for a single SKU at end-of-day target_date in `tz`.
 * Returns reconstructed FIFO layers, the day's movements, and totals.
 */
export async function getSkuDetailAsOf(
  skuId: string,
  targetDate: Date,
  tz: string = INVENTORY_QUERY_DEFAULT_TZ
): Promise<SkuDetailAsOf> {
  const { data, error } = await supabase.rpc('get_sku_detail_as_of', {
    p_sku_id: skuId,
    p_target_date: toYmd(targetDate),
    p_tz: tz,
  });

  if (error) throw error;
  const d = (data ?? {}) as any;
  return {
    skuId: d.sku_id ?? skuId,
    targetDate: d.target_date ?? toYmd(targetDate),
    tz: d.tz ?? tz,
    layers: Array.isArray(d.layers) ? d.layers.map(mapDetailLayer) : [],
    dayMovements: Array.isArray(d.day_movements) ? d.day_movements.map(mapDetailMovement) : [],
    totals: {
      onHand: toNumber(d.totals?.on_hand),
      averageCost: toNumber(d.totals?.average_cost),
      totalValue: toNumber(d.totals?.total_value),
      layerCount: toNumber(d.totals?.layer_count),
      hasAdjustments: Boolean(d.totals?.has_adjustments),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Daily timeline                                                            */
/* -------------------------------------------------------------------------- */

export interface TimelineMovementByType {
  type: string;
  count: number;
  /** Signed sum for per-SKU timeline; abs sum for aggregate timeline. */
  qty: number;
}

export interface SkuTimelineDay {
  date: string;
  movementsByType: TimelineMovementByType[];
  grossIn: number;
  grossOut: number;
  netDelta: number;
  closingQty: number;
  closingValue: number;
  avgCost: number;
  deltaQty: number;
  deltaValue: number;
}

export interface SkuDailyTimeline {
  skuId: string;
  targetDate: string;
  tz: string;
  lowerDate: string | null;
  days: SkuTimelineDay[];
}

export interface InventoryTimelineDay {
  date: string;
  movementsByType: TimelineMovementByType[];
  movementCount: number;
  skuCount: number;
  closingValueUsd: number;
  activeLayerCount: number;
  deltaValue: number;
}

export interface InventoryDailyTimeline {
  targetDate: string;
  tz: string;
  lowerDate: string | null;
  days: InventoryTimelineDay[];
}

function mapMovementByType(j: any, qtyKey: 'qty' | 'qty_abs'): TimelineMovementByType {
  return {
    type: String(j.type),
    count: toNumber(j.count),
    qty: toNumber(j[qtyKey]),
  };
}

function mapSkuTimelineDay(j: any): SkuTimelineDay {
  return {
    date: String(j.date),
    movementsByType: Array.isArray(j.movements_by_type)
      ? j.movements_by_type.map((x: any) => mapMovementByType(x, 'qty'))
      : [],
    grossIn: toNumber(j.gross_in),
    grossOut: toNumber(j.gross_out),
    netDelta: toNumber(j.net_delta),
    closingQty: toNumber(j.closing_qty),
    closingValue: toNumber(j.closing_value),
    avgCost: toNumber(j.avg_cost),
    deltaQty: toNumber(j.delta_qty),
    deltaValue: toNumber(j.delta_value),
  };
}

function mapInventoryTimelineDay(j: any): InventoryTimelineDay {
  return {
    date: String(j.date),
    movementsByType: Array.isArray(j.movements_by_type)
      ? j.movements_by_type.map((x: any) => mapMovementByType(x, 'qty_abs'))
      : [],
    movementCount: toNumber(j.movement_count),
    skuCount: toNumber(j.sku_count),
    closingValueUsd: toNumber(j.closing_value_usd),
    activeLayerCount: toNumber(j.active_layer_count),
    deltaValue: toNumber(j.delta_value),
  };
}

/**
 * Per-SKU daily activity timeline up to `targetDate` (end-of-day in `tz`).
 * Emits one entry per calendar day with movement activity. Closing values
 * are FIFO-reconstructed (orphan layers included), matching the snapshot
 * and detail RPCs.
 *
 * @param daysBack If provided, restrict the window to the most recent N
 *                 days before targetDate. Null = full history up to targetDate.
 */
export async function getSkuDailyTimelineAsOf(
  skuId: string,
  targetDate: Date,
  daysBack: number | null = null,
  tz: string = INVENTORY_QUERY_DEFAULT_TZ,
): Promise<SkuDailyTimeline> {
  const { data, error } = await supabase.rpc('get_sku_daily_timeline_as_of', {
    p_sku_id: skuId,
    p_target_date: toYmd(targetDate),
    p_days_back: daysBack,
    p_tz: tz,
  });
  if (error) throw error;
  const d = (data ?? {}) as any;
  return {
    skuId: d.sku_id ?? skuId,
    targetDate: d.target_date ?? toYmd(targetDate),
    tz: d.tz ?? tz,
    lowerDate: d.lower_date ?? null,
    days: Array.isArray(d.days) ? d.days.map(mapSkuTimelineDay) : [],
  };
}

/* -------------------------------------------------------------------------- */
/*  Day-level drill-down (every movement on a calendar day, by SKU)           */
/* -------------------------------------------------------------------------- */

export interface DayMovement {
  movementId: number;
  datetime: string;
  type: string;
  quantity: number;
  unitCost: number | null;
  totalValue: number;
  reference: string;
  workOrderId: string | null;
  notes: string | null;
  productName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  packingSlipNo: string | null;
}

export interface DaySkuGroup {
  skuId: string;
  skuDescription: string;
  productType: string;
  unit: string;
  movementCount: number;
  netQty: number;
  totalValue: number;
  movements: DayMovement[];
}

export interface DayMovementsResult {
  date: string;
  tz: string;
  totals: {
    movementCount: number;
    skuCount: number;
    grossInCount: number;
    grossOutCount: number;
    grossInValue: number;
    grossOutValue: number;
  };
  groups: DaySkuGroup[];
}

function mapDayMovement(j: any): DayMovement {
  return {
    movementId: Number(j.movement_id),
    datetime: String(j.datetime),
    type: String(j.type),
    quantity: toNumber(j.quantity),
    unitCost: j.unit_cost === null || j.unit_cost === undefined ? null : toNumber(j.unit_cost),
    totalValue: toNumber(j.total_value),
    reference: j.reference ?? '',
    workOrderId: j.work_order_id ?? null,
    notes: j.notes ?? null,
    productName: j.product_name ?? null,
    vendorId: j.vendor_id ?? null,
    vendorName: j.vendor_name ?? null,
    packingSlipNo: j.packing_slip_no ?? null,
  };
}

function mapDayGroup(j: any): DaySkuGroup {
  return {
    skuId: j.sku_id ?? '',
    skuDescription: j.sku_description ?? '',
    productType: j.product_type ?? '',
    unit: j.unit ?? '',
    movementCount: toNumber(j.movement_count),
    netQty: toNumber(j.net_qty),
    totalValue: toNumber(j.total_value),
    movements: Array.isArray(j.movements) ? j.movements.map(mapDayMovement) : [],
  };
}

/**
 * Every active movement that occurred on the given calendar day in the
 * requested timezone, grouped by SKU. Used by the Daily Inventory Timeline
 * drill-down.
 */
export async function getMovementsOnDate(
  targetDate: Date,
  tz: string = INVENTORY_QUERY_DEFAULT_TZ,
): Promise<DayMovementsResult> {
  const { data, error } = await supabase.rpc('get_movements_on_date', {
    p_target_date: toYmd(targetDate),
    p_tz: tz,
  });
  if (error) throw error;
  const d = (data ?? {}) as any;
  return {
    date: d.date ?? toYmd(targetDate),
    tz: d.tz ?? tz,
    totals: {
      movementCount:  toNumber(d.totals?.movement_count),
      skuCount:       toNumber(d.totals?.sku_count),
      grossInCount:   toNumber(d.totals?.gross_in_count),
      grossOutCount:  toNumber(d.totals?.gross_out_count),
      grossInValue:   toNumber(d.totals?.gross_in_value),
      grossOutValue:  toNumber(d.totals?.gross_out_value),
    },
    groups: Array.isArray(d.groups) ? d.groups.map(mapDayGroup) : [],
  };
}

/**
 * Aggregate daily inventory timeline across ALL active SKUs up to
 * `targetDate` (end-of-day in `tz`). Closing dollar value is the only
 * unit-safe aggregate; quantities are reported as |abs| sums per type.
 */
export async function getInventoryTimelineAsOf(
  targetDate: Date,
  daysBack: number | null = 30,
  tz: string = INVENTORY_QUERY_DEFAULT_TZ,
): Promise<InventoryDailyTimeline> {
  const { data, error } = await supabase.rpc('get_inventory_timeline_as_of', {
    p_target_date: toYmd(targetDate),
    p_days_back: daysBack,
    p_tz: tz,
  });
  if (error) throw error;
  const d = (data ?? {}) as any;
  return {
    targetDate: d.target_date ?? toYmd(targetDate),
    tz: d.tz ?? tz,
    lowerDate: d.lower_date ?? null,
    days: Array.isArray(d.days) ? d.days.map(mapInventoryTimelineDay) : [],
  };
}
