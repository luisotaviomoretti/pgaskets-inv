import React, { useEffect, useMemo, useState } from "react";
import { Package, ClipboardList, BarChart3, Layers, DollarSign, AlertTriangle, ChevronDown, ChevronUp, Building2, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as XLSX from "xlsx";

// ============================================================================
// Helper UI
// ============================================================================
function SectionCard({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="rounded-2xl shadow-sm border border-dashed">
      <CardHeader className="flex flex-row items-center gap-2 py-4">
        {icon}
        <CardTitle className="text-lg font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pb-6">{children}</CardContent>
    </Card>
  );
}

export type Vendor = { name: string; address?: string; bank?: string; email?: string; phone?: string };
function VendorAutocomplete({ value, onChange, suggestions }: { value: string; onChange: (v: string) => void; suggestions: Vendor[] }) {
  const [query, setQuery] = useState(value || "");
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Vendor[]>([]);

  useEffect(() => { setQuery(value || ""); }, [value]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (query.trim().length >= 3) {
        const q = query.trim().toLowerCase();
        const f = suggestions.filter(v => v.name.toLowerCase().includes(q)).slice(0, 8);
        setList(f); setOpen(f.length > 0);
      } else { setList([]); setOpen(false); }
      onChange(query);
    }, 300);
    return () => clearTimeout(t);
  }, [query, suggestions, onChange]);

  const best = list[0]?.name || "";
  const completion = best.toLowerCase().startsWith((query||"").toLowerCase()) ? best.slice(query.length) : "";

  return (
    <div className="relative">
      <div className="pointer-events-none absolute inset-0 flex items-center px-3 text-slate-400/60">
        <span className="invisible">{query}</span>
        <span>{completion}</span>
      </div>
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g., ABC Metals" className="relative bg-transparent"/>
      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 rounded-xl border bg-white shadow-lg overflow-hidden">
          {list.map((v, idx) => (
            <button key={idx} type="button" className="w-full text-left px-3 py-2 hover:bg-slate-50"
              onClick={() => { setQuery(v.name); setOpen(false); onChange(v.name); }}>
              <div className="text-sm font-medium">{v.name}</div>
              {(v.address || v.bank) && (
                <div className="text-xs text-slate-500 truncate">{v.address ?? ""}{v.address && v.bank ? " • " : ""}{v.bank ?? ""}</div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Domain types
// ============================================================================
export type MaterialType = 'RAW' | 'SELLABLE';
export type ProductCategory =
  | 'Adhesives' | 'Boxes' | 'Cork/Rubber' | 'Polyurethane Ester' | 'Polyurethane Ether' | 'Felt' | 'Fibre Foam' | 'Film and Foil';

export type SKU = {
  id: string;
  description?: string;
  type: MaterialType;
  productCategory: ProductCategory;
  unit?: string;
  active?: boolean;
  min?: number;
  onHand?: number;
};

function SKUSelect({ skus, value, onChange, placeholder, filter }: { skus: SKU[]; value?: string; onChange: (v: string) => void; placeholder?: string; filter?: MaterialType }) {
  const items = useMemo(() => skus.filter(s => !filter || s.type === filter), [skus, filter]);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue placeholder={placeholder || 'Select SKU'} /></SelectTrigger>
      <SelectContent>
        {items.map(s => (
          <SelectItem key={s.id} value={s.id}>{s.id}{s.description ? ` — ${s.description}` : ''}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Mini spark bars
function SparkBars({ data, height = 40, formatValue }: { data: number[]; height?: number; formatValue?: (v: number) => string }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(...data, 1);
  const BAR_W = 8, GAP = 4;
  return (
    <div className="relative flex items-end gap-1 h-full" style={{ minHeight: height }} onMouseLeave={() => setHovered(null)}>
      {data.map((v, i) => (
        <div key={i} className="w-2 rounded-sm bg-black/90 transition-opacity"
          style={{ height: `${Math.max(6, Math.round((v / max) * height))}px`, opacity: hovered === null || hovered === i ? 1 : 0.25 }}
          onMouseEnter={() => setHovered(i)} title={formatValue ? formatValue(v) : String(v)} aria-label={`bar-${i}`} />
      ))}
      {hovered !== null && (
        <div className="absolute -top-6 text-[10px] px-1.5 py-0.5 rounded bg-black text-white shadow pointer-events-none" style={{ left: hovered * (BAR_W + GAP) }}>
          {formatValue ? formatValue(data[hovered]) : data[hovered]}
        </div>
      )}
    </div>
  );
}

function MetricCard({ title, primary, secondary, unitPrimary, unitSecondary, series, direction, valueFormatter }: {
  title: string; primary: string; secondary?: string; unitPrimary?: string; unitSecondary?: string; series: number[]; direction?: "up" | "down" | "flat"; valueFormatter?: (v: number) => string;
}) {
  const delta = useMemo(() => {
    if (!series || series.length < 2) return 0;
    const first = series[0]; const last = series[series.length - 1]; if (first === 0) return 0; return ((last - first) / Math.abs(first)) * 100;
  }, [series]);
  const isUp = (direction === "up") || (direction === undefined && delta >= 0);
  const isFlat = Math.abs(delta) < 0.1;
  return (
    <Card className="rounded-2xl border-dashed">
      <CardContent className="p-4">
        <div className="text-xs text-slate-500 mb-1">{title}</div>
        <div>
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-semibold">{primary}</p>
            {unitPrimary && <span className="text-sm text-slate-500">{unitPrimary}</span>}
          </div>
          {secondary && (<p className="text-sm text-slate-500">{secondary} {unitSecondary ?? ""}</p>)}
          <div className={`mt-2 text-xs ${isFlat ? "text-slate-500" : isUp ? "text-emerald-600" : "text-red-600"}`}>{isFlat ? "±0%" : `${isUp ? "+" : ""}${delta.toFixed(1)}%`}</div>
          <div className="mt-3 h-14"><SparkBars data={series} height={56} formatValue={valueFormatter} /></div>
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Time window helpers (Dashboard)
// ============================================================================
const ONE_DAY = 24 * 60 * 60 * 1000;
function parseStamp(s: string): Date {
  const [d, t] = s.split(' '); const [Y, M, D] = d.split('-').map(Number); const [h, m] = (t || '00:00').split(':').map(Number);
  return new Date(Y, (M || 1) - 1, D || 1, h || 0, m || 0);
}
function getRange(period: 'today'|'last7'|'month'|'quarter'|'custom', customStart?: string, customEnd?: string): [number, number] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (period === 'today') return [startOfToday, now.getTime()];
  if (period === 'last7') return [now.getTime() - 7 * ONE_DAY, now.getTime()];
  if (period === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), now.getTime()];
  if (period === 'quarter') {
    const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
    return [new Date(now.getFullYear(), qStartMonth, 1).getTime(), now.getTime()];
  }
  const s = customStart ? +parseStamp(customStart) : startOfToday;
  const eRaw = customEnd ? +parseStamp(customEnd) : now.getTime();
  const e = Math.max(s, eRaw + (ONE_DAY - 1));
  return [Math.min(s, e), e];
}
function buildBins(start: number, end: number, n = 7): Array<[number, number]> {
  const bins: Array<[number, number]> = [];
  const step = Math.max(1, Math.floor((end - start) / n));
  for (let i = 0; i < n; i++) {
    const s = start + i * step;
    const e = i === n - 1 ? end : start + (i + 1) * step;
    bins.push([s, e]);
  }
  return bins;
}

// ============================================================================
// Mock data
// ============================================================================
const MOCK_VENDORS: Vendor[] = [
  { name: "ABC Metals LLC", address: "123 Industrial Ave, Austin, TX", bank: "Chase • ****-1234", email: "ap@abcmetals.com", phone: "+1 512 555 0101" },
  { name: "GasketCo Supplies", address: "910 Gasket Rd, Chicago, IL", bank: "BoA • ****-8745", email: "billing@gasketco.com", phone: "+1 312 555 0144" },
  { name: "Premier Rubber", address: "77 Harbor St, Long Beach, CA", bank: "Wells • ****-4412" },
  { name: "Silicone Works", address: "8 Tech Park, Reno, NV" },
  { name: "MetalSource Inc.", address: "4 Forge Blvd, Detroit, MI" },
  { name: "Gasket & Seals Partners", address: "55 Supply Way, Phoenix, AZ" },
];

const CATEGORY_OPTIONS: ProductCategory[] = ['Adhesives','Boxes','Cork/Rubber','Polyurethane Ester','Polyurethane Ether','Felt','Fibre Foam','Film and Foil'];

const MOCK_SKUS: SKU[] = [
  { id: 'SKU-001', description: 'GAX-12', type: 'RAW',        productCategory: 'Cork/Rubber',     unit: 'unit', min: 100, onHand: 80 },
  { id: 'SKU-002', description: 'GAX-16', type: 'RAW',        productCategory: 'Adhesives',        unit: 'unit', min: 150, onHand: 200 },
  { id: 'P-001',   description: 'Gasket P-001', type: 'SELLABLE', productCategory: 'Fibre Foam',     unit: 'unit', min: 180, onHand: 210 },
  { id: 'P-002',   description: 'Gasket P-002', type: 'SELLABLE', productCategory: 'Film and Foil',  unit: 'unit', min: 120, onHand: 90 },
];

// ============================================================================
// FIFO + Receiving logic
// ============================================================================
export type Layer = { id: string; date: string; remaining: number; cost: number };
const INITIAL_LAYERS: Record<string, Layer[]> = {
  'SKU-001': [ { id: 'SKU-001-L1', date: '2025-07-01', remaining: 60, cost: 5.20 }, { id: 'SKU-001-L2', date: '2025-07-15', remaining: 20, cost: 5.40 } ],
  'SKU-002': [ { id: 'SKU-002-L1', date: '2025-08-01', remaining: 150, cost: 5.40 }, { id: 'SKU-002-L2', date: '2025-08-10', remaining: 50, cost: 5.50 } ],
  'P-001':   [ { id: 'P-001-L1', date: '2025-08-02', remaining: 120, cost: 12.73 }, { id: 'P-001-L2', date: '2025-08-06', remaining: 90, cost: 12.91 } ],
  'P-002':   [ { id: 'P-002-L1', date: '2025-08-04', remaining: 90,  cost: 12.91 } ],
};

const fmtMoney = (n: number) => `$ ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type DamageScope = 'NONE' | 'FULL' | 'PARTIAL';
interface DamageOutcome { mode: 'APPROVE' | 'REJECT_ALL' | 'PARTIAL'; acceptQty: number; rejectQty: number }
function damageOutcome(qty: number, damaged: boolean, scope: DamageScope, rejected: number = 0): DamageOutcome {
  const q = Math.max(0, Math.floor(qty || 0));
  if (!damaged || scope === 'NONE') return { mode: 'APPROVE', acceptQty: q, rejectQty: 0 };
  if (scope === 'FULL') return { mode: 'REJECT_ALL', acceptQty: 0, rejectQty: q };
  const r = Math.max(0, Math.min(q, Math.floor(rejected || 0)));
  const a = Math.max(0, q - r);
  return { mode: a > 0 ? 'PARTIAL' : 'REJECT_ALL', acceptQty: a, rejectQty: r };
}

function fifoAvgCost(layers: Layer[] | undefined): number | null {
  if (!layers || layers.length === 0) return null;
  const totalQty = layers.reduce((s, l) => s + Math.max(0, l.remaining), 0);
  if (totalQty <= 0) return null;
  const totalVal = layers.reduce((s, l) => s + Math.max(0, l.remaining) * l.cost, 0);
  return totalVal / totalQty;
}
function fifoPlan(layers: Layer[] | undefined, issueQty: number): Array<{ layerId: string; qty: number; cost: number }> {
  if (!layers || issueQty <= 0) return [];
  let need = Math.max(0, Math.floor(issueQty));
  const plan: Array<{ layerId: string; qty: number; cost: number }> = [];
  for (const l of layers) {
    if (need <= 0) break;
    const take = Math.min(need, Math.max(0, l.remaining));
    if (take > 0) { plan.push({ layerId: l.id, qty: take, cost: l.cost }); need -= take; }
  }
  return plan;
}

// ============================================================================
// Main component
// ============================================================================
export default function InventoryWireframes() {
  type PeriodOption = 'today' | 'last7' | 'month' | 'quarter' | 'custom';
  const [tab, setTab] = useState("dashboard");
  const [period, setPeriod] = useState<PeriodOption>('last7');
  const [customStart, setCustomStart] = useState<string>('');
  const [customEnd, setCustomEnd] = useState<string>('');

  const [vendors, setVendors] = useState<Vendor[]>(MOCK_VENDORS);
  const [vendorValue, setVendorValue] = useState("");
  const [vendorsOpen, setVendorsOpen] = useState(false);
  const [skuMaster, setSkuMaster] = useState<SKU[]>(MOCK_SKUS);
  const [skus, setSkus] = useState<SKU[]>(MOCK_SKUS);
  const [skusOpen, setSkusOpen] = useState(false);
  const [receivingSku, setReceivingSku] = useState("");
  const [woRawSku, setWoRawSku] = useState("");
  const [woRawQty, setWoRawQty] = useState<number>(0);
  const [woOutputName, setWoOutputName] = useState<string>("");
  const [woProducedQty, setWoProducedQty] = useState<number>(0);

  // receiving — damaged flow state
  const [receivingQty, setReceivingQty] = useState<number>(0);
  const [isDamaged, setIsDamaged] = useState(false);
  const [damageScope, setDamageScope] = useState<DamageScope>('NONE');
  const [rejectedQty, setRejectedQty] = useState<number>(0);

  const outcome = useMemo(() => damageOutcome(receivingQty, isDamaged, damageScope, rejectedQty), [receivingQty, isDamaged, damageScope, rejectedQty]);

  const [layersBySku, setLayersBySku] = useState<Record<string, Layer[]>>(INITIAL_LAYERS);

  type Movement = { datetime: string; type: 'RECEIVE' | 'ISSUE' | 'WASTE' | 'PRODUCE'; skuOrName: string; qty: number; value: number; ref: string };
  const [movementLog, setMovementLog] = useState<Movement[]>([
    { datetime: '2025-08-06 10:21', type: 'WASTE',  skuOrName: 'SKU-001', qty: -12,  value: 62.40,  ref: 'WO-00425' },
    { datetime: '2025-08-06 10:20', type: 'ISSUE',  skuOrName: 'SKU-001', qty: -180, value: 936.00, ref: 'WO-00425' },
  ]);

  // ---------------- Self-tests (dev) ----------------
  useEffect(() => {
    const fails: string[] = [];
    const assert = (cond: any, msg: string) => { if (!cond) fails.push(msg); };
    // fifoAvgCost -> 3
    const avg = fifoAvgCost([{ id: 'L1', date: '2025-01-01', remaining: 10, cost: 2 }, { id: 'L2', date: '2025-01-02', remaining: 10, cost: 4 }]);
    assert(avg && Math.abs(avg - 3) < 1e-6, 'fifoAvgCost expected 3');
    // fifoPlan -> [5,3]
    const plan = fifoPlan([{ id: 'L1', date: 'd', remaining: 5, cost: 2 }, { id: 'L2', date: 'd', remaining: 7, cost: 3 }], 8);
    assert(plan.length === 2 && plan[0].qty === 5 && plan[1].qty === 3, 'fifoPlan expected [5,3]');
    // parseStamp finite
    const ts = +parseStamp('2025-08-06 10:21');
    assert(Number.isFinite(ts), 'parseStamp produced NaN');
    // bins 7
    const wins = buildBins(Date.now()-7*ONE_DAY, Date.now(), 7);
    assert(wins.length === 7, 'bins length != 7');
    // getRange sanity
    const [cs, ce] = getRange('custom', '2025-01-10', '2025-01-12');
    assert(ce > cs && ce - cs >= 2*ONE_DAY - 1, 'getRange custom wrong');
    const [ls, le] = getRange('last7');
    assert(le > ls && (le - ls) >= 5*ONE_DAY, 'getRange last7 too short');
    // monotonic bins
    let okMono = true; for (let i=1;i<wins.length;i++){ if (wins[i][0] < wins[i-1][0]) okMono = false; }
    assert(okMono, 'bins not monotonic');
    if (fails.length) console.warn('[SELF-TEST FAIL]', fails);
  }, []);

  // Period helpers (range + bins)
  const { rangeStart, rangeEnd, bins } = useMemo(() => {
    const [start, end] = getRange(period, customStart, customEnd);
    return { rangeStart: start, rangeEnd: end, bins: buildBins(start, end, 7) };
  }, [period, customStart, customEnd]);

  // helper to render traffic light
  const TrafficLight = ({ ok }: { ok: boolean }) => (
    <div className="flex items-center gap-2">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
      <span className={`text-xs ${ok ? 'text-emerald-700' : 'text-red-700'}`}>{ok ? 'OK' : 'Below minimum'}</span>
    </div>
  );

  // Dashboard grouping state (expand/collapse per Category)
  const [expanded, setExpanded] = useState<Record<ProductCategory, boolean>>({
    'Adhesives': false,
    'Boxes': false,
    'Cork/Rubber': false,
    'Polyurethane Ester': false,
    'Polyurethane Ether': false,
    'Felt': false,
    'Fibre Foam': false,
    'Film and Foil': false,
  });
  const toggleCat = (c: ProductCategory) => setExpanded(prev => ({ ...prev, [c]: !prev[c] }));

  // Group SKUs by Category
  const grouped = useMemo(() => {
    const map: Record<ProductCategory, SKU[]> = {
      'Adhesives': [],'Boxes': [],'Cork/Rubber': [],'Polyurethane Ester': [],'Polyurethane Ether': [],'Felt': [],'Fibre Foam': [],'Film and Foil': [],
    };
    for (const s of skus) map[s.productCategory].push(s);
    return map;
  }, [skus]);

  // FIFO derived values for Dashboard rows
  const avgCostFor = (skuId: string) => fifoAvgCost(layersBySku[skuId]);

  // --- Export helpers (Excel) ---
  function buildExportRows(source: SKU[], redOnly: boolean) {
    return source
      .filter((s) => {
        const qty = s.onHand ?? 0;
        const min = s.min ?? 0;
        return redOnly ? qty < min : true;
      })
      .map((s) => {
        const qty = s.onHand ?? 0;
        const avg = avgCostFor(s.id);
        const value = avg != null ? +(qty * avg) : null; // keep numeric for Excel
        return {
          Category: s.productCategory,
          SKU: s.id,
          Description: s.description ?? "",
          "U/M": s.unit ?? "",
          Type: s.type === 'RAW' ? 'Raw' : 'Sellable',
          "On hand": qty,
          "Avg. cost (FIFO)": avg ?? null,
          "Asset value": value,
          Minimum: s.min ?? 0,
          Status: qty >= (s.min ?? 0) ? 'OK' : 'Below minimum',
        } as const;
      });
  }
  async function exportInventory(redOnly: boolean) {
    if (typeof window === "undefined") { console.warn("Excel export is only available in the browser runtime."); return; }
    const rows = buildExportRows(skuMaster, redOnly);
    const headers = ["Category","SKU","Description","U/M","Type","On hand","Avg. cost (FIFO)","Asset value","Minimum","Status"];
    const ws = XLSX.utils.json_to_sheet(rows as any, { header: headers as any, skipHeader: false });
    (ws as any)['!cols'] = [ { wch: 18 }, { wch: 14 }, { wch: 28 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 14 } ];
    if ((ws as any)['!ref']) {
      const range = XLSX.utils.decode_range((ws as any)['!ref'] as string);
      for (let R = range.s.r + 1; R <= range.e.r; ++R) {
        const avgAddr = XLSX.utils.encode_cell({ c: 6, r: R });
        const valAddr = XLSX.utils.encode_cell({ c: 7, r: R });
        const avgCell = (ws as any)[avgAddr];
        const valCell = (ws as any)[valAddr];
        if (avgCell && typeof avgCell.v === 'number') avgCell.z = '$0.00';
        if (valCell && typeof valCell.v === 'number') valCell.z = '$0.00';
      }
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, redOnly ? 'Red flags' : 'All SKUs');
    const now = new Date(); const yyyy = now.getFullYear(); const mm = String(now.getMonth() + 1).padStart(2, '0'); const dd = String(now.getDate()).padStart(2, '0');
    const filename = redOnly ? `inventory_red_flags_${yyyy}${mm}${dd}.xlsx` : `inventory_all_${yyyy}${mm}${dd}.xlsx`;
    XLSX.writeFile(wb, filename, { compression: true });
  }

  // --- WO helpers ---
  const woPlan = useMemo(() => fifoPlan(layersBySku[woRawSku], woRawQty), [layersBySku, woRawSku, woRawQty]);
  const woPlanTotal = useMemo(() => woPlan.reduce((s, p) => s + p.qty * p.cost, 0), [woPlan]);
  function finalizeWO() {
    if (!woOutputName.trim() || woProducedQty <= 0) return;
    const now = new Date(); const stamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    setMovementLog(prev => [ { datetime: stamp, type: 'PRODUCE', skuOrName: woOutputName.trim(), qty: +woProducedQty, value: +woPlanTotal, ref: 'WO-NEW' }, ...prev ]);
    if (woRawSku && woRawQty > 0 && woPlan.length > 0) {
      setLayersBySku(prev => { const copy = { ...prev }; const list = (copy[woRawSku] || []).map(l => ({ ...l })); let need = woPlan.reduce((s, p) => s + p.qty, 0); for (const l of list) { if (need <= 0) break; const take = Math.min(need, l.remaining); l.remaining -= take; need -= take; } copy[woRawSku] = list; return copy; });
      setSkus(prev => prev.map(s => s.id === woRawSku ? { ...s, onHand: Math.max(0, (s.onHand ?? 0) - woPlan.reduce((sum, p) => sum + p.qty, 0)) } : s));
    }
    setWoOutputName(""); setWoProducedQty(0); setWoRawQty(0);
  }

  // Column widths (resizable) for Dashboard inventory table
  const [colWidths, setColWidths] = useState<Record<string, number>>({
    category: 220,
    sku: 120,
    description: 300,
    unit: 80,
    type: 100,
    onHand: 100,
    avgCost: 140,
    assetValue: 120,
    minimum: 100,
    status: 120,
  });
  const ResizableTH = ({ id, align = 'left', children }: { id: keyof typeof colWidths | string; align?: 'left'|'right'|'center'; children: React.ReactNode }) => {
    const width = colWidths[String(id)] ?? 120;
    const onMouseDown = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = colWidths[String(id)] ?? 120;
      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const next = Math.max(70, Math.min(480, startW + delta));
        setColWidths((w) => ({ ...w, [String(id)]: next }));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
    return (
      <TableHead style={{ width }} className={`${align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : ''} relative select-none`}>
        <div className="pr-2 truncate" style={{ width }} title={typeof children === 'string' ? children : undefined}>{children}</div>
        <div role="separator" aria-orientation="vertical" onMouseDown={onMouseDown}
             className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-slate-300 active:bg-slate-400" />
      </TableHead>
    );
  };

  return (
    <div className="min-h-screen w-full bg-white text-slate-900">
      {/* Topbar */}
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-xl bg-slate-900 text-white grid place-items-center"><Layers className="h-5 w-5" /></div>
            <div>
              <p className="text-sm text-slate-500 leading-none">Premier Gaskets</p>
              <h1 className="text-base font-semibold">Wireframes — Inventory (MVP) with FIFO</h1>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-2"><Badge variant="secondary" className="rounded-full">MVP</Badge></div>
        </div>
      </header>

      {/* Global quick bar (fixed above tabs) */}
      <div className="sticky top-[56px] z-20 bg-white/90 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2"><Building2 className="h-4 w-4 text-slate-500"/><span className="text-sm text-slate-600">Quick menu</span></div>
          <div className="flex gap-2">
            <Button size="sm" className="rounded-xl" onClick={() => setVendorsOpen(true)}>Open Vendors</Button>
            <Button size="sm" variant="outline" className="rounded-xl" onClick={() => setSkusOpen(true)}>Open SKUs</Button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <main className="max-w-6xl mx-auto px-4 py-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid grid-cols-4 w-full rounded-2xl">
            <TabsTrigger value="dashboard" className="gap-2"><BarChart3 className="h-4 w-4"/>Dashboard</TabsTrigger>
            <TabsTrigger value="receiving" className="gap-2"><Package className="h-4 w-4"/>Receiving</TabsTrigger>
            <TabsTrigger value="wo" className="gap-2"><ClipboardList className="h-4 w-4"/>Work Order</TabsTrigger>
            <TabsTrigger value="movements" className="gap-2"><History className="h-4 w-4"/>Movements</TabsTrigger>
          </TabsList>

          {/* --- Screen A: Dashboard --- */}
          <TabsContent value="dashboard" className="mt-6 space-y-4">
            <Card className="rounded-2xl border-dashed">
              <CardHeader className="py-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">Dashboard</CardTitle>
                  <div className="flex items-center gap-2">
                    <Select value={period} onValueChange={(v) => setPeriod(v as PeriodOption)}>
                      <SelectTrigger className="h-8 w-[200px] rounded-xl"><SelectValue placeholder="Period" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="today">Today</SelectItem>
                        <SelectItem value="last7">Last 7 days</SelectItem>
                        <SelectItem value="month">Current month</SelectItem>
                        <SelectItem value="quarter">Current quarter</SelectItem>
                        <SelectItem value="custom">Custom range</SelectItem>
                      </SelectContent>
                    </Select>
                    {period === 'custom' && (
                      <div className="flex items-center gap-2">
                        <Input type="date" value={customStart} onChange={(e)=> setCustomStart(e.target.value)} className="h-8" />
                        <span className="text-sm text-slate-500">to</span>
                        <Input type="date" value={customEnd} onChange={(e)=> setCustomEnd(e.target.value)} className="h-8" />
                      </div>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {(() => {
                  // 1) Total Inventory (qty & value) — snapshot
                  const inv = skus.reduce((acc, s) => { const qty = Math.max(0, s.onHand ?? 0); const avg = fifoAvgCost(layersBySku[s.id]) ?? 0; acc.qty += qty; acc.value += qty * avg; return acc; }, { qty: 0, value: 0 });

                  // Movements helpers
                  const deltas = movementLog.map(m => { const ts = +parseStamp(m.datetime); const v = Math.abs(m.value || 0); const delta = m.type === 'RECEIVE' ? +v : (m.type === 'ISSUE' || m.type === 'WASTE' ? -v : 0); return { ts, delta }; });
                  const nowInvValue = inv.value;
                  const invAt = (ts: number) => nowInvValue - deltas.reduce((s, d) => (d.ts > ts ? s + d.delta : s), 0);

                  // Inventory series (value) at end of each bin
                  const inventorySeries = bins.map(([_, e]) => invAt(e));

                  // COGS per bin & total
                  const cogsPerBin = bins.map(([s, e]) => movementLog
                    .filter(m => m.type === 'ISSUE')
                    .reduce((sum, m) => { const ts = +parseStamp(m.datetime); return ts > s && ts <= e ? sum + (m.value || 0) : sum; }, 0));
                  const cogsTotal = cogsPerBin.reduce((a, b) => a + b, 0);

                  // Inventory Turnover = COGS / Average Inventory (period)
                  const invStart = invAt(rangeStart);
                  const invEnd = invAt(rangeEnd);
                  const avgInvPeriod = Math.max(0, (invStart + invEnd) / 2);
                  const turnoverVal = avgInvPeriod > 0 ? (cogsTotal / avgInvPeriod) : 0;
                  const turnoverSeries = bins.map(([s, e], i) => { const invS = invAt(s), invE = invAt(e); const avgBin = Math.max(0, (invS + invE) / 2); return avgBin > 0 ? (cogsPerBin[i] / avgBin) : 0; });

                  // Days of Inventory = Current Inventory ÷ Daily COGS (period)
                  const daysInPeriod = Math.max(1, (rangeEnd - rangeStart) / ONE_DAY);
                  const dailyCOGS = cogsTotal / daysInPeriod;
                  const doiVal = dailyCOGS > 0 ? (nowInvValue / dailyCOGS) : Infinity;
                  let cum = 0; const doiSeriesRaw = bins.map(([s, e], i) => { cum += cogsPerBin[i]; const daysSoFar = Math.max((e - rangeStart) / ONE_DAY, 1e-6); const daily = cum / daysSoFar; const invEndBin = invAt(e); return daily > 0 ? (invEndBin / daily) : Infinity; });
                  const doiSeries = doiSeriesRaw.map(v => (Number.isFinite(v) ? v : 0));

                  return (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <MetricCard title="Total Inventory (qty / value)" primary={inv.qty.toLocaleString('en-US')} unitPrimary="units" secondary={fmtMoney(inv.value)} series={inventorySeries} valueFormatter={fmtMoney} />
                      <MetricCard title="Inventory Turnover" primary={(Number.isFinite(turnoverVal) ? turnoverVal.toFixed(2) : '—')} unitPrimary="x" secondary={`${fmtMoney(cogsTotal)} COGS in period`} series={turnoverSeries} valueFormatter={(v) => `${v.toFixed(2)}x`} />
                      <MetricCard title="Days of Inventory" primary={(Number.isFinite(doiVal) ? doiVal.toFixed(1) : '∞')} unitPrimary="days" secondary={`Daily COGS: ${fmtMoney(dailyCOGS)}`} series={doiSeries} valueFormatter={(v) => `${v.toFixed(1)} days`} />
                    </div>
                  );
                })()}
              </CardContent>
            </Card>

            <SectionCard title="Inventory by SKU" icon={<Layers className="h-5 w-5 text-slate-500"/>}>
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="text-xs text-slate-500">Traffic light: green = above minimum • red = below minimum</div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => exportInventory(false)}>Export all (Excel)</Button>
                  <Button size="sm" onClick={() => exportInventory(true)}>Export red flags (Excel)</Button>
                  <Select onValueChange={(v) => { if (v === 'ALL') return setSkus(skuMaster); setSkus(skuMaster.filter(s => s.type === (v as MaterialType))); }}>
                    <SelectTrigger className="h-8 w-[200px] rounded-xl"><SelectValue placeholder="Filter by type" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">All</SelectItem>
                      <SelectItem value="RAW">Raw</SelectItem>
                      <SelectItem value="SELLABLE">Sellable</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <ResizableTH id="category">Category</ResizableTH>
                    <ResizableTH id="sku">SKU</ResizableTH>
                    <ResizableTH id="description">Description</ResizableTH>
                    <ResizableTH id="unit">U/M</ResizableTH>
                    <ResizableTH id="type">Type</ResizableTH>
                    <ResizableTH id="onHand" align="right">On hand</ResizableTH>
                    <ResizableTH id="avgCost" align="right">Avg. cost (FIFO)</ResizableTH>
                    <ResizableTH id="assetValue" align="right">Asset value</ResizableTH>
                    <ResizableTH id="minimum" align="right">Minimum</ResizableTH>
                    <ResizableTH id="status">Status</ResizableTH>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {CATEGORY_OPTIONS.map((cat) => {
                    const items = grouped[cat];
                    if (!items || items.length === 0) return (
                      <TableRow key={cat} className="opacity-60">
                        <TableCell className="font-medium"><div className="flex items-center gap-2"><ChevronRightIcon/> {cat}</div></TableCell>
                        <TableCell colSpan={9} className="text-sm text-slate-500">No SKUs</TableCell>
                      </TableRow>
                    );
                    const open = expanded[cat];
                    return (
                      <React.Fragment key={cat}>
                        <TableRow className="bg-slate-50/50">
                          <TableCell className="font-medium">
                            <button type="button" className="inline-flex items-center gap-2" onClick={() => toggleCat(cat)}>
                              {open ? <ChevronUp className="h-4 w-4"/> : <ChevronDown className="h-4 w-4"/>}
                              {cat}
                              <Badge variant="secondary" className="ml-2 rounded-full">{items.length} SKU{items.length > 1 ? 's' : ''}</Badge>
                            </button>
                          </TableCell>
                          <TableCell colSpan={9}></TableCell>
                        </TableRow>
                        {open && items.map((s, i) => {
                          const qty = s.onHand ?? 0; const min = s.min ?? 0; const ok = qty >= min; const avg = avgCostFor(s.id);
                          return (
                            <TableRow key={`${cat}-${s.id}-${i}`}>
                              <TableCell style={{ width: colWidths.category }}></TableCell>
                              <TableCell className="font-medium" style={{ width: colWidths.sku }}>{s.id}</TableCell>
                              <TableCell style={{ width: colWidths.description }}>{s.description ?? '-'}</TableCell>
                              <TableCell style={{ width: colWidths.unit }}>{s.unit ?? '-'}</TableCell>
                              <TableCell style={{ width: colWidths.type }}>{s.type === 'RAW' ? 'Raw' : 'Sellable'}</TableCell>
                              <TableCell className="text-right" style={{ width: colWidths.onHand }}>{qty}</TableCell>
                              <TableCell className="text-right" style={{ width: colWidths.avgCost }}>{avg != null ? fmtMoney(avg) : '—'}</TableCell>
                              <TableCell className="text-right" style={{ width: colWidths.assetValue }}>{avg != null ? fmtMoney(qty * (avg || 0)) : '—'}</TableCell>
                              <TableCell className="text-right" style={{ width: colWidths.minimum }}>{min}</TableCell>
                              <TableCell style={{ width: colWidths.status }}><TrafficLight ok={ok} /></TableCell>
                            </TableRow>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </SectionCard>
          </TabsContent>

          {/* --- Screen B: Receiving --- */}
          <TabsContent value="receiving" className="mt-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 space-y-4">
                <SectionCard title="Receiving Form" icon={<Package className="h-5 w-5 text-slate-500"/>}>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <Label>Vendor</Label>
                      <VendorAutocomplete value={vendorValue} onChange={setVendorValue} suggestions={vendors} />
                    </div>
                    <div>
                      <Label>Date</Label>
                      <Input type="date"/>
                    </div>
                    <div>
                      <Label>SKU</Label>
                      <SKUSelect skus={skus} value={receivingSku} onChange={setReceivingSku} placeholder="Select SKU" />
                    </div>
                    <div>
                      <Label>Type</Label>
                      <Input value={(() => { const s = skus.find(x => x.id === receivingSku); return s ? (s.type === 'RAW' ? 'Raw' : 'Sellable') : ''; })()} placeholder="Auto from SKU" readOnly/>
                    </div>
                    <div>
                      <Label>Quantity</Label>
                      <Input type="number" value={receivingQty} onChange={(e) => setReceivingQty(Math.max(0, parseInt(e.target.value || '0', 10)))} placeholder="0"/>
                    </div>
                    <div>
                      <Label>Unit cost</Label>
                      <Input type="number" step="0.01" placeholder="0.00"/>
                    </div>
                    <div>
                      <Label>Packing slip (No.)</Label>
                      <Input placeholder="PS-2025-0001"/>
                    </div>
                    <div className="md:col-span-2 space-y-2">
                      <div className="flex items-center gap-2">
                        <Checkbox id="damaged" checked={isDamaged} onCheckedChange={(v) => { const c = Boolean(v); setIsDamaged(c); setDamageScope(c ? 'FULL' : 'NONE'); if (!c) setRejectedQty(0); }}/>
                        <Label htmlFor="damaged">Damaged?</Label>
                      </div>
                      {isDamaged && (
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                          <div>
                            <Label>Damage scope</Label>
                            <Select value={damageScope} onValueChange={(v) => setDamageScope(v as DamageScope)}>
                              <SelectTrigger><SelectValue placeholder="Select"/></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="FULL">Entire packing slip</SelectItem>
                                <SelectItem value="PARTIAL">Partial</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {damageScope === 'PARTIAL' && (<>
                            <div>
                              <Label>Rejected qty</Label>
                              <Input type="number" min={0} max={receivingQty} value={rejectedQty} onChange={(e) => { const n = parseInt(e.target.value || '0', 10); setRejectedQty(Math.max(0, Math.min(n, receivingQty))); }} />
                            </div>
                            <div>
                              <Label>Accepted qty</Label>
                              <Input value={Math.max(0, outcome.acceptQty)} readOnly />
                            </div>
                          </>)}
                        </div>
                      )}
                      {isDamaged && <p className="text-xs text-amber-700">{damageScope === 'FULL' ? 'The entire packing slip will be rejected (no inventory entry).' : 'Partial damage: the rejected quantity will not enter inventory.'}</p>}
                    </div>
                    <div className="md:col-span-2">
                      <Label>Notes</Label>
                      <Textarea placeholder="Inspection notes"/>
                    </div>
                    <div className="md:col-span-2 flex gap-2 items-center">
                      {isDamaged && damageScope === 'FULL' ? (
                        <Button className="rounded-xl" variant="destructive">Reject entire packing slip</Button>
                      ) : (
                        <Button className="rounded-xl" disabled={receivingQty <= 0 || (isDamaged && damageScope === 'PARTIAL' && Math.max(0, receivingQty - rejectedQty) <= 0)}>
                          {isDamaged && damageScope === 'PARTIAL' ? `Approve partial (${Math.max(0, receivingQty - rejectedQty)} in, ${rejectedQty} out)` : 'Approve & add to inventory'}
                        </Button>
                      )}
                      <Button variant="outline" className="rounded-xl">Return to vendor</Button>
                    </div>
                  </div>
                </SectionCard>

                <SectionCard title="Recent RAW layers (FIFO)" icon={<Layers className="h-5 w-5 text-slate-500"/>}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Layer ID</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Remaining qty</TableHead>
                        <TableHead>Unit cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(layersBySku['SKU-001'] || []).slice(0,3).map((l) => (
                        <TableRow key={l.id}>
                          <TableCell>{l.id}</TableCell>
                          <TableCell>{l.date}</TableCell>
                          <TableCell>{l.remaining}</TableCell>
                          <TableCell>$ {l.cost.toFixed(2)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </SectionCard>
              </div>

              <div className="space-y-4">
                <SectionCard title="Pending receipts" icon={<Package className="h-5 w-5 text-slate-500"/>}>
                  <div className="space-y-2">
                    <div className="p-3 rounded-xl border border-dashed">
                      <div className="flex items-center justify-between"><div className="text-sm">PS-2025-0007 — SKU-001</div><Badge>Draft</Badge></div>
                      <p className="text-xs text-slate-500">Vendor: ABC Metals • 120 units • $5.20</p>
                    </div>
                    <div className="p-3 rounded-xl border border-dashed">
                      <div className="flex items-center justify-between"><div className="text-sm">PS-2025-0008 — SKU-002</div><Badge variant="secondary">Pending</Badge></div>
                      <p className="text-xs text-slate-500">Vendor: GasketCo • 200 units • $5.40</p>
                    </div>
                  </div>
                </SectionCard>

                <SectionCard title="Acceptance rules (visual)" icon={<AlertTriangle className="h-5 w-5 text-amber-500"/>}>
                  <ul className="text-sm list-disc pl-5 space-y-1 text-slate-600">
                    <li><b>Quantity</b> and <b>unit cost</b> are required to approve.</li>
                    <li>Damaged items → <b>return</b> (do not enter inventory).</li>
                    <li>Dashboard updates after approval.</li>
                  </ul>
                </SectionCard>
              </div>
            </div>
          </TabsContent>

          {/* --- Screen C: Work Order --- */}
          <TabsContent value="wo" className="mt-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 space-y-4">
                <SectionCard title="Work Order — Finalization" icon={<ClipboardList className="h-5 w-5 text-slate-500"/>}>
                  <div className="flex items-center gap-3 mb-4"><Badge>WO-00425</Badge><Badge variant="secondary">OPEN</Badge></div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="md:col-span-2">
                      <Label className="text-xs text-slate-500">1) Raw material consumption (FIFO from oldest layers)</Label>
                      <div className="rounded-2xl border border-dashed p-3">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>SKU (Raw)</TableHead>
                              <TableHead>Quantity</TableHead>
                              <TableHead>Notes</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            <TableRow>
                              <TableCell><SKUSelect skus={skus} filter="RAW" value={woRawSku} onChange={setWoRawSku} placeholder="Select Raw SKU" /></TableCell>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  <Input className="flex-1" type="number" value={woRawQty} onChange={(e)=>setWoRawQty(Math.max(0, parseInt(e.target.value||'0',10)))} placeholder="0"/>
                                  <span className="text-xs text-slate-500 min-w-[36px] text-right">{skus.find(s=>s.id===woRawSku)?.unit ?? ''}</span>
                                </div>
                              </TableCell>
                              <TableCell><Input placeholder="e.g., Coil A"/></TableCell>
                            </TableRow>
                          </TableBody>
                        </Table>
                        <div className="pt-2 text-xs text-slate-500">Consumption plan (FIFO) below is auto-calculated.</div>
                      </div>
                    </div>

                    <div>
                      <Label className="text-xs text-slate-500">2) Waste</Label>
                      <div className="rounded-2xl border border-dashed p-3 space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <Input placeholder="Waste qty" type="number"/>
                          <Input placeholder="Reason (e.g., cutting)"/>
                        </div>
                        <p className="text-xs text-slate-500">Waste value is calculated via FIFO from the consumed layers.</p>
                      </div>
                    </div>

                    <div className="md:col-span-2">
                      <Label className="text-xs text-slate-500">3) Output (free text)</Label>
                      <div className="rounded-2xl border border-dashed p-3 grid grid-cols-1 md:grid-cols-3 gap-2">
                        <div className="md:col-span-2">
                          <Label>Finished product name (free text)</Label>
                          <Input value={woOutputName} onChange={(e)=>setWoOutputName(e.target.value)} placeholder="Type any name"/>
                        </div>
                        <div>
                          <Label>Produced quantity</Label>
                          <Input type="number" value={woProducedQty} onChange={(e)=>setWoProducedQty(Math.max(0, parseInt(e.target.value||'0',10)))} placeholder="0"/>
                        </div>
                      </div>
                    </div>

                    <div className="md:col-span-2 flex items-center gap-2">
                      <Button className="rounded-xl" onClick={finalizeWO}>Finalize WO</Button>
                      <Button variant="outline" className="rounded-xl">Save draft</Button>
                    </div>
                  </div>
                </SectionCard>

                <SectionCard title="FIFO breakdown (auto)" icon={<DollarSign className="h-5 w-5 text-slate-500"/>}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Layer</TableHead>
                        <TableHead>Qty</TableHead>
                        <TableHead>Unit cost</TableHead>
                        <TableHead>Value</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {woPlan.length === 0 ? (
                        <TableRow><TableCell colSpan={4} className="text-sm text-slate-500">No consumption planned.</TableCell></TableRow>
                      ) : (
                        woPlan.map(p => (
                          <TableRow key={p.layerId}>
                            <TableCell>{p.layerId}</TableCell>
                            <TableCell>{p.qty}</TableCell>
                            <TableCell>$ {p.cost.toFixed(2)}</TableCell>
                            <TableCell>$ {(p.qty * p.cost).toFixed(2)}</TableCell>
                          </TableRow>
                        ))
                      )}
                      <TableRow>
                        <TableCell className="font-medium">Total</TableCell>
                        <TableCell className="font-medium">{woPlan.reduce((s,p)=>s+p.qty,0)}</TableCell>
                        <TableCell></TableCell>
                        <TableCell className="font-medium">$ {woPlanTotal.toFixed(2)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </SectionCard>
              </div>

              <div className="space-y-4">
                <SectionCard title="RAW layers (balance)" icon={<Layers className="h-5 w-5 text-slate-500"/>}>
                  <ScrollArea className="h-56">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Layer</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead>Remaining</TableHead>
                          <TableHead>Cost</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(layersBySku[woRawSku] || []).map((l) => (
                          <TableRow key={l.id}>
                            <TableCell>{l.id}</TableCell>
                            <TableCell>{l.date}</TableCell>
                            <TableCell>{l.remaining}</TableCell>
                            <TableCell>$ {l.cost.toFixed(2)}</TableCell>
                          </TableRow>
                        ))}
                        {(!woRawSku || (layersBySku[woRawSku]||[]).length===0) && (
                          <TableRow><TableCell colSpan={4} className="text-sm text-slate-500">Select a Raw SKU to see its layers.</TableCell></TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                </SectionCard>

                <SectionCard title="Validation notes" icon={<AlertTriangle className="h-5 w-5 text-amber-500"/>}>
                  <ul className="text-sm list-disc pl-5 space-y-1 text-slate-600">
                    <li>No negative balance in Raw or Sellable.</li>
                    <li>Total consumption = production + waste (WO consistency).</li>
                    <li>Output name is free text and will appear in Movements once you finalize.</li>
                  </ul>
                </SectionCard>
              </div>
            </div>
          </TabsContent>

          {/* --- Screen D: Movements --- */}
          <TabsContent value="movements" className="mt-6">
            <div className="space-y-4">
              <Card className="rounded-2xl border-dashed">
                <CardHeader className="py-4"><CardTitle className="text-lg">Last Movements</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    <Input placeholder="Filter by SKU or Name"/>
                    <Input placeholder="Filter by WO"/>
                    <Select>
                      <SelectTrigger><SelectValue placeholder="Movement type"/></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="RECEIVE">RECEIVE</SelectItem>
                        <SelectItem value="ISSUE">ISSUE</SelectItem>
                        <SelectItem value="WASTE">WASTE</SelectItem>
                        <SelectItem value="PRODUCE">PRODUCE</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input type="date"/>
                  </div>

                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date/Time</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>SKU / Output name</TableHead>
                        <TableHead>Qty</TableHead>
                        <TableHead>Value</TableHead>
                        <TableHead>Ref</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {movementLog.length === 0 ? (
                        <TableRow><TableCell colSpan={6} className="text-sm text-slate-500">No movements yet.</TableCell></TableRow>
                      ) : (
                        movementLog.map((m, idx) => (
                          <TableRow key={idx}>
                            <TableCell>{m.datetime}</TableCell>
                            <TableCell><Badge variant="secondary">{m.type}</Badge></TableCell>
                            <TableCell>{m.skuOrName}</TableCell>
                            <TableCell>{m.qty > 0 ? `+${m.qty}` : m.qty}</TableCell>
                            <TableCell>$ {m.value.toFixed(2)}</TableCell>
                            <TableCell>{m.ref}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>

        {/* Global modals for Quick menu */}
        <Dialog open={vendorsOpen} onOpenChange={setVendorsOpen}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>Vendors</DialogTitle>
            </DialogHeader>
            <VendorsManager items={vendors} onChange={setVendors} />
          </DialogContent>
        </Dialog>
        <Dialog open={skusOpen} onOpenChange={setSkusOpen}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>SKUs</DialogTitle>
            </DialogHeader>
            <SKUManager items={skuMaster} onChange={(items)=>{ setSkuMaster(items); setSkus(items); }} />
          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
}

// --- SKU manager (master data) ---
function SKUManager({ items, onChange }: { items: SKU[]; onChange: (items: SKU[]) => void }) {
  const emptySKU: SKU = { id: "", type: 'RAW', productCategory: 'Adhesives', unit: '', description: '', min: 0 };
  const [openForm, setOpenForm] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [form, setForm] = useState<SKU>(emptySKU);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  function resetForm() { setForm(emptySKU); setEditingIndex(null); setOpenForm(false); }

  function saveSKU() {
    const id = form.id.trim();
    if (!id) return;
    const next = items.slice();
    if (editingIndex === null) next.push({ ...form, id });
    else next[editingIndex] = { ...form, id };
    onChange(next);
    resetForm();
  }
  function startEdit(i: number) { setForm({ ...items[i] }); setEditingIndex(i); setOpenForm(true); }

  function askDelete(i: number) { setConfirmDelete(i); }
  function cancelDelete() { setConfirmDelete(null); }
  function removeSKUConfirmed(i: number) {
    const next = items.slice(); next.splice(i, 1); onChange(next);
    if (editingIndex === i) resetForm();
    setConfirmDelete(null);
  }

  const labelType = (c: MaterialType) => (c === 'RAW' ? 'Raw' : 'Sellable');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-600">Centralized SKU master data</div>
        <Button size="sm" className="rounded-xl" onClick={() => setOpenForm(v => !v)}>{openForm ? 'Close' : 'Add SKU'}</Button>
      </div>
      {openForm && (
        <div className="rounded-2xl border border-dashed p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          {editingIndex !== null && <div className="md:col-span-3 text-xs text-slate-500">Editing SKU: <b>{items[editingIndex]?.id}</b></div>}
          <div className="md:col-span-1"><Label>SKU Code</Label><Input value={form.id} onChange={e => setForm({ ...form, id: e.target.value })} placeholder="e.g., SKU-003 or P-003"/></div>
          <div className="md:col-span-1"><Label>Type</Label>
            <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as MaterialType })}>
              <SelectTrigger><SelectValue placeholder="Select type"/></SelectTrigger>
              <SelectContent><SelectItem value="RAW">Raw</SelectItem><SelectItem value="SELLABLE">Sellable</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="md:col-span-1"><Label>Unit</Label><Input value={form.unit ?? ''} onChange={e => setForm({ ...form, unit: e.target.value })} placeholder="unit, kg, m, etc."/></div>
          <div className="md:col-span-3"><Label>Description</Label><Input value={form.description ?? ''} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Optional description"/></div>
          <div className="md:col-span-2"><Label>Category</Label>
            <Select value={form.productCategory} onValueChange={(v) => setForm({ ...form, productCategory: v as ProductCategory })}>
              <SelectTrigger><SelectValue placeholder="Select category"/></SelectTrigger>
              <SelectContent>{CATEGORY_OPTIONS.map((c) => (<SelectItem key={c} value={c}>{c}</SelectItem>))}</SelectContent>
            </Select>
          </div>
          <div className="md:col-span-1"><Label>Minimum stock</Label>
            <Input type="number" min={0} value={form.min ?? 0} onChange={(e)=> setForm({ ...form, min: Math.max(0, parseInt(e.target.value || '0', 10)) })} placeholder="0"/>
          </div>
          <div className="md:col-span-3 flex gap-2">
            <Button className="rounded-xl" onClick={saveSKU}>{editingIndex === null ? 'Save' : 'Update'}</Button>
            <Button variant="outline" className="rounded-xl" onClick={resetForm}>Cancel</Button>
          </div>
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Code</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Unit</TableHead>
            <TableHead className="text-right">Minimum</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((s, i) => (
            <TableRow key={`${s.id}-${i}`}>
              <TableCell className="font-medium">{s.id}</TableCell>
              <TableCell>{s.description ?? '-'}</TableCell>
              <TableCell>{labelType(s.type)}</TableCell>
              <TableCell>{s.productCategory}</TableCell>
              <TableCell>{s.unit ?? '-'}</TableCell>
              <TableCell className="text-right">{s.min ?? 0}</TableCell>
              <TableCell className="text-right">
                {confirmDelete === i ? (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="destructive" onClick={() => removeSKUConfirmed(i)}>Confirm</Button>
                    <Button size="sm" variant="outline" onClick={cancelDelete}>Cancel</Button>
                  </div>
                ) : (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => startEdit(i)}>Edit</Button>
                    <Button size="sm" variant="ghost" className="text-red-600" onClick={() => askDelete(i)}>Delete</Button>
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// --- Vendors manager (master data) ---
function VendorsManager({ items, onChange }: { items: Vendor[]; onChange: (items: Vendor[]) => void }) {
  const emptyVendor: Vendor = { name: '', email: '', phone: '', address: '', bank: '' };
  const [openForm, setOpenForm] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [form, setForm] = useState<Vendor>(emptyVendor);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  function resetForm() { setForm(emptyVendor); setEditingIndex(null); setOpenForm(false); }

  function saveVendor() {
    const name = (form.name || '').trim();
    if (!name) return;
    const next = items.slice();
    if (editingIndex === null) next.push({ ...form, name });
    else next[editingIndex] = { ...form, name };
    onChange(next);
    resetForm();
  }

  function startEdit(i: number) { setForm({ ...items[i] }); setEditingIndex(i); setOpenForm(true); }

  function askDelete(i: number) { setConfirmDelete(i); }
  function cancelDelete() { setConfirmDelete(null); }
  function removeVendorConfirmed(i: number) {
    const next = items.slice(); next.splice(i, 1); onChange(next);
    if (editingIndex === i) resetForm();
    setConfirmDelete(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-600">Centralized vendor master data</div>
        <Button size="sm" className="rounded-xl" onClick={() => setOpenForm(v => !v)}>{openForm ? 'Close' : 'Add Vendor'}</Button>
      </div>
      {openForm && (
        <div className="rounded-2xl border border-dashed p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          {editingIndex !== null && (
            <div className="md:col-span-2 text-xs text-slate-500">Editing vendor: <b>{items[editingIndex]?.name}</b></div>
          )}
          <div><Label>Name</Label><Input value={form.name ?? ''} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g., ABC Metals LLC" /></div>
          <div><Label>Email</Label><Input value={form.email ?? ''} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="ap@vendor.com" /></div>
          <div><Label>Phone</Label><Input value={form.phone ?? ''} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="+1 (555) 000-0000" /></div>
          <div className="md:col-span-2"><Label>Address</Label><Input value={form.address ?? ''} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="Street, City, State" /></div>
          <div className="md:col-span-2"><Label>Bank account</Label><Input value={form.bank ?? ''} onChange={e => setForm({ ...form, bank: e.target.value })} placeholder="Bank • ****-1234" /></div>
          <div className="md:col-span-2 flex gap-2">
            <Button className="rounded-xl" onClick={saveVendor}>{editingIndex === null ? 'Save' : 'Update'}</Button>
            <Button variant="outline" className="rounded-xl" onClick={resetForm}>Cancel</Button>
          </div>
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Address</TableHead>
            <TableHead>Bank</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((v, i) => (
            <TableRow key={`${v.name}-${i}`}>
              <TableCell className="font-medium">{v.name}</TableCell>
              <TableCell>{v.address ?? '-'}</TableCell>
              <TableCell>{v.bank ?? '-'}</TableCell>
              <TableCell>{v.email ?? '-'}</TableCell>
              <TableCell>{v.phone ?? '-'}</TableCell>
              <TableCell className="text-right">
                {confirmDelete === i ? (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="destructive" onClick={() => removeVendorConfirmed(i)}>Confirm</Button>
                    <Button size="sm" variant="outline" onClick={cancelDelete}>Cancel</Button>
                  </div>
                ) : (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => startEdit(i)}>Edit</Button>
                    <Button size="sm" variant="ghost" className="text-red-600" onClick={() => askDelete(i)}>Delete</Button>
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// tiny helper icon for empty cats
function ChevronRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
