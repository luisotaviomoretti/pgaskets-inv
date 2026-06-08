/**
 * Inventory Query — As-of-Date Stock Reconstruction
 *
 * Lets the user pick any past date D and see, as of end-of-day D in
 * America/Toronto:
 *   - A paginated per-SKU snapshot (on_hand, average_cost, total_value).
 *   - Drill-down per SKU: reconstructed FIFO layers + day's movements.
 *
 * All math is performed by Postgres RPCs (migrations 049/050/051). This
 * component is purely a renderer.
 *
 * Pre-existing data caveat (surfaced via the "Adj." badge): SKUs that have
 * any historical ADJUSTMENT movement may show qty divergence vs.
 * skus.on_hand, because ADJUSTMENT bypasses FIFO consumption tracking.
 * See migrations 050/051 for context.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { inventoryQueryOperations } from '@/features/inventory/services/inventory.adapter';
import type {
  InventoryQuerySort,
  InventorySnapshotRow,
  SkuDetailAsOf,
  SkuDailyTimeline,
  InventoryDailyTimeline,
  TimelineMovementByType,
  DayMovementsResult,
} from '@/features/inventory/services/supabase/inventoryQuery.service';

const TZ = 'America/Toronto';
const PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;
const EXPORT_ALL_WARN_THRESHOLD = 5000;

/**
 * Opening-balance value date.
 *
 * The initial stock was loaded into the system on 2026-03-12, but those
 * physical counts represent on-hand AS OF 2026-02-28 (per the business
 * owner). The opening balance is stored as 120 FIFO layers (INIT-*) with
 * receiving_date = 2026-02-28 and NO movement rows — it was seeded directly,
 * not via a RECEIVE.
 *
 * Because the Daily Inventory Timeline only emits rows for days that have
 * movement activity, the opening balance has no row of its own (there are no
 * movements on 2026-02-28). Its value is already folded into the closing
 * value of the first day that *does* have activity (2026-03-02). When the
 * user queries exactly this date, we synthesize a read-only "Opening Balance"
 * row so the timeline has a visible starting point. The figure is derived
 * from the snapshot RPC (single source of truth), never hard-coded.
 */
const OPENING_BALANCE_DATE = '2026-02-28';

/**
 * Today (calendar) in America/Toronto as YYYY-MM-DD. We compute it via
 * Intl.DateTimeFormat to avoid the user's local-TZ skew bleeding into the
 * default date.
 */
function todayInToronto(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA renders as YYYY-MM-DD directly.
  return fmt.format(new Date());
}

function parseYmd(ymd: string): Date {
  // Construct as midnight LOCAL — toYmd() in the service uses local Y-M-D
  // components, so this round-trips consistently.
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/**
 * Quantity formatter — always renders as a thousands-separated integer.
 * Display-only; Excel exports keep the raw numeric value so spreadsheet
 * formulas and audits stay accurate.
 */
function fmtQty(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  });
}

/** Signed quantity ("+1,234" / "−1,234" / "0"), rounded to integer. */
function fmtQtySigned(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const r = Math.round(n);
  if (r === 0) return '0';
  const s = Math.abs(r).toLocaleString('en-US', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  });
  return r > 0 ? `+${s}` : `−${s}`;
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function fmtDateOnly(iso: string | null | undefined): string {
  if (!iso) return '—';
  // ISO date or timestamptz; both are safe to slice.
  return String(iso).slice(0, 10);
}

