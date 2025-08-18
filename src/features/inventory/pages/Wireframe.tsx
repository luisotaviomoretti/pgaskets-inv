import React, { lazy, Suspense } from 'react';
import { useState, useMemo, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { useAuth } from '@/components/auth/AuthContext';
// Code-split heavy tabs; they will mount once and remain mounted (NAV-12)
const Receiving = lazy(() => import('./Receiving'));
const WorkOrder = lazy(() => import('./WorkOrder'));
const Movements = lazy(() => import('./Movements'));
import MetricCard from '@/features/inventory/components/Dashboard/MetricCard';
import { 
  getMovements as getBackendMovements, 
  deleteMovement as deleteBackendMovement,
  skuOperations,
  vendorOperations,
  movementOperations,
  getFIFOLayers
} from '@/features/inventory/services/inventory.adapter';
import { MovementLogEntry, MovementType as MovementTypeEnum, toMovementId } from '@/features/inventory/types/inventory.types';

// Types
type Vendor = { id: string; name: string; address?: string; bank?: string; email?: string; phone?: string };

// Mock vendors data
const MOCK_VENDORS: Vendor[] = [
  { id: 'V001', name: 'ABC Metals LLC', address: '123 Industrial Ave, Austin, TX', bank: 'Chase • ****-1234', email: 'ap@abcmetals.com', phone: '+1 512 555 0101' },
  { id: 'V002', name: 'GasketCo Supplies', address: '910 Gasket Rd, Chicago, IL', bank: 'BoA • ****-8745', email: 'billing@gasketco.com', phone: '+1 312 555 0144' },
  { id: 'V003', name: 'Premier Rubber', address: '77 Harbor St, Long Beach, CA', bank: 'Wells • ****-4412', email: '-', phone: '-' },
  { id: 'V004', name: 'Silicone Works', address: '8 Tech Park, Reno, NV', bank: '-', email: '-', phone: '-' },
  { id: 'V005', name: 'MetalSource Inc.', address: '4 Forge Blvd, Detroit, MI', bank: '-', email: '-', phone: '-' },
  { id: 'V006', name: 'Gasket & Seals Partners', address: '55 Supply Way, Phoenix, AZ', bank: '-', email: '-', phone: '-' },
];

// Simple time helpers (port from the JS wireframe)
const ONE_DAY = 24 * 60 * 60 * 1000;
function getRange(period: 'today'|'last7'|'month'|'quarter'|'custom', customStart?: string, customEnd?: string) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (period === 'today') return [startOfToday, now.getTime()] as const;
  if (period === 'last7') return [now.getTime() - 7 * ONE_DAY, now.getTime()] as const;
  if (period === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), now.getTime()] as const;
  if (period === 'custom') {
    const s = customStart ? new Date(customStart + 'T00:00:00').getTime() : now.getTime() - 7 * ONE_DAY;
    const e = customEnd ? new Date(customEnd + 'T23:59:59').getTime() : now.getTime();
    return [Math.min(s, e), Math.max(s, e)] as const;
  }
  const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
  return [new Date(now.getFullYear(), qStartMonth, 1).getTime(), now.getTime()] as const;
}
function buildBins(start: number, end: number, n = 7): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const step = Math.max(1, Math.floor((end - start) / n));
  for (let i = 0; i < n; i++) {
    const s = start + i * step;
    const e = i === n - 1 ? end : start + (i + 1) * step;
    out.push([s, e]);
  }
  return out;
}

