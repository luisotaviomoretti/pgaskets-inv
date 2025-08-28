import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Layers } from '@/components/ui/icons';
// Zod schema for runtime validation
import { workOrderPayloadSchema } from '@/features/inventory/types/schemas';
import { processWorkOrder, getFIFOLayers } from '@/features/inventory/services/inventory.adapter';
import { useWorkOrderEvents } from '@/features/inventory/utils/workOrderEvents';

// Types for Work Order
type SKU = { id: string; description?: string; type: 'RAW' | 'SELLABLE'; productCategory: string; unit?: string; onHand?: number };
type Layer = { id: string; date: string; remaining: number; cost: number };
type WOPlan = { layerId: string; qty: number; cost: number };

// New types for multi-SKU functionality
type RawMaterialLine = {
  id: string;
  skuId: string;
  qty: number;
  notes: string;
};

type WasteLine = {
  skuId: string;
  wasteQty: number;
  maxWaste: number;
};


type MultiSKUPlan = {
  skuId: string;
  plan: WOPlan[];
  totalCost: number; // kept for compatibility (derived from cents)
  totalCostCents: number; // integer cents
  totalQty: number;
  canFulfill: boolean;
};

// Props interface
interface WorkOrderProps {
  skus: SKU[];
  layersBySku: Record<string, Layer[]>;
  onUpdateLayers?: (skuId: string, newLayers: Layer[]) => void;
  onUpdateSKU?: (skuId: string, updates: Partial<SKU>) => void;
  onAddMovement?: (movement: { datetime: string; type: 'RECEIVE' | 'ISSUE' | 'WASTE' | 'PRODUCE'; skuOrName: string; qty: number; value: number; ref: string }) => void;
  // Optional external Work Order ID for idempotency
  woId?: string;
  // Notify parent to refresh inventory summary and movements after finalize
  onRefreshInventory?: () => void;
}

// Inline error message (like Receiving)
function ErrorMessage({ message, id }: { message: string; id: string }) {
  return (
    <div id={id} className="flex items-center gap-1 text-sm text-red-600 mt-1">
      <AlertTriangle className="h-4 w-4" />
      <span>{message}</span>
    </div>
  );
}