function fmtTimeOnly(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-CA', {
      timeZone: TZ,
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function fmtDatetime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function movementBadgeClass(type: string): string {
  switch (type) {
    case 'RECEIVE':    return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    case 'PRODUCE':    return 'bg-slate-900 text-white';
    case 'ISSUE':      return 'bg-amber-100 text-amber-800 border-amber-200';
    case 'WASTE':      return 'bg-red-100 text-red-800 border-red-200';
    case 'DAMAGE':     return 'bg-red-100 text-red-800 border-red-200';
    case 'ADJUSTMENT': return 'bg-slate-100 text-slate-700 border-slate-300';
    case 'TRANSFER':   return 'bg-blue-100 text-blue-800 border-blue-200';
    default:           return 'bg-slate-100 text-slate-700';
  }
}

export default function InventoryQuery() {
  // Filter state
  const [dateYmd, setDateYmd]       = useState<string>(todayInToronto());
  const [skuFilter, setSkuFilter]   = useState<string>('');
  const [sort, setSort]             = useState<InventoryQuerySort>('sku_code_asc');
  const [pageSize, setPageSize]     = useState<number>(50);
  const [page, setPage]             = useState<number>(0);

  // Data state
  const [rows, setRows]             = useState<InventorySnapshotRow[]>([]);
  const [total, setTotal]           = useState<number>(0);
  const [loading, setLoading]       = useState<boolean>(false);
  const [exporting, setExporting]   = useState<boolean>(false);

  // Drill-down state
  const [detailSkuId, setDetailSkuId]   = useState<string | null>(null);
  const [detail, setDetail]             = useState<SkuDetailAsOf | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [skuTimeline, setSkuTimeline]   = useState<SkuDailyTimeline | null>(null);
  const [skuTimelineLoading, setSkuTimelineLoading] = useState<boolean>(false);

  // Aggregate timeline state (main page section)
  const [aggTimeline, setAggTimeline]   = useState<InventoryDailyTimeline | null>(null);
  const [aggTimelineLoading, setAggTimelineLoading] = useState<boolean>(false);
  const [aggDaysBack, setAggDaysBack]   = useState<number | null>(30);

  // Day drill-down state (modal opened from clicking a timeline row)
  const [dayDrillDate, setDayDrillDate] = useState<string | null>(null);
  const [dayDrill, setDayDrill]         = useState<DayMovementsResult | null>(null);
  const [dayDrillLoading, setDayDrillLoading] = useState<boolean>(false);
  const [dayDrillExporting, setDayDrillExporting] = useState<boolean>(false);

  // Excel export state for aggregate timeline
  const [aggExporting, setAggExporting] = useState<boolean>(false);

  // Synthetic "Opening Balance" row for the timeline. Only populated when the
  // user queries exactly OPENING_BALANCE_DATE (the opening balance has no
  // movements, so the timeline would otherwise render nothing). Derived from
  // the snapshot RPC, not hard-coded — see OPENING_BALANCE_DATE doc above.
  const [openingBalance, setOpeningBalance] =
    useState<{ qty: number; value: number; layers: number } | null>(null);

  // Debounce SKU filter so each keystroke doesn't hit the network
  const skuFilterDebounced = useDebounced(skuFilter, 300);

  // Reset page when filters change
  useEffect(() => { setPage(0); }, [dateYmd, skuFilterDebounced, sort, pageSize]);

  const targetDate = useMemo(() => parseYmd(dateYmd), [dateYmd]);

  // Concurrent-request guard: only the most recent request applies state.
  const reqIdRef = useRef(0);

  const loadSnapshot = useCallback(async () => {
    const myReq = ++reqIdRef.current;
    setLoading(true);
    try {
      const { rows, total } = await inventoryQueryOperations.getSnapshotAsOf({
        targetDate,
        tz: TZ,
        skuFilter: skuFilterDebounced || null,
        limit: pageSize,
        offset: page * pageSize,
        sort,
      });
      if (myReq !== reqIdRef.current) return;
      setRows(rows);
      setTotal(total);
    } catch (err: any) {
      if (myReq !== reqIdRef.current) return;
      console.error('[InventoryQuery] snapshot error', err);
      toast.error('Failed to load inventory snapshot: ' + (err?.message ?? 'unknown error'));
      setRows([]);
      setTotal(0);
    } finally {
      if (myReq === reqIdRef.current) setLoading(false);
    }
  }, [targetDate, skuFilterDebounced, pageSize, page, sort]);

  useEffect(() => { loadSnapshot(); }, [loadSnapshot]);

  // Drill-down: load detail + per-SKU daily timeline in parallel.
  const openDetail = useCallback(async (skuId: string) => {
    setDetailSkuId(skuId);
    setDetail(null);
    setSkuTimeline(null);
    setDetailLoading(true);
    setSkuTimelineLoading(true);
    try {
      const [d, t] = await Promise.all([
        inventoryQueryOperations.getSkuDetailAsOf(skuId, targetDate, TZ),
        inventoryQueryOperations.getSkuDailyTimelineAsOf(skuId, targetDate, null, TZ),
      ]);
      setDetail(d);
      setSkuTimeline(t);
    } catch (err: any) {
      console.error('[InventoryQuery] detail error', err);
      toast.error('Failed to load SKU detail: ' + (err?.message ?? 'unknown error'));
      setDetailSkuId(null);
    } finally {
      setDetailLoading(false);
      setSkuTimelineLoading(false);
    }
  }, [targetDate]);

  const closeDetail = useCallback(() => {
    setDetailSkuId(null);
    setDetail(null);
    setSkuTimeline(null);
  }, []);

  // Day drill-down — open and load the day's movements grouped by SKU.
  const openDayDrill = useCallback(async (dateYmdStr: string) => {
    setDayDrillDate(dateYmdStr);
    setDayDrill(null);
    setDayDrillLoading(true);
    try {
      const d = await inventoryQueryOperations.getMovementsOnDate(parseYmd(dateYmdStr), TZ);
      setDayDrill(d);
    } catch (err: any) {
      console.error('[InventoryQuery] day drill error', err);
      toast.error('Failed to load day movements: ' + (err?.message ?? 'unknown error'));
      setDayDrillDate(null);
    } finally {
      setDayDrillLoading(false);
    }
  }, []);

  const closeDayDrill = useCallback(() => {
    setDayDrillDate(null);
    setDayDrill(null);
  }, []);

  // Excel export — Daily Inventory Timeline (aggregate). Two sheets:
  // (1) Daily Summary — one row per day with the table's columns.
  // (2) Movements Detail — every movement of every day in the window,
  //     resolved via per-day get_movements_on_date calls in parallel.
  const exportAggregateTimeline = useCallback(async () => {
    if (!aggTimeline || aggTimeline.days.length === 0) return;
    setAggExporting(true);
    try {
      const XLSX = await import('xlsx');

      // Sheet 1: daily summary
      const summaryRows = aggTimeline.days.map((d) => ({
        'Date': d.date,
        'Movements': d.movementCount,
        'SKUs touched': d.skuCount,
        'Active FIFO layers': d.activeLayerCount,
        'Closing value (USD)': d.closingValueUsd,
        'Δ vs prev day': d.deltaValue,
        'By type (RECEIVE)':     d.movementsByType.find((x) => x.type === 'RECEIVE')?.count    ?? 0,
        'By type (ISSUE)':       d.movementsByType.find((x) => x.type === 'ISSUE')?.count      ?? 0,
        'By type (PRODUCE)':     d.movementsByType.find((x) => x.type === 'PRODUCE')?.count    ?? 0,
        'By type (WASTE)':       d.movementsByType.find((x) => x.type === 'WASTE')?.count      ?? 0,
        'By type (ADJUSTMENT)':  d.movementsByType.find((x) => x.type === 'ADJUSTMENT')?.count ?? 0,
        'By type (DAMAGE)':      d.movementsByType.find((x) => x.type === 'DAMAGE')?.count     ?? 0,
        'By type (TRANSFER)':    d.movementsByType.find((x) => x.type === 'TRANSFER')?.count   ?? 0,
      }));

      // Sheet 2: movements detail — fetch each day in parallel (the
      // aggregate window is usually small enough that this is fine).
      toast.info(`Fetching movement detail for ${aggTimeline.days.length} day(s)…`);
      const dayResults = await Promise.all(
        aggTimeline.days.map((d) =>
          inventoryQueryOperations.getMovementsOnDate(parseYmd(d.date), TZ).catch(() => null),
        ),
      );
      const detailRows: any[] = [];
      for (const r of dayResults) {
        if (!r) continue;
        for (const g of r.groups) {
          for (const m of g.movements) {
            detailRows.push({
              'Date':           r.date,
              'Time':           fmtTimeOnly(m.datetime),
              'Movement ID':    m.movementId,
              'Type':           m.type,
              'SKU':            g.skuId || '(PRODUCE output)',
              'SKU description':g.skuDescription || m.productName || '',
              'Product type':   g.productType,
              'Unit':           g.unit,
              'Quantity':       m.quantity,
              'Unit cost':      m.unitCost ?? '',
              'Total value':    m.totalValue,
              'Reference':      m.reference,
              'Work order':     m.workOrderId ?? '',
              'Vendor':         m.vendorName ?? '',
              'Packing slip':   m.packingSlipNo ?? '',
              'Notes':          m.notes ?? '',
            });
          }
        }
      }

      const wb = XLSX.utils.book_new();
      const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
      wsSummary['!cols'] = [
        { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 16 },
        { wch: 18 }, { wch: 14 },
        { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 14 }, { wch: 14 },
      ];
      XLSX.utils.book_append_sheet(wb, wsSummary, 'Daily Summary');

      const wsDetail = XLSX.utils.json_to_sheet(detailRows);
      wsDetail['!cols'] = [
        { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 12 },
        { wch: 36 }, { wch: 50 }, { wch: 12 }, { wch: 8 },
        { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 20 },
        { wch: 16 }, { wch: 28 }, { wch: 16 }, { wch: 28 },
      ];
      XLSX.utils.book_append_sheet(wb, wsDetail, 'Movements Detail');

      const windowLabel = aggDaysBack === null ? 'all-time' : `last-${aggDaysBack}d`;
      XLSX.writeFile(wb, `inventory-timeline-${dateYmd}-${windowLabel}.xlsx`);
      toast.success(`Exported ${summaryRows.length} day(s) and ${detailRows.length} movement(s)`);
    } catch (err: any) {
      toast.error('Export failed: ' + (err?.message ?? 'unknown error'));
    } finally {
      setAggExporting(false);
    }
  }, [aggTimeline, aggDaysBack, dateYmd]);

  // Excel export — single-day drill-down.
  const exportDayDrill = useCallback(async () => {
    if (!dayDrill) return;
    setDayDrillExporting(true);
    try {
      const XLSX = await import('xlsx');
      const rows: any[] = [];
      for (const g of dayDrill.groups) {
        for (const m of g.movements) {
          rows.push({
            'Time':            fmtTimeOnly(m.datetime),
            'Movement ID':     m.movementId,
            'Type':            m.type,
            'SKU':             g.skuId || '(PRODUCE output)',
            'SKU description': g.skuDescription || m.productName || '',
            'Product type':    g.productType,
            'Unit':            g.unit,
            'Quantity':        m.quantity,
            'Unit cost':       m.unitCost ?? '',
            'Total value':     m.totalValue,
            'Reference':       m.reference,
            'Work order':      m.workOrderId ?? '',
            'Vendor':          m.vendorName ?? '',
            'Packing slip':    m.packingSlipNo ?? '',
            'Notes':           m.notes ?? '',
          });
        }
      }
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [
        { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 36 }, { wch: 50 },
        { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 14 },
        { wch: 20 }, { wch: 16 }, { wch: 28 }, { wch: 16 }, { wch: 28 },
      ];
      XLSX.utils.book_append_sheet(wb, ws, `Movements ${dayDrill.date}`);
      XLSX.writeFile(wb, `movements-${dayDrill.date}.xlsx`);
      toast.success(`Exported ${rows.length} movement(s)`);
    } catch (err: any) {
      toast.error('Export failed: ' + (err?.message ?? 'unknown error'));
    } finally {
      setDayDrillExporting(false);
    }
  }, [dayDrill]);

  // Aggregate timeline: refetch when target date or window changes.
  useEffect(() => {
    let cancelled = false;
    setAggTimelineLoading(true);
    inventoryQueryOperations
      .getInventoryTimelineAsOf(targetDate, aggDaysBack, TZ)
      .then((t) => { if (!cancelled) setAggTimeline(t); })
      .catch((err) => {
        if (cancelled) return;
        console.error('[InventoryQuery] aggregate timeline error', err);
        toast.error('Failed to load inventory timeline: ' + (err?.message ?? 'unknown error'));
        setAggTimeline(null);
      })
      .finally(() => { if (!cancelled) setAggTimelineLoading(false); });
    return () => { cancelled = true; };
  }, [targetDate, aggDaysBack]);

  // Opening-balance row: only when the user queries exactly the opening-balance
  // date. We sum the snapshot as-of that date (full inventory, not just one
  // page) to get the closing qty/value/layers the synthetic row should show.
  // For any other date this clears to null so no row is injected.
  useEffect(() => {
    if (dateYmd !== OPENING_BALANCE_DATE) {
      setOpeningBalance(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const obDate = parseYmd(OPENING_BALANCE_DATE);
        let qty = 0, value = 0, layers = 0;
        const pageStep = 1000;
        for (let off = 0; ; off += pageStep) {
          const { rows: chunk, total } = await inventoryQueryOperations.getSnapshotAsOf({
            targetDate: obDate,
            tz: TZ,
            skuFilter: null,
            limit: pageStep,
            offset: off,
            sort: 'sku_code_asc',
          });
          for (const r of chunk) {
            qty += r.onHand;
            value += r.totalValue;
            layers += r.activeLayers;
          }
          if (off + pageStep >= total || chunk.length === 0) break;
        }
        if (!cancelled) setOpeningBalance({ qty, value, layers });
      } catch (err: any) {
        if (cancelled) return;
        console.error('[InventoryQuery] opening-balance error', err);
        // Non-fatal: just don't show the synthetic row.
        setOpeningBalance(null);
      }
    })();
    return () => { cancelled = true; };
  }, [dateYmd]);

  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;
  const showingFrom = total === 0 ? 0 : page * pageSize + 1;
  const showingTo = Math.min(total, (page + 1) * pageSize);

  // Excel export — visible page
  const exportVisible = useCallback(async () => {
    if (rows.length === 0) return;
    setExporting(true);
    try {
      const XLSX = await import('xlsx');
      const data = rows.map((r) => ({
        'SKU': r.skuId,
        'Description': r.description,
        'Type': r.productType,
        'Category': r.productCategory,
        'Unit': r.unit,
        'On Hand': r.onHand,
        'Average Cost': r.averageCost,
        'Total Value': r.totalValue,
        'Active Layers': r.activeLayers,
      }));
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(data);
      ws['!cols'] = [
        { wch: 30 }, { wch: 50 }, { wch: 10 }, { wch: 18 }, { wch: 8 },
        { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 10 },
      ];
      XLSX.utils.book_append_sheet(wb, ws, `Snapshot ${dateYmd}`);
      XLSX.writeFile(wb, `inventory-snapshot-${dateYmd}-page${page + 1}.xlsx`);
      toast.success(`Exported ${data.length} row(s)`);
    } catch (err: any) {
      toast.error('Export failed: ' + (err?.message ?? 'unknown error'));
    } finally {
      setExporting(false);
    }
  }, [rows, dateYmd, page]);

  // Excel export — all rows under current filter
  const exportAll = useCallback(async () => {
    if (total === 0) return;
    if (total > EXPORT_ALL_WARN_THRESHOLD) {
      if (!confirm(`This will export ${total.toLocaleString()} rows. Continue?`)) return;
    }
    setExporting(true);
    try {
      const XLSX = await import('xlsx');
      const pageStep = 500;
      const all: InventorySnapshotRow[] = [];
      for (let off = 0; off < total; off += pageStep) {
        const { rows: chunk } = await inventoryQueryOperations.getSnapshotAsOf({
          targetDate,
          tz: TZ,
          skuFilter: skuFilterDebounced || null,
          limit: pageStep,
          offset: off,
          sort,
        });
        all.push(...chunk);
        if (chunk.length === 0) break;
      }
      const data = all.map((r) => ({
        'SKU': r.skuId,
        'Description': r.description,
        'Type': r.productType,
        'Category': r.productCategory,
        'Unit': r.unit,
        'On Hand': r.onHand,
        'Average Cost': r.averageCost,
        'Total Value': r.totalValue,
        'Active Layers': r.activeLayers,
      }));
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(data);
      ws['!cols'] = [
        { wch: 30 }, { wch: 50 }, { wch: 10 }, { wch: 18 }, { wch: 8 },
        { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 10 },
      ];
      XLSX.utils.book_append_sheet(wb, ws, `Snapshot ${dateYmd}`);
      XLSX.writeFile(wb, `inventory-snapshot-${dateYmd}-all.xlsx`);
      toast.success(`Exported ${data.length} row(s)`);
    } catch (err: any) {
      toast.error('Export failed: ' + (err?.message ?? 'unknown error'));
    } finally {
      setExporting(false);
    }
  }, [total, targetDate, skuFilterDebounced, sort, dateYmd]);

  // Aggregate KPIs for the currently visible page (not the full filter).
  const pageTotals = useMemo(() => {
    let qty = 0, value = 0, nonZero = 0;
    for (const r of rows) {
      qty += r.onHand;
      value += r.totalValue;
      if (r.onHand > 0) nonZero += 1;
    }
    return { qty, value, nonZero };
  }, [rows]);

  return (
    <div className="space-y-4">
      <Card className="rounded-xl border border-dashed">
        <CardHeader className="py-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div>
              <CardTitle className="text-lg">Inventory Query</CardTitle>
              <p className="mt-1 text-sm text-slate-600">
                Reconstruct stock as of end-of-day in Toronto (TZ: {TZ}).
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-600">As of</span>
                <Input
                  type="date"
                  value={dateYmd}
                  onChange={(e) => setDateYmd(e.target.value)}
                  className="h-8 rounded-xl w-40"
                />
              </div>
              <Input
                type="text"
                placeholder="Filter by SKU or description…"
                value={skuFilter}
                onChange={(e) => setSkuFilter(e.target.value)}
                className="h-8 rounded-xl w-64"
              />
              <Select value={sort} onValueChange={(v) => setSort(v as InventoryQuerySort)}>
                <SelectTrigger className="h-8 w-[200px] rounded-xl">
                  <SelectValue placeholder="Sort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sku_code_asc">SKU (A→Z)</SelectItem>
                  <SelectItem value="sku_code_desc">SKU (Z→A)</SelectItem>
                  <SelectItem value="on_hand_desc">On hand (high→low)</SelectItem>
                  <SelectItem value="on_hand_asc">On hand (low→high)</SelectItem>
                  <SelectItem value="total_value_desc">Total value (high→low)</SelectItem>
                  <SelectItem value="total_value_asc">Total value (low→high)</SelectItem>
                </SelectContent>
              </Select>
              <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
                <SelectTrigger className="h-8 w-[110px] rounded-xl">
                  <SelectValue placeholder="Page size" />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((s) => (
                    <SelectItem key={s} value={String(s)}>{s}/page</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                onClick={loadSnapshot}
                disabled={loading}
                className="rounded-xl"
              >
                {loading ? (
                  <>
                    <span className="animate-spin inline-block w-3 h-3 border border-slate-500 border-t-transparent rounded-full mr-1" />
                    Loading…
                  </>
                ) : 'Refresh'}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-slate-600">
              {total > 0 ? (
                <>Showing <strong>{showingFrom.toLocaleString()}–{showingTo.toLocaleString()}</strong> of <strong>{total.toLocaleString()}</strong> SKUs</>
              ) : loading ? 'Loading…' : 'No SKUs match the current filter.'}
              {' '}· Page on-hand sum: <strong>{fmtQty(pageTotals.qty)}</strong>
              {' '}· Page value: <strong>{fmtMoney(pageTotals.value)}</strong>
              {' '}· SKUs with stock on this page: <strong>{pageTotals.nonZero}</strong>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={exportVisible}
                disabled={exporting || rows.length === 0}
                className="rounded-xl"
              >
                Export page ({rows.length})
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={exportAll}
                disabled={exporting || total === 0}
                className="rounded-xl bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
              >
                Export all ({total.toLocaleString()})
              </Button>
            </div>
          </div>

          <div className="rounded-xl border overflow-hidden">
            <Table className="w-full">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[28%]">SKU</TableHead>
                  <TableHead className="w-[30%]">Description</TableHead>
                  <TableHead className="w-[10%]">Type</TableHead>
                  <TableHead className="w-[8%] text-right">On hand</TableHead>
                  <TableHead className="w-[8%] text-right">Avg cost</TableHead>
                  <TableHead className="w-[10%] text-right">Total value</TableHead>
                  <TableHead className="w-[6%] text-right">Layers</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-slate-500 py-8">
                      No SKUs to display. Adjust the filter or date and try again.
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((r) => (
                  <TableRow
                    key={r.skuId}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => openDetail(r.skuId)}
                  >
                    <TableCell className="font-mono text-xs">{r.skuId}</TableCell>
                    <TableCell className="text-sm">{r.description}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{r.productType}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {fmtQty(r.onHand)} {r.unit}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {r.onHand > 0 ? fmtMoney(r.averageCost) : '—'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {fmtMoney(r.totalValue)}
                    </TableCell>
                    <TableCell className="text-right text-sm">{r.activeLayers}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <div className="text-xs text-slate-500">
                Page {page + 1} of {totalPages}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page === 0 || loading}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  className="rounded-xl"
                >
                  ← Prev
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page + 1 >= totalPages || loading}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded-xl"
                >
                  Next →
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Aggregate Daily Inventory Timeline — system-wide */}
      <Card className="rounded-xl border border-dashed">
        <CardHeader className="py-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div>
              <CardTitle className="text-lg">Daily Inventory Timeline</CardTitle>
              <p className="mt-1 text-sm text-slate-600">
                Daily movement activity across all SKUs, with end-of-day inventory value.
                Showing days with activity through <strong>{dateYmd}</strong>.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-600">Window</span>
              <Select
                value={aggDaysBack === null ? 'all' : String(aggDaysBack)}
                onValueChange={(v) => setAggDaysBack(v === 'all' ? null : Number(v))}
              >
                <SelectTrigger className="h-8 w-[170px] rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">Last 7 days</SelectItem>
                  <SelectItem value="30">Last 30 days</SelectItem>
                  <SelectItem value="90">Last 90 days</SelectItem>
                  <SelectItem value="365">Last 365 days</SelectItem>
                  <SelectItem value="all">All time</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                onClick={exportAggregateTimeline}
                disabled={aggExporting || aggTimelineLoading || !aggTimeline || aggTimeline.days.length === 0}
                className="rounded-xl bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
              >
                {aggExporting ? (
                  <>
                    <span className="animate-spin inline-block w-3 h-3 border border-blue-500 border-t-transparent rounded-full mr-1" />
                    Exporting…
                  </>
                ) : (
                  <>Export Excel ({aggTimeline?.days.length ?? 0})</>
                )}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {aggTimelineLoading && (
            <div className="text-sm text-slate-500 py-6 text-center">
              <span className="animate-spin inline-block w-3 h-3 border border-slate-500 border-t-transparent rounded-full mr-1" />
              Loading timeline…
            </div>
          )}
          {!aggTimelineLoading && aggTimeline && (
            <>
              {/* KPI strip: most recent day */}
              {aggTimeline.days.length > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                  <KpiBlock label="Most recent activity"  value={aggTimeline.days[0].date} />
                  <KpiBlock label="Inventory value (close)" value={fmtMoney(aggTimeline.days[0].closingValueUsd)} />
                  <KpiBlock
                    label="Δ vs previous day"
                    value={Math.abs(aggTimeline.days[0].deltaValue) > 0.005 ? fmtSignedMoney(aggTimeline.days[0].deltaValue) : '—'}
                  />
                  <KpiBlock label="Active FIFO layers" value={String(aggTimeline.days[0].activeLayerCount)} />
                </div>
              )}

              <div className="rounded-xl border overflow-hidden">
                <Table className="w-full">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[12%]">Date</TableHead>
                      <TableHead className="w-[34%]">Movements (type × |qty|)</TableHead>
                      <TableHead className="text-right w-[10%]">Movements</TableHead>
                      <TableHead className="text-right w-[10%]">SKUs touched</TableHead>
                      <TableHead className="text-right w-[10%]">Active layers</TableHead>
                      <TableHead className="text-right w-[12%]">Closing value</TableHead>
                      <TableHead className="text-right w-[12%]">Δ vs prev</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {aggTimeline.days.length === 0 && !openingBalance && (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center text-slate-500 py-6">
                          No movement activity in the selected window.
                        </TableCell>
                      </TableRow>
                    )}
                    {openingBalance && (
                      <TableRow className="bg-slate-50/60">
                        <TableCell className="text-sm font-medium">
                          <span className="flex items-center gap-2">
                            <span>{OPENING_BALANCE_DATE}</span>
                            <span className="inline-flex items-center rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                              Opening Balance
                            </span>
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="text-xs text-slate-500 italic">
                            Initial stock load — no movements
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm text-slate-400">—</TableCell>
                        <TableCell className="text-right font-mono text-sm text-slate-400">—</TableCell>
                        <TableCell className="text-right font-mono text-sm">{openingBalance.layers}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{fmtMoney(openingBalance.value)}</TableCell>
                        <TableCell className="text-right font-mono text-sm text-slate-400">—</TableCell>
                      </TableRow>
                    )}
                    {aggTimeline.days.map((d) => (
                      <TableRow
                        key={d.date}
                        className="cursor-pointer hover:bg-slate-50"
                        onClick={() => openDayDrill(d.date)}
                        title="Click to see all movements on this day"
                      >
                        <TableCell className="text-sm font-medium">
                          <span className="flex items-center gap-1">
                            <span>{d.date}</span>
                            <svg className="w-3 h-3 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {d.movementsByType.map((mt) => (
                              <MovementChip key={mt.type} mt={mt} />
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">{d.movementCount}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{d.skuCount}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{d.activeLayerCount}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{fmtMoney(d.closingValueUsd)}</TableCell>
                        <TableCell className={`text-right font-mono text-sm font-semibold ${signColor(d.deltaValue)}`}>
                          {Math.abs(d.deltaValue) > 0.005 ? fmtSignedMoney(d.deltaValue) : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Drill-down */}
      <Dialog open={detailSkuId !== null} onOpenChange={(o) => { if (!o) closeDetail(); }}>
        <DialogContent className="max-w-5xl w-[95vw]">
          <DialogHeader>
            <DialogTitle className="text-base">
              <span className="font-mono text-sm">{detailSkuId}</span>
              <span className="ml-2 text-xs font-normal text-slate-500">as of {dateYmd} ({TZ})</span>
            </DialogTitle>
          </DialogHeader>
          <div className="px-6 pb-6 space-y-4">
            {detailLoading && (
              <div className="text-sm text-slate-600 py-8 text-center">
                <span className="animate-spin inline-block w-3 h-3 border border-slate-500 border-t-transparent rounded-full mr-1" />
                Loading drill-down…
              </div>
            )}
            {!detailLoading && detail && (
              <>
                {/* Totals */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <KpiBlock label="On hand"  value={fmtQty(detail.totals.onHand)} />
                  <KpiBlock label="Avg cost" value={detail.totals.onHand > 0 ? fmtMoney(detail.totals.averageCost) : '—'} />
                  <KpiBlock label="Value"    value={fmtMoney(detail.totals.totalValue)} />
                  <KpiBlock label="Layers"   value={String(detail.totals.layerCount)} />
                </div>

                {detail.totals.hasAdjustments && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    <strong>Heads up:</strong> this SKU has ADJUSTMENT movements in its history.
                    ADJUSTMENT does not consume FIFO layers, so the reconstructed quantity above
                    may differ from <code>skus.on_hand</code>. The FIFO numbers reflect what the
                    layers actually contain; the difference is the manual adjustment delta.
                  </div>
                )}

                {/* FIFO layers */}
                <div>
                  <h4 className="text-sm font-semibold text-slate-700 mb-2">
                    FIFO layers active at end of {dateYmd}
                  </h4>
                  <div className="rounded-xl border overflow-hidden">
                    <Table className="w-full">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Layer</TableHead>
                          <TableHead>Receiving date</TableHead>
                          <TableHead>Vendor</TableHead>
                          <TableHead>Packing slip</TableHead>
                          <TableHead className="text-right">Unit cost</TableHead>
                          <TableHead className="text-right">Original</TableHead>
                          <TableHead className="text-right">Remaining</TableHead>
                          <TableHead className="text-right">Value</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.layers.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={8} className="text-center text-slate-500 py-4">
                              No active FIFO layers for this SKU on this date.
                            </TableCell>
                          </TableRow>
                        )}
                        {detail.layers.map((l) => (
                          <TableRow key={l.layerId}>
                            <TableCell className="font-mono text-xs">{l.layerId}</TableCell>
                            <TableCell>{fmtDateOnly(l.receivingDate)}</TableCell>
                            <TableCell>{l.vendorName ?? <span className="text-slate-400">—</span>}</TableCell>
                            <TableCell>{l.packingSlipNo ?? <span className="text-slate-400">—</span>}</TableCell>
                            <TableCell className="text-right font-mono text-sm">{fmtMoney(l.unitCost)}</TableCell>
                            <TableCell className="text-right font-mono text-sm">{fmtQty(l.originalQuantity)}</TableCell>
                            <TableCell className="text-right font-mono text-sm">{fmtQty(l.qtyRemainingAsOf)}</TableCell>
                            <TableCell className="text-right font-mono text-sm">{fmtMoney(l.valueAsOf)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>

                {/* Daily Timeline (extrato dia a dia) */}
                <div>
                  <h4 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
                    <span>Daily Timeline</span>
                    <span className="text-xs font-normal text-slate-500">
                      activity days through {dateYmd}
                    </span>
                  </h4>
                  {skuTimelineLoading && (
                    <div className="text-sm text-slate-500 py-4 text-center">
                      <span className="animate-spin inline-block w-3 h-3 border border-slate-500 border-t-transparent rounded-full mr-1" />
                      Loading timeline…
                    </div>
                  )}
                  {!skuTimelineLoading && skuTimeline && (
                    <div className="rounded-xl border overflow-hidden">
                      <Table className="w-full">
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-[14%]">Date</TableHead>
                            <TableHead className="w-[32%]">Movements (type × qty)</TableHead>
                            <TableHead className="text-right w-[10%]">In (+)</TableHead>
                            <TableHead className="text-right w-[10%]">Out (−)</TableHead>
                            <TableHead className="text-right w-[10%]">Δ Net</TableHead>
                            <TableHead className="text-right w-[10%]">Closing qty</TableHead>
                            <TableHead className="text-right w-[7%]">Avg cost</TableHead>
                            <TableHead className="text-right w-[7%]">Closing value</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {skuTimeline.days.length === 0 && (
                            <TableRow>
                              <TableCell colSpan={8} className="text-center text-slate-500 py-4">
                                No movement activity for this SKU through the selected date.
                              </TableCell>
                            </TableRow>
                          )}
                          {skuTimeline.days.map((d) => (
                            <TableRow key={d.date} className="hover:bg-slate-50">
                              <TableCell className="text-sm font-medium">{d.date}</TableCell>
                              <TableCell>
                                <div className="flex flex-wrap gap-1">
                                  {d.movementsByType.map((mt) => (
                                    <MovementChip key={mt.type} mt={mt} />
                                  ))}
                                </div>
                              </TableCell>
                              <TableCell className={`text-right font-mono text-sm ${d.grossIn > 0 ? 'text-emerald-700' : 'text-slate-400'}`}>
                                {d.grossIn > 0 ? fmtQtySigned(d.grossIn) : '—'}
                              </TableCell>
                              <TableCell className={`text-right font-mono text-sm ${d.grossOut < 0 ? 'text-red-700' : 'text-slate-400'}`}>
                                {d.grossOut < 0 ? fmtQtySigned(d.grossOut) : '—'}
                              </TableCell>
                              <TableCell className={`text-right font-mono text-sm font-semibold ${signColor(d.netDelta)}`}>
                                {fmtQtySigned(d.netDelta)}
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">
                                <div>{fmtQty(d.closingQty)}</div>
                                <div className={`text-xs ${signColor(d.deltaQty)}`}>
                                  {Math.abs(Math.round(d.deltaQty)) > 0 ? `(${fmtQtySigned(d.deltaQty)} vs prev)` : ''}
                                </div>
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">
                                {d.closingQty > 0 ? fmtMoney(d.avgCost) : '—'}
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">
                                <div>{fmtMoney(d.closingValue)}</div>
                                <div className={`text-xs ${signColor(d.deltaValue)}`}>
                                  {Math.abs(d.deltaValue) > 0.005 ? `(${fmtSignedMoney(d.deltaValue)})` : ''}
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>

                {/* Day movements */}
                <div>
                  <h4 className="text-sm font-semibold text-slate-700 mb-2">
                    Movements on {dateYmd}
                  </h4>
                  <div className="rounded-xl border overflow-hidden">
                    <Table className="w-full">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Time</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead className="text-right">Quantity</TableHead>
                          <TableHead className="text-right">Unit cost</TableHead>
                          <TableHead className="text-right">Value</TableHead>
                          <TableHead>Reference</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.dayMovements.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={6} className="text-center text-slate-500 py-4">
                              No movements for this SKU on this date.
                            </TableCell>
                          </TableRow>
                        )}
                        {detail.dayMovements.map((m) => (
                          <TableRow key={m.movementId}>
                            <TableCell className="text-xs">{fmtDatetime(m.datetime)}</TableCell>
                            <TableCell>
                              <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${movementBadgeClass(m.type)}`}>
                                {m.type}
                              </span>
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">{fmtQty(m.quantity)}</TableCell>
                            <TableCell className="text-right font-mono text-sm">{m.unitCost === null ? '—' : fmtMoney(m.unitCost)}</TableCell>
                            <TableCell className="text-right font-mono text-sm">{fmtMoney(m.totalValue)}</TableCell>
                            <TableCell className="text-xs">{m.reference}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>

                <div className="flex justify-end pt-2">
                  <Button size="sm" variant="outline" onClick={closeDetail} className="rounded-xl">
                    Close
                  </Button>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Day drill-down: all movements on a specific day, grouped by SKU */}
      <Dialog open={dayDrillDate !== null} onOpenChange={(o) => { if (!o) closeDayDrill(); }}>
        <DialogContent className="max-w-6xl w-[95vw]">
          <DialogHeader>
            <DialogTitle className="text-base">
              <span>Day breakdown — {dayDrillDate}</span>
              <span className="ml-2 text-xs font-normal text-slate-500">({TZ})</span>
            </DialogTitle>
          </DialogHeader>
          <div className="px-6 pb-6 space-y-4">
            {dayDrillLoading && (
              <div className="text-sm text-slate-600 py-8 text-center">
                <span className="animate-spin inline-block w-3 h-3 border border-slate-500 border-t-transparent rounded-full mr-1" />
                Loading day movements…
              </div>
            )}
            {!dayDrillLoading && dayDrill && (
              <>
                {/* Day-level KPIs */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <KpiBlock label="Total movements"  value={String(dayDrill.totals.movementCount)} />
                  <KpiBlock label="SKUs touched"     value={String(dayDrill.totals.skuCount)} />
                  <KpiBlock label="Inflow value"     value={fmtMoney(dayDrill.totals.grossInValue)} />
                  <KpiBlock label="Outflow value"    value={fmtMoney(Math.abs(dayDrill.totals.grossOutValue))} />
                </div>

                <div className="flex items-center justify-between">
                  <div className="text-sm text-slate-600">
                    Grouped by SKU, sorted by absolute value (largest first).
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={exportDayDrill}
                    disabled={dayDrillExporting || dayDrill.totals.movementCount === 0}
                    className="rounded-xl bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
                  >
                    {dayDrillExporting ? (
                      <>
                        <span className="animate-spin inline-block w-3 h-3 border border-blue-500 border-t-transparent rounded-full mr-1" />
                        Exporting…
                      </>
                    ) : 'Export Excel'}
                  </Button>
                </div>

                {dayDrill.groups.length === 0 && (
                  <div className="rounded-lg border bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                    No active movements on this day.
                  </div>
                )}

                <div className="space-y-3">
                  {dayDrill.groups.map((g, gi) => (
                    <div key={`${g.skuId}-${gi}`} className="rounded-xl border overflow-hidden">
                      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 px-4 py-2 border-b">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-sm font-semibold">
                              {g.skuId || '(PRODUCE output)'}
                            </span>
                            {g.productType && <Badge variant="secondary">{g.productType}</Badge>}
                            <span className="text-xs text-slate-500">{g.movementCount} movement{g.movementCount === 1 ? '' : 's'}</span>
                          </div>
                          {g.skuDescription && (
                            <div className="text-xs text-slate-600 truncate">{g.skuDescription}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-4 text-sm">
                          <div>
                            <span className="text-slate-500">Net qty: </span>
                            <span className={`font-mono font-semibold ${signColor(g.netQty)}`}>
                              {fmtQtySigned(g.netQty)} {g.unit}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-500">Value: </span>
                            <span className={`font-mono font-semibold ${signColor(g.totalValue)}`}>
                              {fmtSignedMoney(g.totalValue)}
                            </span>
                          </div>
                        </div>
                      </div>
                      <Table className="w-full">
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-[10%]">Time</TableHead>
                            <TableHead className="w-[12%]">Type</TableHead>
                            <TableHead className="text-right w-[12%]">Quantity</TableHead>
                            <TableHead className="text-right w-[10%]">Unit cost</TableHead>
                            <TableHead className="text-right w-[12%]">Value</TableHead>
                            <TableHead className="w-[18%]">Reference / WO</TableHead>
                            <TableHead className="w-[18%]">Vendor / Notes</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {g.movements.map((m) => (
                            <TableRow key={m.movementId}>
                              <TableCell className="text-xs font-mono">{fmtTimeOnly(m.datetime)}</TableCell>
                              <TableCell>
                                <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${movementBadgeClass(m.type)}`}>
                                  {m.type}
                                </span>
                              </TableCell>
                              <TableCell className={`text-right font-mono text-sm ${signColor(m.quantity)}`}>
                                {fmtQtySigned(m.quantity)}
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">
                                {m.unitCost === null ? '—' : fmtMoney(m.unitCost)}
                              </TableCell>
                              <TableCell className={`text-right font-mono text-sm ${signColor(m.totalValue)}`}>
                                {fmtSignedMoney(m.totalValue)}
                              </TableCell>
                              <TableCell className="text-xs">
                                <div>{m.reference}</div>
                                {m.workOrderId && (
                                  <div className="text-slate-500 font-mono">{m.workOrderId}</div>
                                )}
                                {m.packingSlipNo && !m.workOrderId && (
                                  <div className="text-slate-500">Slip: {m.packingSlipNo}</div>
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                {m.vendorName && <div className="font-medium text-slate-700">{m.vendorName}</div>}
                                {m.productName && <div className="text-slate-500 italic">→ {m.productName}</div>}
                                {m.notes && <div className="text-slate-500">{m.notes}</div>}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ))}
                </div>

                <div className="flex justify-end pt-2">
                  <Button size="sm" variant="outline" onClick={closeDayDrill} className="rounded-xl">
                    Close
                  </Button>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function KpiBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-slate-50 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-base font-semibold text-slate-900 font-mono">{value}</div>
    </div>
  );
}

function fmtSignedMoney(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return n >= 0 ? `+${abs}` : `−${abs}`;
}

function signColor(n: number): string {
  if (!Number.isFinite(n) || n === 0) return 'text-slate-500';
  return n > 0 ? 'text-emerald-700' : 'text-red-700';
}

function MovementChip({ mt }: { mt: TimelineMovementByType }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium ${movementBadgeClass(mt.type)}`}
      title={`${mt.count} movement${mt.count === 1 ? '' : 's'}`}
    >
      <span>{mt.type}</span>
      <span className="font-mono">{fmtQtySigned(mt.qty)}</span>
    </span>
  );
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return v;
}