// Dedicated SKUs Modal shell component to enforce consistent layout and a11y
function SKUsModal({ children, onClose, onToggleAdd, addOpen }: { children: React.ReactNode; onClose: () => void; onToggleAdd: () => void; addOpen: boolean }) {
  const modalRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    modalRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="skus-title">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose}></div>
      <div className="absolute left-1/2 top-8 -translate-x-1/2 w-[min(100%,1100px)]" onClick={(e) => e.stopPropagation()}>
        <div 
          ref={modalRef}
          tabIndex={-1}
          className="bg-white rounded-2xl shadow-2xl max-h-[85vh] flex flex-col"
        >
          {/* Header (sticky) */}
          <div className="sticky top-0 z-10 bg-white rounded-t-2xl border-b px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CardTitle id="skus-title">SKUs</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={onToggleAdd}>{addOpen ? 'Close form' : 'Add SKU'}</Button>
              <Button size="sm" onClick={onClose} aria-label="Close">✕</Button>
            </div>
          </div>
          {/* Content (scrollable) */}
          <div className="px-4 py-3 overflow-y-auto">
            {children}
          </div>
          {/* Footer (sticky) */}
          <div className="sticky bottom-0 z-10 bg-white rounded-b-2xl border-t px-4 py-3">
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={onClose}>Update</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
// Mock minimal data for demo (series built from bins below)
const fmtMoney = (n: number) => `$ ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt = (n: number) => n.toLocaleString('en-US');

type PeriodOption = 'today' | 'last7' | 'month' | 'quarter' | 'custom';
type MaterialType = 'RAW' | 'SELLABLE';
type ProductCategory = 'Adhesives' | 'Boxes' | 'Cork/Rubber' | 'Polyurethane Ester' | 'Polyurethane Ether' | 'Felt' | 'Fibre Foam' | 'Film and Foil';
type SKU = { id: string; description?: string; type: MaterialType; productCategory: ProductCategory; unit?: string; min?: number; onHand?: number };
type Layer = { id: string; date: string; remaining: number; cost: number };

const CATEGORY_OPTIONS: ProductCategory[] = ['Adhesives','Boxes','Cork/Rubber','Polyurethane Ester','Polyurethane Ether','Felt','Fibre Foam','Film and Foil'];

const MOCK_SKUS: SKU[] = [
  { id: 'SKU-001', description: 'GAX-12', type: 'RAW', productCategory: 'Cork/Rubber', unit: 'unit', min: 100, onHand: 80 },
  { id: 'SKU-002', description: 'GAX-16', type: 'RAW', productCategory: 'Adhesives', unit: 'unit', min: 150, onHand: 200 },
  { id: 'P-001', description: 'Gasket P-001', type: 'SELLABLE', productCategory: 'Fibre Foam', unit: 'unit', min: 180, onHand: 210 },
  { id: 'P-002', description: 'Gasket P-002', type: 'SELLABLE', productCategory: 'Film and Foil', unit: 'unit', min: 120, onHand: 90 },
];

const INITIAL_LAYERS: Record<string, Layer[]> = {
  'SKU-001': [{ id: 'SKU-001-L1', date: '2025-07-01', remaining: 60, cost: 5.20 }, { id: 'SKU-001-L2', date: '2025-07-15', remaining: 20, cost: 5.40 }],
  'SKU-002': [{ id: 'SKU-002-L1', date: '2025-08-01', remaining: 150, cost: 5.40 }, { id: 'SKU-002-L2', date: '2025-08-10', remaining: 50, cost: 5.50 }],
  'P-001': [{ id: 'P-001-L1', date: '2025-08-02', remaining: 120, cost: 12.73 }, { id: 'P-001-L2', date: '2025-08-06', remaining: 90, cost: 12.91 }],
  'P-002': [{ id: 'P-002-L1', date: '2025-08-04', remaining: 90, cost: 12.91 }],
};

function fifoAvgCost(layers: Layer[] | undefined): number | null {
  if (!layers || layers.length === 0) return null;
  const totalQty = layers.reduce((s, l) => s + Math.max(0, l.remaining), 0);
  if (totalQty <= 0) return null;
  const totalVal = layers.reduce((s, l) => s + Math.max(0, l.remaining) * l.cost, 0);
  return totalVal / totalQty;
}

// Parse datetime stamp helper (from original wireframe)
function parseStamp(datetime: string | Date): Date {
  if (datetime instanceof Date) return datetime;
  // Handle formats like "2025-08-15 14:30" or ISO strings
  if (datetime.includes('T')) return new Date(datetime);
  return new Date(datetime.replace(' ', 'T'));
}

// Package icon for Receiving tab
function Package({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
    </svg>
  );
}

// ClipboardList icon for Work Order tab
function ClipboardList({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
    </svg>
  );
}

// Activity icon for Movements tab
function Activity({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  );
}

// --- Missing UI components causing runtime crashes ---
function ChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M6 9l6 6 6-6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronUp({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M18 15l-6-6-6 6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Layers({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M12 2l9 4-9 4-9-4 9-4z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 10l9 4 9-4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 16l9 4 9-4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// (Removed) Local MetricCard in favor of imported MetricCard with info popover support

// --- SKUs manager (master data) ---
function SKUsManager({ 
  items, 
  onChange,
  openForm: openFormProp,
  onToggleForm,
  hideLocalHeader,
  onRefresh
}: { 
  items: SKU[]; 
  onChange: (items: SKU[]) => void;
  openForm?: boolean;
  onToggleForm?: () => void;
  hideLocalHeader?: boolean;
  onRefresh?: () => Promise<void>;
}) {
  const emptySku: SKU = { id: '', description: '', type: 'RAW', productCategory: 'Cork/Rubber', unit: 'unit', min: 0, onHand: 0 };
  const [openFormUncontrolled, setOpenFormUncontrolled] = useState(false);
  const openForm = openFormProp ?? openFormUncontrolled;
  const setOpenForm = onToggleForm ?? (() => setOpenFormUncontrolled(v => !v));
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [form, setForm] = useState<SKU>(emptySku);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Simple validation mirroring Receiving's Quantity rules for Minimum (> 0)
  const validateForm = (f: SKU) => {
    const e: Record<string, string> = {};
    if (!f.id.trim()) e.id = 'Code is required';
    if ((f.min ?? 0) <= 0) e.min = 'Minimum must be greater than 0';
    return e;
  };

  useEffect(() => {
    setErrors(validateForm(form));
  }, [form]);

  function resetForm() { setForm(emptySku); setEditingIndex(null); if (!openFormProp) setOpenForm(); }
  async function saveSKU() {
    const id = (form.id || '').trim().toUpperCase(); // Ensure uppercase for SKUId validation
    if (!id) return;
    // Block save if there are validation errors
    const e = validateForm({ ...form, id });
    setErrors(e);
    if (Object.keys(e).length > 0) return;

    try {
      if (editingIndex === null) {
        // Creating new SKU - use backend API
        const newSkuData = {
          id: id as any, // Will be validated by toSKUId in backend
          description: form.description || '',
          type: form.type as any, // Convert to backend enum
          productCategory: form.productCategory as any, // Convert to backend enum
          unit: form.unit || 'unit',
          active: true,
          min: form.min || 0
        };
        
        await skuOperations.createSKU(newSkuData);
        
        // Refresh data from backend instead of manual state management
        if (onRefresh) {
          await onRefresh();
        }
        
        toast.success(`SKU "${id}" created successfully!`);
      } else {
        // Editing existing SKU - use backend API
        const originalSku = items[editingIndex];
        const updateData = {
          description: form.description || '',
          type: form.type as any,
          productCategory: form.productCategory as any,
          unit: form.unit || 'unit',
          min: form.min || 0
          // Note: id cannot be changed, active and onHand are managed separately
        };
        
        await skuOperations.updateSKU(originalSku.id, updateData);
        
        // Refresh data from backend instead of manual state management
        if (onRefresh) {
          await onRefresh();
        }
        
        toast.success(`SKU "${id}" updated successfully!`);
      }
      
      resetForm();
    } catch (error: any) {
      console.error('Error saving SKU:', error);
      let errorMessage = 'Failed to save SKU';
      
      if (error?.message?.includes('duplicate')) {
        errorMessage = `SKU "${id}" already exists`;
      } else if (error?.message) {
        errorMessage = error.message;
      }
      
      toast.error(errorMessage);
    }
  }
  function startEdit(i: number) { 
    setForm({ ...items[i] }); 
    setEditingIndex(i); 
    if (!openForm) setOpenForm();
    // Highlight missing required fields immediately
    setErrors(validateForm(items[i]));
  }
  function askDelete(i: number) { 
    const sku = items[i];
    const hasStock = (sku.onHand ?? 0) > 0;
    
    if (hasStock) {
      // Show popup explaining why deletion is not allowed
      toast.error(`Cannot delete SKU "${sku.id}" because it has ${sku.onHand} units in stock. Please reduce inventory to zero before deleting.`);
      return;
    }
    
    setConfirmDelete(i); 
  }
  function cancelDelete() { setConfirmDelete(null); }
  async function removeSKUConfirmed(i: number) { 
    const skuToDelete = items[i];
    if (!skuToDelete) return;

    try {
      // Delete from backend
      await skuOperations.deleteSKU(skuToDelete.id);
      
      // Refresh data from backend instead of manual state management
      if (onRefresh) {
        await onRefresh();
      }
      
      if (editingIndex === i) resetForm(); 
      setConfirmDelete(null);
      
      toast.success(`SKU "${skuToDelete.id}" deleted successfully!`);
    } catch (error: any) {
      console.error('Error deleting SKU:', error);
      let errorMessage = 'Failed to delete SKU';
      
      if (error?.message?.includes('foreign key') || error?.message?.includes('referenced')) {
        errorMessage = `Cannot delete SKU "${skuToDelete.id}" - it has associated movements or inventory`;
      } else if (error?.message) {
        errorMessage = error.message;
      }
      
      toast.error(errorMessage);
      setConfirmDelete(null);
    }
  }

  return (
    <div className="space-y-4">
      {!hideLocalHeader && (
        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-600">Centralized SKU master data</div>
          <Button size="sm" className="rounded-xl" onClick={() => setOpenForm()}>{openForm ? 'Close' : 'Add SKU'}</Button>
        </div>
      )}
      {openForm && (
        <div className="rounded-2xl border border-dashed p-4 grid grid-cols-1 sm:grid-cols-12 gap-3">
          {/* NAV-71: Editing indicator for SKU Manager (paridade com Vendors) */}
          {editingIndex !== null && (
            <div className="sm:col-span-12 text-xs text-slate-500">Editing SKU: <b>{items[editingIndex]?.id}</b></div>
          )}
          <div className="sm:col-span-3">
            <Label htmlFor="sku-code" className="mb-1.5 block">Code *</Label>
            <Input 
              id="sku-code"
              className={`w-full h-10 ${errors.id ? 'border-red-500 focus:ring-red-500' : ''}`}
              value={form.id} 
              onChange={e => setForm({ ...form, id: e.target.value })} 
              placeholder="SKU-001"
              aria-invalid={!!errors.id}
              aria-describedby={errors.id ? 'sku-code-error' : undefined}
            />
            {errors.id && (<div id="sku-code-error" className="text-sm text-red-600 mt-1">{errors.id}</div>)}
          </div>
          <div className="sm:col-span-5">
            <Label className="mb-1.5 block">Description</Label>
            <Input className="w-full" value={form.description ?? ''} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="GAX-12" />
          </div>
          <div className="sm:col-span-2">
            <Label className="mb-1.5 block">Type</Label>
            <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as MaterialType })}>
              <SelectTrigger className="h-10 w-full rounded-xl"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="RAW">Raw</SelectItem>
                <SelectItem value="SELLABLE">Sellable</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label className="mb-1.5 block">Category</Label>
            <Select value={form.productCategory} onValueChange={(v) => setForm({ ...form, productCategory: v as ProductCategory })}>
              <SelectTrigger className="h-10 w-full rounded-xl"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map(c => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label className="mb-1.5 block">Unit</Label>
            <Input className="w-full" value={form.unit ?? ''} onChange={e => setForm({ ...form, unit: e.target.value })} placeholder="unit" />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="sku-minimum" className="mb-1.5 block">Minimum *</Label>
            <Input 
              id="sku-minimum"
              className={`w-full h-10 ${errors.min ? 'border-red-500 focus:ring-red-500' : ''}`}
              type="number" 
              min={1}
              value={form.min ?? 0} 
              onChange={e => setForm({ ...form, min: Math.max(0, parseInt(e.target.value || '0', 10)) })}
              placeholder="0"
              aria-invalid={!!errors.min}
              aria-describedby={errors.min ? 'sku-minimum-error' : undefined}
            />
            {errors.min && (<div id="sku-minimum-error" className="text-sm text-red-600 mt-1">{errors.min}</div>)}
          </div>
          <div className="sm:col-span-12 flex gap-2 justify-end">
            <Button className="rounded-xl" onClick={saveSKU}>{editingIndex === null ? 'Save' : 'Update'}</Button>
            <Button variant="outline" className="rounded-xl" onClick={resetForm}>Cancel</Button>
          </div>
        </div>
      )}
      <div className="overflow-x-auto">
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Unit</TableHead>
              <TableHead>Minimum</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((s, i) => {
              const hasStock = (s.onHand ?? 0) > 0;
              return (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.id}</TableCell>
                  <TableCell>{s.description ?? '-'}</TableCell>
                  <TableCell>{s.type === 'RAW' ? 'Raw' : 'Sellable'}</TableCell>
                  <TableCell>{s.productCategory}</TableCell>
                  <TableCell>{s.unit ?? '-'}</TableCell>
                  <TableCell>{s.min ?? 0}</TableCell>
                  <TableCell className="text-right">
                    {confirmDelete === i ? (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="destructive" onClick={() => removeSKUConfirmed(i)}>Confirm</Button>
                        <Button size="sm" variant="outline" onClick={cancelDelete}>Cancel</Button>
                      </div>
                    ) : (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => startEdit(i)}>Edit</Button>
                        <Button 
                          size="sm" 
                          variant="outline" 
                          className={hasStock ? "text-gray-400 cursor-not-allowed" : "text-red-600"} 
                          onClick={() => askDelete(i)}
                          disabled={hasStock}
                          title={hasStock ? `Cannot delete: SKU has ${s.onHand} units in stock` : "Delete SKU"}
                        >
                          Delete
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// --- Vendors manager (master data) ---
function VendorsManager({ 
  items, 
  onChange, 
  onRefresh 
}: { 
  items: Vendor[]; 
  onChange: (items: Vendor[]) => void;
  onRefresh?: () => Promise<void>;
}) {
  const emptyVendor: Vendor = { id: '', name: '', email: '', phone: '', address: '', bank: '' };
  const [openForm, setOpenForm] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [form, setForm] = useState<Vendor>(emptyVendor);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validateForm = (f: Vendor) => {
    const e: Record<string, string> = {};
    if (!(f.name || '').trim()) e.name = 'Name is required';
    return e;
  };

  useEffect(() => {
    setErrors(validateForm(form));
  }, [form]);

  function resetForm() { setForm(emptyVendor); setEditingIndex(null); setOpenForm(false); }
  async function saveVendor() {
    const name = (form.name || '').trim();
    const e = validateForm({ ...form, name });
    setErrors(e);
    if (!name || Object.keys(e).length > 0) return;

    try {
      if (editingIndex === null) {
        // Creating new vendor - use backend API
        const newVendorData = {
          name: name,
          address: form.address?.trim() || undefined,
          email: form.email?.trim() || undefined,
          phone: form.phone?.trim() || undefined,
          bank: form.bank?.trim() || undefined,
        };
        
        await vendorOperations.createVendor(newVendorData);
        
        toast.success(`Vendor "${name}" created successfully!`);
      } else {
        // Editing existing vendor - use backend API
        const originalVendor = items[editingIndex];
        const updateData = {
          name: name,
          address: form.address?.trim() || undefined,
          email: form.email?.trim() || undefined,
          phone: form.phone?.trim() || undefined,
          bank: form.bank?.trim() || undefined,
        };
        
        await vendorOperations.updateVendor(originalVendor.id, updateData);
        
        toast.success(`Vendor "${name}" updated successfully!`);
      }
      
      // Refresh data from backend instead of manual state management
      if (onRefresh) {
        await onRefresh();
      }
      
      resetForm();
    } catch (error: any) {
      console.error('Error saving vendor:', error);
      let errorMessage = 'Failed to save vendor';
      
      if (error?.message?.includes('duplicate') || error?.message?.includes('unique')) {
        errorMessage = `Vendor "${name}" already exists`;
      } else if (error?.message) {
        errorMessage = error.message;
      }
      
      toast.error(errorMessage);
    }
  }
  function startEdit(i: number) { 
    setForm({ ...items[i] }); 
    setEditingIndex(i); 
    setOpenForm(true);
    setErrors(validateForm(items[i]));
  }
  function askDelete(i: number) { setConfirmDelete(i); }
  function cancelDelete() { setConfirmDelete(null); }
  async function removeVendorConfirmed(i: number) { 
    const vendorToDelete = items[i];
    if (!vendorToDelete) return;

    try {
      // Delete from backend (soft delete - sets active = false)
      await vendorOperations.deleteVendor(vendorToDelete.id);
      
      // Refresh data from backend
      if (onRefresh) {
        await onRefresh();
      }
      
      if (editingIndex === i) resetForm(); 
      setConfirmDelete(null);
      
      toast.success(`Vendor "${vendorToDelete.name}" deleted successfully!`);
    } catch (error: any) {
      console.error('Error deleting vendor:', error);
      let errorMessage = 'Failed to delete vendor';
      
      if (error?.message?.includes('foreign key') || error?.message?.includes('referenced')) {
        errorMessage = `Cannot delete vendor "${vendorToDelete.name}" - it has associated transactions or data`;
      } else if (error?.message) {
        errorMessage = error.message;
      }
      
      toast.error(errorMessage);
      setConfirmDelete(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-600">Centralized vendor master data</div>
        <Button 
          size="sm" 
          className="rounded-xl" 
          onClick={() => {
            setOpenForm(v => {
              const next = !v;
              if (next) {
                setForm(emptyVendor);
                setErrors(validateForm(emptyVendor));
              }
              return next;
            });
          }}
        >
          {openForm ? 'Close' : 'Add Vendor'}
        </Button>
      </div>
      {openForm && (
        <div className="rounded-2xl border border-dashed p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          {editingIndex !== null && (
            <div className="md:col-span-2 text-xs text-slate-500">Editing vendor: <b>{items[editingIndex]?.name}</b></div>
          )}
          <div>
            <Label htmlFor="vendor-name" className="mb-1.5 block">Name *</Label>
            <Input 
              id="vendor-name"
              className={`w-full h-10 ${errors.name ? 'border-red-500 focus:ring-red-500' : ''}`}
              value={form.name ?? ''} 
              onChange={e => setForm({ ...form, name: e.target.value })} 
              placeholder="e.g., ABC Metals LLC"
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? 'vendor-name-error' : undefined}
            />
            {errors.name && (<div id="vendor-name-error" className="text-sm text-red-600 mt-1">{errors.name}</div>)}
          </div>
          <div>
            <Label htmlFor="vendor-email" className="mb-1.5 block">Email</Label>
            <Input id="vendor-email" className="w-full h-10" value={form.email ?? ''} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="ap@vendor.com" />
          </div>
          <div>
            <Label htmlFor="vendor-phone" className="mb-1.5 block">Phone</Label>
            <Input id="vendor-phone" className="w-full h-10" value={form.phone ?? ''} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="+1 (555) 000-0000" />
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="vendor-address" className="mb-1.5 block">Address</Label>
            <Input id="vendor-address" className="w-full h-10" value={form.address ?? ''} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="Street, City, State" />
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="vendor-bank" className="mb-1.5 block">Bank account</Label>
            <Input id="vendor-bank" className="w-full h-10" value={form.bank ?? ''} onChange={e => setForm({ ...form, bank: e.target.value })} placeholder="Bank • ****-1234" />
          </div>
          <div className="md:col-span-2 flex gap-2 justify-end">
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
            <TableRow key={v.id || String(i)}>
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
                    <Button size="sm" variant="outline" onClick={() => startEdit(i)}>Edit</Button>
                    <Button size="sm" variant="outline" className="text-red-600" onClick={() => askDelete(i)}>Delete</Button>
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

export default function InventoryWireframe() {
  const { user, signOut } = useAuth();
  const [tab, setTab] = useState('dashboard');
  const [period, setPeriod] = useState<PeriodOption>('last7');
  const [customStart, setCustomStart] = useState<string>('');
  const [customEnd, setCustomEnd] = useState<string>('');
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [skuMaster, setSkuMaster] = useState<SKU[]>([]);
  const [skus, setSkus] = useState<SKU[]>([]);
  // Initialize without mock data; layers are fetched from backend on demand (e.g., when opening the modal)
  const [layersBySku, setLayersBySku] = useState<Record<string, Layer[]>>({});
  // Map to hold backend current average cost per SKU (from inventory_summary)
  const [avgCostMap, setAvgCostMap] = useState<Record<string, number>>({});
  
  // Movement log for tracking inventory transactions
  const [movementLog, setMovementLog] = useState<MovementLogEntry[]>([]);
  const [isLoadingMovements, setIsLoadingMovements] = useState(false);
  
  const loadMovements = useCallback(async () => {
    try {
      setIsLoadingMovements(true);
      // Load only movements within the selected period for accurate KPIs
      const [rangeStart, rangeEnd] = getRange(period, customStart, customEnd);
      const { movements } = await getBackendMovements({
        dateFrom: new Date(rangeStart),
        dateTo: new Date(rangeEnd),
        // High limit to avoid truncation within the period; backend can page if needed
        limit: 5000,
      });
       // Map MovementWithDetails -> UI MovementLogEntry
       const mapped: MovementLogEntry[] = (movements || []).map((m: any) => ({
         movementId: toMovementId(String(m.id)),
         datetime: (m.date instanceof Date ? m.date : new Date(m.date)),
         type: m.type as MovementTypeEnum,
         skuOrName: m.skuDescription,
         qty: m.quantity,
         value: m.totalCost,
         ref: m.reference || '',
       }));
       setMovementLog(mapped);
       toast.success(`Refreshed ${mapped.length} movements`);
     } catch (err: any) {
       toast.error('Failed to load movements');
       // eslint-disable-next-line no-console
       console.error('loadMovements error', err);
     } finally {
       setIsLoadingMovements(false);
     }
  }, [period, customStart, customEnd]);

  // Load Inventory Summary (inventory_summary view) and SKU master data
  const loadInventorySummary = useCallback(async () => {
    try {
      const summary = await skuOperations.getInventorySummary();
      // The adapter already returns UI-shaped items compatible with our SKU usage
      const summarySkus = (summary || []) as unknown as SKU[];
      setSkus(summarySkus);
      setSkuMaster(summarySkus); // Keep master data in sync
      
      // Build avg cost map
      const costMap: Record<string, number> = {};
      for (const r of summary || []) {
        if (typeof (r as any).currentAvgCost === 'number') costMap[(r as any).id as string] = (r as any).currentAvgCost;
      }
      setAvgCostMap(costMap);
    } catch (err) {
      console.error('loadInventorySummary error', err);
      // keep UI usable even if summary fails
    }
  }, []);

  // Load Vendors from backend
  const loadVendors = useCallback(async () => {
    try {
      const backendVendors = await vendorOperations.getAllVendors();
      // Map backend VendorRow to frontend Vendor type
      const mappedVendors: Vendor[] = (backendVendors || []).map((v: any) => ({
        id: v.id,
        name: v.name,
        address: v.address || undefined,
        email: v.email || undefined,
        phone: v.phone || undefined,
        bank: v.bank_info?.display || undefined,
      }));
      setVendors(mappedVendors);
    } catch (err) {
      console.error('loadVendors error', err);
      // keep UI usable even if vendors fail to load
    }
  }, []);
  const [expanded, setExpanded] = useState<Record<ProductCategory, boolean>>({
    'Adhesives': false, 'Boxes': false, 'Cork/Rubber': false, 'Polyurethane Ester': false,
    'Polyurethane Ether': false, 'Felt': false, 'Fibre Foam': false, 'Film and Foil': false,
  });
  
  // Quick menu state
  const [vendorsOpen, setVendorsOpen] = useState(false);
  const [skusOpen, setSkusOpen] = useState(false);
  const [skuFormOpen, setSkuFormOpen] = useState(false);
  
  // Movements export state
  const [movementsExportOpen, setMovementsExportOpen] = useState(false);

  // UX Polish: Modal ESC key handler and body scroll lock
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (vendorsOpen) setVendorsOpen(false);
        if (skusOpen) setSkusOpen(false);
      }
    };

    if (vendorsOpen || skusOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden'; // Lock body scroll
    } else {
      document.body.style.overflow = 'unset'; // Restore body scroll
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [vendorsOpen, skusOpen]);

  // Initial load of movements, inventory summary, and vendors
  useEffect(() => {
    loadMovements();
    loadInventorySummary();
    loadVendors();
  }, [loadMovements, loadInventorySummary, loadVendors]);

  // Refresh movements whenever Movements tab becomes active
  useEffect(() => {
    if (tab === 'movements') {
      loadMovements();
    }
    // Keep inventory snapshot fresh when returning to dashboard
    if (tab === 'dashboard') {
      loadInventorySummary();
    }
  }, [tab, loadMovements, loadInventorySummary]);

  // Refresh movements when the selected period changes (affects KPIs)
  useEffect(() => {
    loadMovements();
  }, [period, customStart, customEnd, loadMovements]);

  const { bins } = useMemo(() => {
    const [s, e] = getRange(period, customStart, customEnd);
    return { bins: buildBins(s, e, 7) };
  }, [period, customStart, customEnd]);

  const toggleCat = (c: ProductCategory) => setExpanded(prev => ({ ...prev, [c]: !prev[c] }));
  const avgCostFor = (skuId: string) => {
    const v = avgCostMap[skuId];
    return typeof v === 'number' ? v : fifoAvgCost(layersBySku[skuId]);
  };

  // INV-02 & INV-03: Excel export functions
  const exportToExcel = async (redFlagsOnly = false) => {
    const dataToExport = redFlagsOnly 
      ? skus.filter(s => (s.onHand || 0) < (s.min || 0))
      : skus;

    if (dataToExport.length === 0) {
      toast.info(redFlagsOnly ? 'No red flags found' : 'No data to export');
      return;
    }

    // Prepare data with proper formatting
    const excelData = dataToExport.map(s => {
      const qty = s.onHand || 0;
      const min = s.min || 0;
      const avgCost = avgCostFor(s.id);
      const assetValue = avgCost ? qty * avgCost : 0;
      
      return {
        'SKU Code': s.id,
        'Description': s.description || '',
        'Type': s.type === 'RAW' ? 'Raw' : 'Sellable',
        'Category': s.productCategory,
        'Unit': s.unit || '',
        'On Hand': qty,
        'Minimum': min,
        'Status': qty >= min ? 'OK' : 'Below minimum',
        'Avg. Cost (FIFO)': avgCost ? avgCost.toFixed(2) : 0,
        'Asset Value': avgCost ? assetValue.toFixed(2) : 0
      };
    });

    // Create workbook and worksheet (lazy-load xlsx to keep main bundle lean)
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(excelData);

    // Set column widths
    const colWidths = [
      { wch: 12 }, // SKU Code
      { wch: 30 }, // Description
      { wch: 10 }, // Type
      { wch: 15 }, // Category
      { wch: 8 },  // Unit
      { wch: 10 }, // On Hand
      { wch: 10 }, // Minimum
      { wch: 15 }, // Status
      { wch: 15 }, // Avg. Cost
      { wch: 15 }  // Asset Value
    ];
    ws['!cols'] = colWidths;

    // Add worksheet to workbook
    const sheetName = redFlagsOnly 
      ? 'Red Flags Inventory'
      : 'Full Inventory';
    XLSX.utils.book_append_sheet(wb, ws, sheetName);

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = redFlagsOnly 
      ? `inventory-red-flags-${timestamp}.xlsx`
      : `inventory-full-${timestamp}.xlsx`;

    // Download file
    XLSX.writeFile(wb, filename);
    toast.success(`Exported ${dataToExport.length} record(s) to ${filename}`);
  };

  // Export movements to Excel with applied filters
  const exportMovementsToExcel = async (filteredMovements: any[], activeFilters: any) => {
    if (filteredMovements.length === 0) {
      toast.info('No movements to export');
      return;
    }

    // Prepare data with proper formatting for Excel
    const excelData = filteredMovements.map(([movement, originalIndex]) => {
      const datetime = movement.datetime instanceof Date 
        ? movement.datetime 
        : new Date(movement.datetime);
      
      return {
        'Date': datetime.toLocaleDateString('en-US'),
        'Time': datetime.toLocaleTimeString('en-US'),
        'Type': movement.type,
        'SKU/Product': movement.skuOrName || '-',
        'Quantity': movement.qty || 0,
        'Value': movement.value ? movement.value.toFixed(2) : 0,
        'Reference': movement.ref || '-',
      };
    });

    // Create workbook and worksheet
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(excelData);

    // Set column widths
    const colWidths = [
      { wch: 12 }, // Date
      { wch: 10 }, // Time
      { wch: 10 }, // Type
      { wch: 25 }, // SKU/Product
      { wch: 12 }, // Quantity
      { wch: 12 }, // Value
      { wch: 20 }, // Reference
    ];
    ws['!cols'] = colWidths;

    // Add worksheet to workbook
    const sheetName = 'Movements Export';
    XLSX.utils.book_append_sheet(wb, ws, sheetName);

    // Generate filename with timestamp and filter info
    const timestamp = new Date().toISOString().split('T')[0];
    const filterSuffix = Object.values(activeFilters).some(f => f) ? '-filtered' : '';
    const filename = `movements-export${filterSuffix}-${timestamp}.xlsx`;

    // Download file
    XLSX.writeFile(wb, filename);
    toast.success(`Exported ${filteredMovements.length} movement record(s) to ${filename}`);
  };

  // Group SKUs by Category
  const grouped = useMemo(() => {
    // Start with known categories but allow dynamic ones to avoid push on undefined
    const map: Record<string, SKU[]> = {
      'Adhesives': [], 'Boxes': [], 'Cork/Rubber': [], 'Polyurethane Ester': [],
      'Polyurethane Ether': [], 'Felt': [], 'Fibre Foam': [], 'Film and Foil': [],
    };
    for (const s of skus) {
      const key = s.productCategory || 'Uncategorized';
      if (!map[key]) map[key] = [];
      map[key].push(s);
    }
    return map as Record<ProductCategory, SKU[]> as any;
  }, [skus]);

  const TrafficLight = ({ ok }: { ok: boolean }) => (
    <div className="flex items-center gap-2">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
      <span className={`text-xs ${ok ? 'text-emerald-700' : 'text-red-700'}`}>{ok ? 'OK' : 'Below minimum'}</span>
    </div>
  );

  // Real KPI calculations based on movements (KPI-03/04/05)
  const kpiData = useMemo(() => {
    const [rangeStart, rangeEnd] = getRange(period, customStart, customEnd);
    
    // 1) Total Inventory (qty & value) — current snapshot
    const inv = skus.reduce((acc, s) => {
      const qty = Math.max(0, s.onHand ?? 0);
      const avg = (avgCostFor(s.id) ?? 0);
      acc.qty += qty;
      acc.value += qty * avg;
      return acc;
    }, { qty: 0, value: 0 });

    // Movement deltas for historical inventory calculation
    const deltas = movementLog.map(m => {
      const ts = +parseStamp(m.datetime);
      const v = Math.abs(m.value || 0);
      const delta = m.type === 'RECEIVE' ? +v : (m.type === 'ISSUE' || m.type === 'WASTE' ? -v : 0);
      return { ts, delta };
    });
    
    const nowInvValue = inv.value;
    const invAt = (ts: number) => nowInvValue - deltas.reduce((s, d) => (d.ts > ts ? s + d.delta : s), 0);

    // Inventory series (value) at end of each bin
    const inventorySeries = bins.map(([_, e]) => invAt(e));

    // COGS per bin & total (from ISSUE movements)
    const cogsPerBin = bins.map(([s, e]) => movementLog
      .filter(m => m.type === 'ISSUE')
      .reduce((sum, m) => {
        const ts = +parseStamp(m.datetime);
        return ts > s && ts <= e ? sum + (m.value || 0) : sum;
      }, 0));
    const cogsTotal = cogsPerBin.reduce((a, b) => a + b, 0);

    // Inventory Turnover = COGS / Average Inventory (period)
    const invStart = invAt(rangeStart);
    const invEnd = invAt(rangeEnd);
    const avgInvPeriod = Math.max(0, (invStart + invEnd) / 2);
    const turnoverVal = avgInvPeriod > 0 ? (cogsTotal / avgInvPeriod) : 0;
    const turnoverSeries = bins.map(([s, e], i) => {
      const invS = invAt(s), invE = invAt(e);
      const avgBin = Math.max(0, (invS + invE) / 2);
      return avgBin > 0 ? (cogsPerBin[i] / avgBin) : 0;
    });

    // Days of Inventory = Current Inventory ÷ Daily Consumption (ISSUE + WASTE)
    const daysInPeriod = Math.max(1, (rangeEnd - rangeStart) / ONE_DAY);
    const consPerBin = bins.map(([s, e]) => movementLog
      .filter(m => m.type === 'ISSUE' || m.type === 'WASTE')
      .reduce((sum, m) => {
        const ts = +parseStamp(m.datetime);
        return ts > s && ts <= e ? sum + (m.value || 0) : sum;
      }, 0));
    const consTotal = consPerBin.reduce((a, b) => a + b, 0);
    const dailyCOGS = consTotal / daysInPeriod;
    const doiVal = dailyCOGS > 0 ? (nowInvValue / dailyCOGS) : Infinity;
    
    let cum = 0;
    const doiSeriesRaw = bins.map(([, e], i) => {
      cum += consPerBin[i];
      const daysSoFar = Math.max((e - rangeStart) / ONE_DAY, 1e-6);
      const daily = cum / daysSoFar;
      const invEndBin = invAt(e);
      return daily > 0 ? (invEndBin / daily) : Infinity;
    });
    const doiSeries = doiSeriesRaw.map(v => (Number.isFinite(v) ? v : 0));

    return {
      inv,
      inventorySeries,
      turnoverVal,
      turnoverSeries,
      cogsTotal,
      doiVal,
      doiSeries,
      dailyCOGS,
      // Extra breakdown fields for UI explanations
      invStart,
      invEnd,
      avgInvPeriod,
      daysInPeriod,
      nowInvValue
    };
  }, [skus, layersBySku, movementLog, bins, period, customStart, customEnd]);

  return (
    <div className="min-h-screen w-full bg-white text-slate-900">
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-xl bg-slate-900 text-white grid place-items-center">PG</div>
            <div>
              <p className="text-sm text-slate-500 leading-none">Premier Gaskets</p>
              <h1 className="text-base font-semibold">Inventory — Dashboard (Preview)</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-2">
              <Badge variant="secondary" className="rounded-full">MVP</Badge>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-sm text-slate-600">
                {user?.email}
              </div>
              <Button 
                variant="outline" 
                size="sm"
                onClick={signOut}
                className="rounded-xl"
              >
                Sign Out
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Quick Menu bar (sticky under header) */}
      <div className="sticky top-[56px] z-20 bg-white/90 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-slate-600 text-sm">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-slate-900 text-white text-[10px]">QM</span>
            <span>Quick menu</span>
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="rounded-xl" onClick={() => setVendorsOpen(true)}>Open Vendors</Button>
            <Button size="sm" variant="outline" className="rounded-xl" onClick={() => setSkusOpen(true)}>Open SKUs</Button>
          </div>
        </div>
      </div>

      <main className="max-w-6xl mx-auto px-4 py-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid grid-cols-4 w-full rounded-2xl">
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="receiving" className="flex items-center justify-center gap-2">
              <Package className="h-4 w-4" />
              Receiving
            </TabsTrigger>
            <TabsTrigger value="workorder" className="flex items-center justify-center gap-2">
              <ClipboardList className="h-4 w-4" />
              Work Order
            </TabsTrigger>
            <TabsTrigger value="movements" className="flex items-center justify-center gap-2">
              <Activity className="h-4 w-4" />
              Movements
            </TabsTrigger>
          </TabsList>

          {/* NAV-12: Keep all tabs mounted for state persistence */}
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
                        <Input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="h-8 rounded-xl" />
                        <span className="text-slate-500">to</span>
                        <Input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="h-8 rounded-xl" />
                      </div>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <MetricCard 
                    title="Total Inventory (qty / value)" 
                    primary={kpiData.inv.qty.toLocaleString('en-US')} 
                    unitPrimary="units" 
                    secondary={fmtMoney(kpiData.inv.value)} 
                    series={kpiData.inventorySeries} 
                    valueFormatter={fmtMoney}
                    infoContent={
                      <div>
                        <p>Total stock on hand and its asset value at current average cost (FIFO).</p>
                        <ul className="list-disc pl-4 mt-1 space-y-1">
                          <li><strong>Qty</strong>: Sum of on-hand across SKUs.</li>
                          <li><strong>Value</strong>: Σ(on-hand × avg. cost per SKU).</li>
                          <li><strong>Avg. cost</strong> follows FIFO layers.</li>
                        </ul>
                      </div>
                    }
                  />
                  <MetricCard 
                    title="Inventory Turnover" 
                    primary={Number.isFinite(kpiData.turnoverVal) ? kpiData.turnoverVal.toFixed(2) : '—'} 
                    unitPrimary="x" 
                    secondary={`${fmtMoney(kpiData.cogsTotal)} COGS in period`} 
                    series={kpiData.turnoverSeries} 
                    valueFormatter={(v) => `${v.toFixed(2)}x`}
                    infoContent={
                      <div>
                        <p>How many times stock "turned over" in the selected period.</p>
                        <ul className="list-disc pl-4 mt-1 space-y-1">
                          <li><strong>Formula</strong>: Turnover = COGS ÷ Average Inventory.</li>
                          <li><strong>COGS in period</strong>: {fmtMoney(kpiData.cogsTotal)}</li>
                          <li><strong>Inventory (start/end)</strong>: {fmtMoney(kpiData.invStart)} → {fmtMoney(kpiData.invEnd)}</li>
                          <li><strong>Average Inventory</strong>: ({fmtMoney(kpiData.invStart)} + {fmtMoney(kpiData.invEnd)}) ÷ 2 = {fmtMoney(kpiData.avgInvPeriod)}</li>
                          <li><strong>Calculation</strong>: {fmtMoney(kpiData.cogsTotal)} ÷ {fmtMoney(kpiData.avgInvPeriod)} = {Number.isFinite(kpiData.turnoverVal) ? kpiData.turnoverVal.toFixed(2) : '—'}x</li>
                          <li><strong>Units</strong>: "x" (higher means faster turnover).</li>
                        </ul>
                      </div>
                    }
                  />
                  <MetricCard 
                    title="Days of Inventory" 
                    primary={Number.isFinite(kpiData.doiVal) ? kpiData.doiVal.toFixed(1) : '∞'} 
                    unitPrimary="days" 
                    secondary={`Daily COGS: ${fmtMoney(kpiData.dailyCOGS)}`} 
                    series={kpiData.doiSeries} 
                    valueFormatter={(v) => `${v.toFixed(1)} days`}
                    infoContent={
                      <div>
                        <p>Estimated number of days current inventory can cover at recent consumption.</p>
                        <ul className="list-disc pl-4 mt-1 space-y-1">
                          <li><strong>Formula</strong>: Days = Current inventory ÷ Daily COGS.</li>
                          <li><strong>Current inventory (value)</strong>: {fmtMoney(kpiData.nowInvValue)}</li>
                          <li><strong>Days in period</strong>: {Math.round(kpiData.daysInPeriod)} day(s)</li>
                          <li><strong>Daily COGS</strong>: {fmtMoney(kpiData.dailyCOGS)} = {fmtMoney(kpiData.cogsTotal)} ÷ {Math.round(kpiData.daysInPeriod)}</li>
                          <li><strong>Calculation</strong>: {fmtMoney(kpiData.nowInvValue)} ÷ {fmtMoney(kpiData.dailyCOGS)} = {Number.isFinite(kpiData.doiVal) ? `${kpiData.doiVal.toFixed(1)} days` : '∞'}</li>
                          <li>If Daily COGS ≈ 0, the result tends to infinity (∞).</li>
                        </ul>
                      </div>
                    }
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-2xl border-dashed">
              <CardHeader className="py-4">
                <div className="flex items-center gap-2">
                  <Layers className="h-5 w-5 text-slate-500" />
                  <CardTitle className="text-lg">Inventory by SKU</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="text-xs text-slate-500">Traffic light: green = above minimum • red = below minimum</div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => exportToExcel(false)}>Export all (Excel)</Button>
                    <Button size="sm" onClick={() => exportToExcel(true)}>Export red flags (Excel)</Button>
                    <Select onValueChange={(v) => {
                      if (v === 'ALL') return setSkus(skuMaster);
                      setSkus(skuMaster.filter(s => s.type === (v as MaterialType)));
                    }}>
                      <SelectTrigger className="h-8 w-[200px] rounded-xl"><SelectValue placeholder="Filter by type" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ALL">All</SelectItem>
                        <SelectItem value="RAW">Raw</SelectItem>
                        <SelectItem value="SELLABLE">Sellable</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <Table className="min-w-[1100px] table-fixed">
                    <colgroup>
                      <col style={{ width: 220 }} />
                      <col style={{ width: 140 }} />
                      <col style={{ width: 260 }} />
                      <col style={{ width: 80 }} />
                      <col style={{ width: 100 }} />
                      <col style={{ width: 110 }} />
                      <col style={{ width: 130 }} />
                      <col style={{ width: 130 }} />
                      <col style={{ width: 110 }} />
                      <col style={{ width: 140 }} />
                    </colgroup>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[220px] whitespace-nowrap">Category</TableHead>
                        <TableHead className="whitespace-nowrap">SKU</TableHead>
                        <TableHead className="whitespace-nowrap">Description</TableHead>
                        <TableHead className="whitespace-nowrap">U/M</TableHead>
                        <TableHead className="whitespace-nowrap">Type</TableHead>
                        <TableHead className="text-right whitespace-nowrap">On hand</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Avg. cost (FIFO)</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Asset value</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Minimum</TableHead>
                        <TableHead className="whitespace-nowrap">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {CATEGORY_OPTIONS.map((cat) => {
                        const items = grouped[cat];
                        if (!items || items.length === 0) return (
                          <TableRow key={cat} className="opacity-60">
                            <TableCell className="font-medium">
                              <div className="flex items-center gap-2">
                                <ChevronDown className="h-4 w-4" />
                                {cat}
                              </div>
                            </TableCell>
                            <TableCell colSpan={9} className="text-sm text-slate-500">No SKUs</TableCell>
                          </TableRow>
                        );

                        const open = expanded[cat];
                        return (
                          <React.Fragment key={cat}>
                            <TableRow className="bg-slate-50/50">
                              <TableCell className="font-medium">
                                <button
                                  type="button"
                                  className="inline-flex items-center gap-2 w-full min-w-0"
                                  onClick={() => toggleCat(cat)}
                                  aria-expanded={open}
                                  title={cat}
                                >
                                  {open ? <ChevronUp className="h-4 w-4 shrink-0"/> : <ChevronDown className="h-4 w-4 shrink-0"/>}
                                  <span className="flex-1 min-w-0 truncate">{cat}</span>
                                  <Badge variant="secondary" className="ml-2 rounded-full whitespace-nowrap shrink-0">
                                    {items.length} SKU{items.length > 1 ? 's' : ''}
                                  </Badge>
                                </button>
                              </TableCell>
                              <TableCell colSpan={9}></TableCell>
                            </TableRow>
                            {open && items.map((s, i) => {
                              const qty = s.onHand ?? 0;
                              const min = s.min ?? 0;
                              const ok = qty >= min;
                              const avg = avgCostFor(s.id);
                              return (
                                <TableRow key={`${cat}-${s.id}-${i}`}>
                                  <TableCell className="pl-8"></TableCell>
                                  <TableCell className="font-medium">{s.id}</TableCell>
                                  <TableCell>{s.description ?? '-'}</TableCell>
                                  <TableCell>{s.unit ?? '-'}</TableCell>
                                  <TableCell>{s.type === 'RAW' ? 'Raw' : 'Sellable'}</TableCell>
                                  <TableCell className="text-right tabular-nums">{fmtInt(qty)}</TableCell>
                                  <TableCell className="text-right tabular-nums">{avg != null ? fmtMoney(avg) : '—'}</TableCell>
                                  <TableCell className="text-right tabular-nums">{avg != null ? fmtMoney(qty * avg) : '—'}</TableCell>
                                  <TableCell className="text-right tabular-nums">{fmtInt(min)}</TableCell>
                                  <TableCell><TrafficLight ok={ok} /></TableCell>
                                </TableRow>
                              );
                            })}
                          </React.Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* NAV-12: Receiving tab - always mounted, visibility controlled */}
          <div className={`mt-6 ${tab === 'receiving' ? '' : 'hidden'}`}>
            <Suspense fallback={<div>Loading...</div>}>
              <Receiving 
                vendors={vendors} 
                skus={skus} 
                layersBySku={layersBySku}
                movements={movementLog}
                onUpdateLayers={(skuId, newLayers) => {
                  // Update layers for the SKU (stateful)
                  setLayersBySku(prev => ({ ...prev, [skuId]: newLayers }));
                }}
                onUpdateSKU={(skuId, updates) => {
                  // Update SKU properties like onHand
                  setSkus(currentSkus => {
                    const { productCategory: _ignorePC, ...rest } = (updates as any) || {};
                    return currentSkus.map(sku => sku.id === skuId ? { ...sku, ...rest } : sku);
                  });
                }}
                onAddMovement={(movement) => {
                  // Add movement to log
                  setMovementLog(currentLog => [...currentLog, movement]);
                }}
              />
            </Suspense>
          </div>

          {/* NAV-12: Work Order tab - always mounted, visibility controlled */}
          <div className={`mt-6 ${tab === 'workorder' ? '' : 'hidden'}`}>
            <Suspense fallback={<div>Loading...</div>}>
              <WorkOrder 
                skus={skus} 
                layersBySku={layersBySku}
                onUpdateLayers={(skuId, newLayers) => {
                  // Update layers for the SKU (stateful)
                  setLayersBySku(prev => ({ ...prev, [skuId]: newLayers }));
                }}
                onUpdateSKU={(skuId, updates) => {
                  // Update SKU properties like onHand
                  setSkus(currentSkus => {
                    const { productCategory: _ignorePC, ...rest } = (updates as any) || {};
                    return currentSkus.map(sku => sku.id === skuId ? { ...sku, ...rest } : sku);
                  });
                }}
                onAddMovement={(movement) => {
                  // Add movement to log
                  setMovementLog(currentLog => [...currentLog, movement]);
                }}
                onRefreshInventory={() => {
                  // Ensure both inventory summary and movement list are up to date after WO
                  loadInventorySummary();
                  loadMovements();
                }}
              />
            </Suspense>
          </div>

          {/* NAV-12: Movements tab - always mounted, visibility controlled */}
          <div className={`mt-6 ${tab === 'movements' ? '' : 'hidden'}`}>
            <div className="flex items-center justify-end mb-2">
              <Button 
                size="sm" 
                variant="outline" 
                onClick={loadMovements}
                disabled={isLoadingMovements}
              >
                {isLoadingMovements ? 'Refreshing...' : 'Refresh'}
              </Button>
            </div>
              <Movements 
              movements={movementLog} 
              onExportExcel={exportMovementsToExcel}
              onDeleteMovement={async (movementId) => {
                console.log('🚀 onDeleteMovement called with:', movementId);
                console.log('🚀 deleteBackendMovement function:', typeof deleteBackendMovement);
                
                try {
                  console.log('✅ Starting backend deletion process for movementId:', movementId);
                  
                  // Extract the string value from the branded MovementId type
                  const idString = String(movementId);
                  const idNum = Number(idString);
                  
                  console.log('✅ Extracted ID - String:', idString, 'Number:', idNum);
                  
                  if (Number.isNaN(idNum)) {
                    console.error('❌ Invalid Movement ID:', idString);
                    toast.error(`Invalid Movement ID: ${idString}`);
                    return;
                  }

                  // Pre-fetch deletion info to know which SKU/layers to refresh
                  let affectedSkuId: string | undefined;
                  try {
                    const info = await movementOperations.getMovementDeletionInfo(idNum);
                    affectedSkuId = info?.skuId;
                    console.log('ℹ️ Deletion info fetched. Affected SKU:', affectedSkuId);
                  } catch (e) {
                    console.warn('⚠️ Could not fetch movement deletion info before delete; will still proceed.', e);
                  }

                  console.log('✅ About to call backend deleteMovement with ID:', idNum);
                  
                  // Call backend with stored procedure - handles all business rules and stock integrity
                  const result = await deleteBackendMovement(idNum, {
                    reason: 'User deletion via UI',
                    deletedBy: 'user'
                  });
                  
                  console.log('✅ Backend deletion result:', result);
                  console.log('✅ Result type:', typeof result);
                  console.log('✅ Result keys:', Object.keys(result || {}));
                  
                  // If backend succeeded, update frontend state
                  setMovementLog(currentLog => {
                    const newLog = currentLog.filter(movement => movement.movementId !== movementId);
                    console.log('✅ Movement removed from frontend state. Before:', currentLog.length, 'After:', newLog.length);
                    return newLog;
                  });
                  
                  // Ensure Inventory Summary reflects updated on_hand and avg cost
                  await loadInventorySummary();
                  // Keep Movements in sync (e.g., for other tabs or quick view)
                  await loadMovements();
                  
                  // Optionally refresh affected SKU's FIFO layers (if known)
                  if (affectedSkuId) {
                    try {
                      const freshLayers = await getFIFOLayers(affectedSkuId);
                      // Map LayerLite -> local Layer shape expected in this component
                      const mapped = (freshLayers || []).map(l => ({
                        id: String(l.id),
                        date: (l.date instanceof Date ? l.date.toISOString().slice(0, 10) : String(l.date)),
                        remaining: l.remaining,
                        cost: l.cost,
                      }));
                      setLayersBySku(prev => ({ ...prev, [affectedSkuId!]: mapped }));
                      console.log('✅ Refreshed FIFO layers for SKU:', affectedSkuId, 'Count:', mapped.length);
                    } catch (e) {
                      console.warn('⚠️ Failed to refresh FIFO layers for SKU', affectedSkuId, e);
                    }
                  }
                  
                  // Show success message with details
                  const restoredCount = result?.restoredLayers?.length || 0;
                  const relatedDeleted = result?.related_movements_deleted || 0;
                  console.log('✅ Restored layers count:', restoredCount);
                  console.log('✅ Related movements deleted:', relatedDeleted);
                  
                  toast.success(`Movement deleted successfully! ${restoredCount} layers restored, ${relatedDeleted} related movements deleted.`);

                } catch (error) {
                  console.error('❌ Error deleting movement:', error);
                  console.error('❌ Error type:', typeof error);
                  console.error('❌ Error message:', error?.message);
                  console.error('❌ Error details:', error?.details);
                  console.error('❌ Error code:', error?.code);
                  
                  // Parse Supabase error details
                  let errorMessage = 'An unknown error occurred';
                  if (error?.message) {
                    errorMessage = error.message;
                  } else if (error?.details) {
                    errorMessage = error.details;
                  } else if (typeof error === 'string') {
                    errorMessage = error;
                  }
                  
                  toast.error(`Failed to delete movement: ${errorMessage}`);
                  
                  // Don't update frontend state on error - maintain data integrity
                  console.log('❌ Frontend state NOT updated due to backend error');
                }
              }}/>
          </div>
        </Tabs>
      </main>

      {/* UX Polish: Vendors Modal with ESC support and focus management */}
      {vendorsOpen && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="vendors-title">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setVendorsOpen(false)}></div>
          <div className="absolute left-1/2 top-12 -translate-x-1/2 w-[min(100%,900px)]">
            <Card className="rounded-2xl shadow-2xl bg-white">
              <CardHeader className="py-4 flex flex-row items-center justify-between">
                <CardTitle id="vendors-title">Vendors</CardTitle>
                <Button size="sm" onClick={() => setVendorsOpen(false)}>Close</Button>
              </CardHeader>
              <CardContent className="max-h-[70vh] overflow-auto">
                <VendorsManager items={vendors} onChange={setVendors} onRefresh={loadVendors} />
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* UX Polish: SKUs Modal refined layout (sticky header/footer, internal scroll, a11y) */}
      {skusOpen && (
        <SKUsModal 
          onClose={() => { setSkusOpen(false); setSkuFormOpen(false); }}
          onToggleAdd={() => setSkuFormOpen(v => !v)}
          addOpen={skuFormOpen}
        >
          <SKUsManager 
            items={skus} 
            onChange={setSkus} 
            openForm={skuFormOpen}
            onToggleForm={() => setSkuFormOpen(v => !v)}
            hideLocalHeader
            onRefresh={loadInventorySummary}
          />
        </SKUsModal>
      )}
    </div>
  );
}