// SKU select with filter
function SKUSelect({ skus, filter, value, onChange, placeholder, id, error }: { 
  skus: SKU[]; 
  filter?: 'RAW' | 'SELLABLE';
  value: string; 
  onChange: (v: string) => void; 
  placeholder?: string;
  id?: string;
  error?: string;
}) {
  const filteredSkus = filter ? skus.filter(s => s.type === filter) : skus;
  
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger 
        id={id}
        className={`h-10 w-full ${error ? 'border-red-500 focus:ring-red-500' : ''}`}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {filteredSkus.map(s => (
          <SelectItem key={s.id} value={s.id}>{s.id} — {s.description}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Icons
function ClipboardList({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
    </svg>
  );
}

function DollarSign({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
    </svg>
  );
}

// NAV-43: AlertTriangle icon for Validation notes
function AlertTriangle({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 18.5c-.77.833.192 2.5 1.732 2.5z" />
    </svg>
  );
}

function SectionCard({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="rounded-xl border border-dashed">
      <CardHeader className="py-4">
        <CardTitle className="flex items-center gap-2 text-lg">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export default function WorkOrder({ skus, layersBySku, onUpdateLayers, onUpdateSKU, onAddMovement, woId, onRefreshInventory }: WorkOrderProps) {
  
  // Event bus for real-time communication
  const { emitWorkOrderCompleted, emitMovementsRefreshRequested } = useWorkOrderEvents();
  
  // Helper function: Get available stock with fallback to SKU.onHand for instant validation
  const getAvailableStock = useCallback((skuId: string): number => {
    const layers = layersBySku[skuId];
    if (layers && layers.length > 0) {
      // Use precise FIFO layers if available
      return layers.reduce((sum, layer) => sum + (layer.remaining || 0), 0);
    }
    
    // Fallback to SKU.onHand for instant validation when layers not loaded
    const sku = skus.find(s => s.id === skuId);
    return sku?.onHand || 0;
  }, [layersBySku, skus]);

  // Multi-SKU state management
  const [rawMaterials, setRawMaterials] = useState<RawMaterialLine[]>([
    { id: '1', skuId: '', qty: 0, notes: '' }
  ]);
  const [wasteLines, setWasteLines] = useState<WasteLine[]>([]);
  const [woOutputName, setWoOutputName] = useState('');
  const [woProducedQty, setWoProducedQty] = useState<number>(0);
  const [woClient, setWoClient] = useState('');
  const [woInvoice, setWoInvoice] = useState('');
  const [layersModalSku, setLayersModalSku] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Stable default WO reference id (idempotent across retries in same session)
  const defaultWOIdRef = useRef<string>('');
  const getNowYMDHM = () => {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const HH = pad(d.getHours());
    const MM = pad(d.getMinutes());
    return `${yyyy}${mm}${dd}${HH}${MM}`;
  };
  if (!defaultWOIdRef.current) {
    const shortRand = Math.random().toString(36).slice(2, 6).toUpperCase();
    defaultWOIdRef.current = `WO-${getNowYMDHM()}-${shortRand}`;
  }

  // Strategy 1: Preload layers automatically when new SKUs are selected
  useEffect(() => {
    const activeSkuIds = rawMaterials
      .filter(r => r.skuId && !layersBySku[r.skuId]) // Only load if not already loaded
      .map(r => r.skuId);
    
    if (activeSkuIds.length === 0) return;
    
    // Preload layers for all newly selected SKUs
    const preloadLayers = async () => {
      const promises = activeSkuIds.map(async (skuId) => {
        try {
          console.log(`🔄 Preloading layers for SKU: ${skuId}`);
          const layers = await getFIFOLayers(skuId);
          const mapped = (layers || []).map((l: any) => {
            const d = l.date instanceof Date ? l.date : new Date(l.date);
            const dateStr = isNaN(d.getTime()) ? String(l.date) : d.toISOString().split('T')[0];
            return { id: l.id, date: dateStr, remaining: l.remaining, cost: l.cost };
          });
          
          // Update layers for this SKU
          if (onUpdateLayers) {
            onUpdateLayers(skuId, mapped);
          }
          console.log(`✅ Preloaded ${mapped.length} layers for SKU: ${skuId}`);
        } catch (error) {
          console.error(`❌ Failed to preload layers for SKU: ${skuId}`, error);
          // Don't throw - continue with fallback validation using SKU.onHand
        }
      });
      
      await Promise.all(promises);
    };
    
    // Debounce preloading to avoid too many concurrent requests
    const timeoutId = setTimeout(preloadLayers, 500);
    return () => clearTimeout(timeoutId);
  }, [rawMaterials.map(r => r.skuId).join(','), layersBySku, onUpdateLayers]);

  // Focus the first invalid field (UX/A11y)
  const focusFirstError = useCallback(() => {
    // Priority order: output name, produced qty, then each RAW line (sku then qty)
    const order: string[] = [];
    if (errors.outputName) order.push('outputName');
    if (errors.producedQty) order.push('producedQty');
    rawMaterials.forEach(r => {
      if (errors[`raw-sku-${r.id}`]) order.push(`raw-sku-${r.id}`);
      if (errors[`raw-qty-${r.id}`]) order.push(`raw-qty-${r.id}`);
    });
    for (const id of order) {
      const el = document.getElementById(id) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Small timeout to ensure scroll completes before focus
        setTimeout(() => el.focus && el.focus(), 150);
        break;
      }
    }
  }, [errors, rawMaterials]);

  // Add new raw material line
  const addRawMaterialLine = useCallback(() => {
    const newId = (Math.max(...rawMaterials.map(r => parseInt(r.id)), 0) + 1).toString();
    setRawMaterials(prev => [...prev, { id: newId, skuId: '', qty: 0, notes: '' }]);
  }, [rawMaterials]);

  // Remove raw material line
  const removeRawMaterialLine = useCallback((id: string) => {
    if (rawMaterials.length > 1) {
      setRawMaterials(prev => prev.filter(r => r.id !== id));
    }
  }, [rawMaterials.length]);

  // Update raw material line
  const updateRawMaterialLine = useCallback((id: string, updates: Partial<RawMaterialLine>) => {
    setRawMaterials(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r));
  }, []);

  // Sync waste lines with raw materials
  const syncWasteLines = useCallback(() => {
    // Aggregate RAW quantities per SKU to compute maxWaste per SKU
    const totalsBySku = new Map<string, number>();
    rawMaterials
      .filter(r => r.skuId && r.qty > 0)
      .forEach(r => {
        const curr = totalsBySku.get(r.skuId) || 0;
        totalsBySku.set(r.skuId, curr + r.qty);
      });

    setWasteLines(prev => {
      const newWasteLines: WasteLine[] = [];
      for (const [skuId, maxWaste] of totalsBySku.entries()) {
        const existing = prev.find(w => w.skuId === skuId);
        newWasteLines.push({
          skuId,
          wasteQty: existing ? Math.min(existing.wasteQty, maxWaste) : 0,
          maxWaste
        });
      }
      return newWasteLines;
    });
  }, [rawMaterials]);

  // Auto-sync waste when raw materials change
  useEffect(() => {
    syncWasteLines();
  }, [syncWasteLines]);

  // Update waste quantity
  const updateWasteQty = useCallback((skuId: string, wasteQty: number) => {
    setWasteLines(prev => prev.map(w => 
      w.skuId === skuId ? { ...w, wasteQty: Math.max(0, Math.min(wasteQty, w.maxWaste)) } : w
    ));
  }, []);

  // Calculate totals for summary
  const totalRawQty = useMemo(() => 
    rawMaterials.reduce((sum, r) => sum + (r.qty || 0), 0), 
    [rawMaterials]
  );
  
  const totalWasteQty = useMemo(() => 
    wasteLines.reduce((sum, w) => sum + (w.wasteQty || 0), 0), 
    [wasteLines]
  );
  


  // Mixed units exception case - relaxes consumption=production+waste validation
  const hasMixedUnits = useMemo(() => {
    const rawUnits = rawMaterials
      .filter(r => r.skuId && r.qty > 0)
      .map(r => skus.find(s => s.id === r.skuId)?.unit)
      .filter(Boolean);
    
    return rawUnits.length > 1 && !rawUnits.every(unit => unit === rawUnits[0]);
  }, [rawMaterials, skus]);

  // Calculate output unit from first raw material unit (matches backend logic)
  const outputUnit = useMemo(() => {
    const rawUnits = rawMaterials
      .filter(r => r.skuId && r.qty > 0)
      .map(r => skus.find(s => s.id === r.skuId)?.unit)
      .filter(Boolean);
    
    return rawUnits[0] || '';
  }, [rawMaterials, skus]);



  // Close modal on ESC
  useEffect(() => {
    if (!layersModalSku) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLayersModalSku(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layersModalSku]);

  // When opening the Layers modal, fetch the latest FIFO layers for that SKU from backend
  // so the modal reflects real-time data instead of any stale/mock state.
  useEffect(() => {
    if (!layersModalSku) return;
    (async () => {
      try {
        const latest = await getFIFOLayers(layersModalSku);
        const mapped: Layer[] = latest.map((l: any) => {
          const d = l.date instanceof Date ? l.date : new Date(l.date);
          const dateStr = isNaN(d.getTime()) ? String(l.date) : d.toISOString().split('T')[0];
          return { id: l.id, date: dateStr, remaining: l.remaining, cost: l.cost };
        });
        onUpdateLayers && onUpdateLayers(layersModalSku, mapped);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('Failed to load layers for modal', layersModalSku, e);
      }
    })();
  }, [layersModalSku, onUpdateLayers]);

  // Close confirm on ESC
  useEffect(() => {
    if (!confirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmOpen]);

  // Inline validation similar to Receiving
  useEffect(() => {
    const newErrors: Record<string, string> = {};
    // Per-line RAW validations
    rawMaterials.forEach((r) => {
      const skuId = `raw-sku-${r.id}`;
      const qtyId = `raw-qty-${r.id}`;
      if ((r.qty || 0) > 0 && !r.skuId) newErrors[skuId] = 'SKU is required for this line';
      if (r.skuId && (r.qty || 0) <= 0) newErrors[qtyId] = 'Quantity must be greater than 0';
      // Insufficient stock per line (with hybrid fallback for instant validation)
      if (r.skuId && (r.qty || 0) > 0) {
        const available = getAvailableStock(r.skuId);
        if ((r.qty || 0) > available) {
          newErrors[qtyId] = 'Insufficient stock for this SKU. Receive more in Receiving.';
        }
      }
    });

    // Aggregate per-SKU validation: sum of multiple RAW lines per SKU cannot exceed available
    const totalBySku = new Map<string, number>();
    rawMaterials
      .filter(r => r.skuId && (r.qty || 0) > 0)
      .forEach(r => totalBySku.set(r.skuId, (totalBySku.get(r.skuId) || 0) + (r.qty || 0)));
    for (const [skuIdKey, total] of totalBySku.entries()) {
      const available = getAvailableStock(skuIdKey);
      if (total > available + 1e-9) {
        // Mark each line of this SKU with an aggregate error
        rawMaterials.forEach(r => {
          if (r.skuId === skuIdKey) {
            newErrors[`raw-qty-${r.id}`] = 'Insufficient stock across lines for this SKU.';
          }
        });
      }
    }

    // Finished product name required
    if (!woOutputName.trim()) newErrors['outputName'] = 'Finished product name is required';
    // Produced qty required (except for mixed units exception)
    if (!hasMixedUnits && woProducedQty <= 0) newErrors['producedQty'] = 'Produced quantity must be greater than 0';

    setErrors(newErrors);
  }, [rawMaterials, woOutputName, woProducedQty, layersBySku, hasMixedUnits, getAvailableStock]);

  // Multi-SKU FIFO plans
  const multiSkuPlans = useMemo((): MultiSKUPlan[] => {
    return rawMaterials
      .filter(r => r.skuId && r.qty > 0)
      .map(r => {
        const layers = layersBySku[r.skuId] || [];
        const plan: WOPlan[] = [];
        let remaining = r.qty;
        
        for (const layer of layers.slice().sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())) {
          if (remaining <= 0) break;
          const consume = Math.min(remaining, layer.remaining);
          plan.push({ layerId: layer.id, qty: consume, cost: layer.cost });
          remaining -= consume;
        }
        
        const totalCostCents = plan.reduce((sum, p) => sum + Math.round(p.cost * 100) * p.qty, 0);
        const totalCost = totalCostCents / 100;
        const totalQty = plan.reduce((sum, p) => sum + p.qty, 0);
        
        // Use hybrid approach for canFulfill check
        const availableStock = getAvailableStock(r.skuId);
        const canFulfill = totalQty >= r.qty || availableStock >= r.qty;
        
        return {
          skuId: r.skuId,
          plan,
          totalCost,
          totalCostCents,
          totalQty,
          canFulfill
        };
      });
  }, [rawMaterials, layersBySku]);

  const totalWOCostCents = multiSkuPlans.reduce((sum, p) => sum + p.totalCostCents, 0);
  const totalWOCost = totalWOCostCents / 100;

  // Summary rows for confirmation modal (considering Waste)
  const summaryRows = useMemo(() => {
    const wasteBySku = new Map<string, number>();
    wasteLines.forEach(w => wasteBySku.set(w.skuId, (wasteBySku.get(w.skuId) || 0) + (w.wasteQty || 0)));
    return multiSkuPlans.map(p => {
      const rawQty = p.totalQty;
      const unitCost = rawQty > 0 ? (p.totalCostCents / rawQty) / 100 : 0;
      const wasteQty = Math.min(wasteBySku.get(p.skuId) || 0, rawQty);
      const netQty = Math.max(0, rawQty - wasteQty); // Production quantity = RAW - Waste
      // Value is just the FIFO cost of RAW consumed (matches FIFO breakdown)
      return {
        skuId: p.skuId,
        qty: netQty,
        unitCost,
        value: p.totalCostCents / 100, // Only RAW FIFO cost, waste is implicit in the consumption
      };
    });
  }, [multiSkuPlans, wasteLines]);
  const totalQtyAll = useMemo(() => summaryRows.reduce((s, r) => s + r.qty, 0), [summaryRows]);
  const totalValueAll = useMemo(() => summaryRows.reduce((s, r) => s + r.value, 0), [summaryRows]);

  // NAV-80: Validation function to determine if WO can be finalized (multi-SKU)
  const canFinalizeWO = useMemo(() => {
    if (!woOutputName.trim()) return false;
    if (!hasMixedUnits && woProducedQty <= 0) return false;

    const activeRaw = rawMaterials.filter(r => r.skuId && r.qty > 0);
    if (activeRaw.length === 0) return false;

    // Note: Removed restrictive balance validation - industrial processes
    // often don't have 1:1 raw material to finished product ratios

    // Sufficient inventory per SKU
    for (const p of multiSkuPlans) {
      if (!p.canFulfill) return false;
    }
    return true;
  }, [woOutputName, woProducedQty, rawMaterials, totalRawQty, totalWasteQty, multiSkuPlans, hasMixedUnits]);

  const finalizeWO = async () => {
    // Basic validations mirroring canFinalizeWO
    if (!woOutputName.trim()) {
      alert('Finished product name is required to finalize Work Order');
      return;
    }
    if (!hasMixedUnits && woProducedQty <= 0) {
      alert('Produced quantity must be greater than 0');
      return;
    }

    const activeRaw = rawMaterials.filter(r => r.skuId && r.qty > 0);
    if (activeRaw.length === 0) {
      alert('Add at least one RAW material line with quantity > 0');
      return;
    }

    const producedQty = woProducedQty;
    // Note: Removed restrictive balance validation - allows realistic industrial ratios

    // Ensure sufficient inventory per SKU
    for (const p of multiSkuPlans) {
      if (!p.canFulfill) {
        const required = activeRaw.filter(r => r.skuId === p.skuId).reduce((s, r) => s + r.qty, 0);
        const available = getAvailableStock(p.skuId);
        alert(`Insufficient inventory for SKU ${p.skuId}. Required: ${required}, Available: ${available}`);
        return;
      }
    }

    // Reference
    const woRef = (woId && woId.trim()) ? woId.trim() : defaultWOIdRef.current;

    // Zod validation: build WorkOrderPayload and validate (keeping for UX consistency)
    try {
      const activeRaw = rawMaterials.filter(r => r.skuId && r.qty > 0);
      const raw = activeRaw.map(r => ({
        sku: r.skuId,
        unit: skus.find(s => s.id === r.skuId)?.unit || '',
        qty: r.qty,
      }));
      const waste = wasteLines.map(w => ({
        sku: w.skuId,
        unit: skus.find(s => s.id === w.skuId)?.unit || '',
        qty: w.wasteQty,
      }));
      const unitCandidates = raw.map(r => r.unit).filter(u => !!u);
      const outputUnit = unitCandidates[0] || '';
      const payload = {
        code: woRef,
        datetime: new Date().toISOString(),
        outputName: woOutputName.trim(),
        outputUnit,
        mode: 'MANUAL',
        outputQty: producedQty,
        raw,
        waste,
      };
      workOrderPayloadSchema.parse(payload);
    } catch (err: any) {
      const message = err?.errors?.[0]?.message || 'Invalid Work Order data. Please review the form.';
      alert(message);
      return;
    }
    try {
      // Backend persistence via adapter
      const result = await processWorkOrder({
        outputName: woOutputName.trim(),
        outputQuantity: producedQty,
        rawMaterials: rawMaterials.filter(r => r.skuId && r.qty > 0).map(r => ({ skuId: r.skuId, quantity: r.qty })),
        wasteLines: wasteLines.filter(w => w.wasteQty > 0).map(w => ({ skuId: w.skuId, quantity: w.wasteQty })),
        date: new Date(),
        reference: woRef,
        notes: JSON.stringify({ client: woClient, invoice: woInvoice })
      });

      // 🧪 Detailed logging for verification
      console.log('🏭 Work Order Result Details:', {
        workOrderId: result.workOrderId,
        outputQuantity: producedQty,
        outputName: woOutputName.trim(),
        financials: {
          totalRawCost: result.totalRawCost,
          totalWasteCost: result.totalWasteCost,
          netProduceCost: result.netProduceCost || (result.totalRawCost - result.totalWasteCost),
          outputUnitCost: result.outputUnitCost
        },
        hasMixedUnits,
        rawMaterials: rawMaterials.filter(r => r.skuId && r.qty > 0),
        wasteLines: wasteLines.filter(w => w.wasteQty > 0),
        result
      });

      // Enhanced success message with cost breakdown
      const netCost = result.netProduceCost || (result.totalRawCost - result.totalWasteCost);
      const costBreakdown = `
📊 Cost Breakdown:
• RAW Materials: $${result.totalRawCost?.toFixed(2) || '0.00'}
• WASTE: $${result.totalWasteCost?.toFixed(2) || '0.00'}
• NET PRODUCE: $${netCost?.toFixed(2) || '0.00'}
• Unit Cost: $${result.outputUnitCost?.toFixed(2) || '0.00'}/${producedQty} units`;

      alert(`✅ Work Order ${result.workOrderId} finalized successfully!
${producedQty} units of "${woOutputName.trim()}" produced.

${costBreakdown}`);

      // 🚀 REAL-TIME EVENT: Emit work order completion for instant UI updates
      emitWorkOrderCompleted({
        workOrderId: result.workOrderId,
        outputName: woOutputName.trim(),
        outputQuantity: producedQty,
        totalRawCost: result.totalRawCost || 0
      });

      // 🔄 REQUEST IMMEDIATE REFRESH: Trigger movements refresh without delay
      emitMovementsRefreshRequested('WorkOrder.finalizeWO');

      // Refresh UI data after persistence
      // 1) Reload layers for each affected RAW SKU directly from backend (fifo_layers)
      const affectedSkus = Array.from(new Set(rawMaterials.filter(r => r.skuId && r.qty > 0).map(r => r.skuId)));
      for (const skuId of affectedSkus) {
        try {
          const latest = await getFIFOLayers(skuId);
          // Map LayerLite -> Layer with normalized string date
          const mapped: Layer[] = latest.map((l: any) => {
            const d = l.date instanceof Date ? l.date : new Date(l.date);
            const dateStr = isNaN(d.getTime()) ? String(l.date) : d.toISOString().split('T')[0];
            return { id: l.id, date: dateStr, remaining: l.remaining, cost: l.cost };
          });
          onUpdateLayers && onUpdateLayers(skuId, mapped);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('Failed to refresh layers for', skuId, e);
        }
      }

      // 2) Ask parent to refresh inventory summary and movement list
      onRefreshInventory && onRefreshInventory();

      // Reset form
      setRawMaterials([{ id: '1', skuId: '', qty: 0, notes: '' }]);
      setWasteLines([]);
      setWoOutputName('');
      setWoProducedQty(0);
      setWoClient('');
      setWoInvoice('');
    } catch (err: any) {
      const msg = err?.message || 'Failed to finalize Work Order. Please try again.';
      alert(msg);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="space-y-4">
        <SectionCard title="Work Order — Finalization" icon={<ClipboardList className="h-5 w-5 text-slate-500"/>}>
          <div className="flex items-center gap-3 mb-4">
            <Badge>WO-00425</Badge>
            <Badge variant="secondary">OPEN</Badge>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="md:col-span-2">
              <Label className="text-xs text-slate-500 mb-1.5">1) Raw material consumption (FIFO from oldest layers)</Label>
              <div className="rounded-2xl border border-dashed p-3">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU (Raw)</TableHead>
                      <TableHead>Quantity</TableHead>
                      <TableHead>Notes</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rawMaterials.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="min-w-[220px]">
                          <SKUSelect
                            skus={skus}
                            value={r.skuId}
                            onChange={(v) => updateRawMaterialLine(r.id, { skuId: v })}
                            placeholder="Select SKU"
                            id={`raw-sku-${r.id}`}
                            error={errors[`raw-sku-${r.id}`]}
                          />
                          {errors[`raw-sku-${r.id}`] && (
                            <ErrorMessage id={`raw-sku-${r.id}-error`} message={errors[`raw-sku-${r.id}`]} />
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Input
                              id={`raw-qty-${r.id}`}
                              type="number"
                              min="0"
                              step="any"
                              value={r.qty || ''}
                              onChange={(e) => updateRawMaterialLine(r.id, { qty: Math.max(0, parseFloat(e.target.value || '0')) })}
                              placeholder="0"
                              aria-invalid={!!errors[`raw-qty-${r.id}`]}
                              aria-describedby={errors[`raw-qty-${r.id}`] ? `raw-qty-${r.id}-error` : undefined}
                              className={`flex-1 h-10 ${errors[`raw-qty-${r.id}`] ? 'border-red-500 focus:ring-red-500' : ''}`}
                            />
                            <span className="text-xs text-slate-500 min-w-[36px] text-right">
                              {skus.find(s => s.id === r.skuId)?.unit ?? ''}
                            </span>
                          </div>
                          {errors[`raw-qty-${r.id}`] && (
                            <ErrorMessage id={`raw-qty-${r.id}-error`} message={errors[`raw-qty-${r.id}`]} />
                          )}
                        </TableCell>
                        <TableCell>
                          <Input
                            value={r.notes}
                            onChange={(e) => updateRawMaterialLine(r.id, { notes: e.target.value })}
                            placeholder="e.g., Coil A"
                            className="h-10"
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center gap-3 justify-end">
                            <Button
                              variant="outline"
                              className="text-green-600 px-0 border-0 hover:bg-transparent"
                              onClick={() => r.skuId && setLayersModalSku(r.skuId)}
                              disabled={!r.skuId}
                            >
                              <span className="inline-flex items-center gap-1">
                                <Layers className="h-4 w-4 text-green-600" />
                                See Raw Layers (balance)
                              </span>
                            </Button>
                            <Button variant="outline" onClick={() => removeRawMaterialLine(r.id)} disabled={rawMaterials.length <= 1}>Remove</Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="flex items-center justify-between pt-2 text-xs text-slate-500">
                  <div>Consumption plan (FIFO) below is auto-calculated.</div>
                  <Button size="sm" variant="outline" onClick={addRawMaterialLine}>Add line</Button>
                </div>
              </div>
            </div>

            <div>
              <Label className="text-xs text-slate-500 mb-1.5">2) Waste</Label>
              <div className="rounded-2xl border border-dashed p-3 space-y-2">
                {wasteLines.length === 0 ? (
                  <p className="text-xs text-slate-500">Waste lines will appear for each RAW SKU with qty &gt; 0.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        <TableHead>Waste qty</TableHead>
                        <TableHead>Max</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {wasteLines.map(w => (
                        <TableRow key={w.skuId}>
                          <TableCell>{w.skuId}</TableCell>
                          <TableCell className="min-w-[200px]">
                            <div className="flex items-center gap-2">
                              <Input
                                id={`waste-qty-${w.skuId}`}
                                type="number"
                                min="0"
                                step="any"
                                max={w.maxWaste}
                                value={w.wasteQty || ''}
                                onChange={(e) => updateWasteQty(w.skuId, Math.max(0, parseFloat(e.target.value || '0')))}
                                placeholder="0"
                                className="flex-1 h-10"
                              />
                              <span className="text-xs text-slate-500 min-w-[36px] text-right">
                                {skus.find(s => s.id === w.skuId)?.unit ?? ''}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs text-slate-500">{w.maxWaste}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <p className="text-xs text-slate-500">Waste value is calculated via FIFO from the consumed layers per SKU.</p>
              </div>
            </div>

            <div className="md:col-span-2">
              <Label className="text-xs text-slate-500 mb-1.5">3) Output</Label>
              <div className="rounded-2xl border border-dashed p-4 grid grid-cols-1 md:grid-cols-12 gap-4">
                {/* Row 1 */}
                <div className="md:col-span-12 lg:col-span-6">
                  <Label className="mb-1.5 block">Finished product name *</Label>
                  <Input
                    id="outputName"
                    value={woOutputName}
                    onChange={(e) => setWoOutputName(e.target.value)}
                    placeholder="e.g., Gasket Kit 50mm"
                    className={`h-10 w-full ${errors.outputName ? 'border-red-500 focus:ring-red-500' : ''}`}
                    aria-invalid={!!errors.outputName}
                    aria-describedby={errors.outputName ? 'outputName-error' : undefined}
                  />
                  {errors['outputName'] && (
                    <ErrorMessage id="outputName-error" message={errors['outputName']} />
                  )}
                </div>
                <div className="md:col-span-6 lg:col-span-3">
                  <Label className="mb-1.5 block">Produced quantity{!hasMixedUnits ? ' *' : ''}</Label>
                  <div className="flex items-center gap-2">
                    <Input 
                      id="producedQty"
                      type="number"
                      min="0"
                      step="any"
                      value={woProducedQty || ''}
                      onChange={(e) => setWoProducedQty(Math.max(0, parseFloat(e.target.value || '0')))} 
                      placeholder="0"
                      aria-invalid={!!errors.producedQty}
                      aria-describedby={errors.producedQty ? 'producedQty-error' : undefined}
                      className={`flex-1 h-10 ${errors.producedQty ? 'border-red-500 focus:ring-red-500' : ''}`}
                    />
                    <span className="text-xs text-slate-500 min-w-[36px] text-right">
                      {outputUnit}
                    </span>
                  </div>
                  {!hasMixedUnits && errors.producedQty && <ErrorMessage id="producedQty-error" message={errors.producedQty} />}
                </div>
                {/* Row 2 */}
                <div className="md:col-span-12 lg:col-span-6">
                  <Label className="mb-1.5 block">Client (free text)</Label>
                  <Input 
                    id="woClient"
                    value={woClient}
                    onChange={(e) => setWoClient(e.target.value)}
                    placeholder="e.g., ACME Corp"
                    className="h-10 w-full"
                  />
                </div>
                <div className="md:col-span-12 lg:col-span-6">
                  <Label className="mb-1.5 block">Invoice number (free text)</Label>
                  <Input 
                    id="woInvoice"
                    value={woInvoice}
                    onChange={(e) => setWoInvoice(e.target.value)}
                    placeholder="e.g., INV-2025-0001"
                    className="h-10 w-full"
                  />
                </div>
              </div>
            </div>

            <div className="md:col-span-2 flex items-center gap-2">
              {/* NAV-80: Disable button based on same conditions as finalizeWO() */}
              <Button 
                className="rounded-xl" 
                onClick={() => setConfirmOpen(true)}
                disabled={!canFinalizeWO}
              >
                Finalize WO
              </Button>
              {!canFinalizeWO && (
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-xl"
                  onClick={() => {
                    // Debug function to show what's preventing finalization
                    const issues = [];
                    if (!woOutputName.trim()) issues.push("❌ Finished product name is required");
                    if (!hasMixedUnits && woProducedQty <= 0) issues.push("❌ Produced quantity must be > 0");
                    
                    const activeRaw = rawMaterials.filter(r => r.skuId && r.qty > 0);
                    if (activeRaw.length === 0) issues.push("❌ Add at least one RAW material line with quantity > 0");
                    
                    // Note: Removed restrictive balance validation - allows realistic industrial ratios
                    
                    for (const p of multiSkuPlans) {
                      if (!p.canFulfill) {
                        const required = rawMaterials.filter(r => r.skuId === p.skuId).reduce((s, r) => s + r.qty, 0);
                        const available = getAvailableStock(p.skuId);
                        issues.push(`❌ Insufficient stock for ${p.skuId}: need ${required}, available ${available}`);
                      }
                    }
                    
                    alert("Cannot finalize Work Order:\n\n" + issues.join("\n"));
                  }}
                >
                  Debug issues
                </Button>
              )}
            </div>
          </div>
        </SectionCard>

        <SectionCard title="FIFO breakdown (auto)" icon={<DollarSign className="h-5 w-5 text-slate-500"/>}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Layer</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Unit cost</TableHead>
                <TableHead>Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {multiSkuPlans.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-sm text-slate-500">No consumption planned.</TableCell>
                </TableRow>
              ) : (
                multiSkuPlans.map(p => (
                  <React.Fragment key={p.skuId}>
                    <TableRow>
                      <TableCell colSpan={5} className="text-sm text-slate-500">{p.skuId}</TableCell>
                    </TableRow>
                    {p.plan.map((plan) => (
                      <TableRow key={plan.layerId}>
                        <TableCell></TableCell>
                        <TableCell>{plan.layerId}</TableCell>
                        <TableCell>{plan.qty}</TableCell>
                        <TableCell>$ {plan.cost.toFixed(2)}</TableCell>
                        <TableCell>$ {(plan.qty * plan.cost).toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell className="font-medium" colSpan={2}>Total</TableCell>
                      <TableCell className="font-medium">{p.totalQty}</TableCell>
                      <TableCell></TableCell>
                      <TableCell className="font-medium">$ {p.totalCost.toFixed(2)}</TableCell>
                    </TableRow>
                  </React.Fragment>
                ))
              )}
              <TableRow>
                <TableCell className="font-medium" colSpan={4}>Grand Total</TableCell>
                <TableCell className="font-medium">$ {totalWOCost.toFixed(2)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </SectionCard>

        <SectionCard title="Validation notes" icon={<AlertTriangle className="h-5 w-5 text-amber-500"/>}>
          <ul className="text-sm list-disc pl-5 space-y-1 text-slate-600">
            <li>No negative balance in Raw or Sellable.</li>
            <li>Output name is free text and will appear in Movements once you finalize.</li>
            <li><b>Sufficient stock:</b> Raw material must have enough inventory to consume.</li>
            <li><b>Produced &gt; 0:</b> Production quantity must be greater than zero.</li>
            <li><b>Output name required:</b> Output name cannot be empty to finalize WO.</li>
            <li><b>Realistic ratios:</b> Raw material consumption can exceed production (normal in manufacturing).</li>
          </ul>
        </SectionCard>
      </div>
      {/* Layers modal */}
      {layersModalSku && (
        <div className="fixed inset-0 z-50" onClick={() => setLayersModalSku(null)}>
          <div className="absolute inset-0 bg-black/40"></div>
          <div className="absolute inset-0 flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl">
              <div className="flex items-center justify-between px-4 py-3 border-b">
                <div className="flex items-center gap-2">
                  <Layers className="h-5 w-5 text-green-600" />
                  <span className="font-medium">Raw Layers (balance) — {layersModalSku}</span>
                </div>
                <Button variant="outline" onClick={() => setLayersModalSku(null)}>✕</Button>
              </div>
              <div className="p-4 space-y-3">
                <p className="text-xs text-slate-600">Note: quantities will be consumed from the oldest inventory layers first (FIFO).</p>
                <div className="border rounded-lg">
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
                      {(layersBySku[layersModalSku] || []).slice().sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()).map((l) => (
                        <TableRow key={l.id}>
                          <TableCell>{l.id}</TableCell>
                          <TableCell>{l.date}</TableCell>
                          <TableCell>{l.remaining}</TableCell>
                          <TableCell>$ {l.cost.toFixed(2)}</TableCell>
                        </TableRow>
                      ))}
                      {((layersBySku[layersModalSku] || []).length === 0) && (
                        <TableRow>
                          <TableCell colSpan={4} className="text-sm text-slate-500">No layers for this SKU.</TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Finalize modal */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50" onClick={() => setConfirmOpen(false)}>
          <div className="absolute inset-0 bg-black/40"></div>
          <div className="absolute inset-0 flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl">
              <div className="flex items-center justify-between px-4 py-3 border-b">
                <div className="flex items-center gap-2">
                  <ClipboardList className="h-5 w-5 text-slate-500" />
                  <span className="font-medium">Confirm Work Order</span>
                </div>
                <Button variant="outline" onClick={() => setConfirmOpen(false)}>✕</Button>
              </div>
              <div className="p-4 space-y-3">
                <p className="text-sm text-slate-600">Please review the consumption summary (FIFO) before finalizing.</p>
                <div className="border rounded-lg">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        <TableHead className="text-right">Quantity</TableHead>
                        <TableHead className="text-right">Unit cost</TableHead>
                        <TableHead className="text-right">Value</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summaryRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={4} className="text-sm text-slate-500">No items to finalize.</TableCell>
                        </TableRow>
                      ) : (
                        summaryRows.map(r => (
                          <TableRow key={r.skuId}>
                            <TableCell>{r.skuId}</TableCell>
                            <TableCell className="text-right">{r.qty}</TableCell>
                            <TableCell className="text-right">$ {r.unitCost.toFixed(2)}</TableCell>
                            <TableCell className="text-right">$ {r.value.toFixed(2)}</TableCell>
                          </TableRow>
                        ))
                      )}
                      <TableRow>
                        <TableCell className="font-medium">Totals</TableCell>
                        <TableCell className="font-medium text-right">{totalQtyAll}</TableCell>
                        <TableCell></TableCell>
                        <TableCell className="font-medium text-right">$ {totalValueAll.toFixed(2)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm text-slate-700">
                  <div><span className="text-slate-500">Output name:</span> <b>{woOutputName || '-'}</b></div>
                  <div><span className="text-slate-500">Produced qty:</span> <b>{woProducedQty}</b></div>
                  {woClient && (<div><span className="text-slate-500">Client:</span> <b>{woClient}</b></div>)}
                  {woInvoice && (<div><span className="text-slate-500">Invoice:</span> <b>{woInvoice}</b></div>)}
                </div>
                <div className="flex items-center justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
                  <Button onClick={() => { setConfirmOpen(false); finalizeWO(); }}>Confirm & Finalize</Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
