/**
 * Refactored Receiving Form Component
 * 
 * Layout Decisions:
 * - 12-column responsive grid system with consistent spacing
 * - Mobile-first approach: single column on mobile, multi-column on desktop
 * - Logical tab order: Date → Vendor → SKU → Type (skip) → Quantity → Unit cost → Packing slip → Damaged → Notes → Submit
 * - Type field is read-only and auto-populated from SKU selection
 * - Conditional damage description field appears when "Damaged?" is checked
 * 
 * Accessibility Features:
 * - All inputs have proper labels with htmlFor/id pairs
 * - ARIA attributes for invalid states and descriptions
 * - Focus management for error states
 * - Proper contrast and keyboard navigation
 * 
 * Validation:
 * - Real-time validation with inline error messages
 * - USD currency formatting for unit cost
 * - Character counter for notes field
 * - Form submission only enabled when all required fields are valid
 * 
 * To update SKU→Type mapping:
 * - Modify the getTypeFromSKU function in receiving.utils.ts
 * - The mapping is based on the SKU's type property ('RAW' | 'SELLABLE')
 */

import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Layers, Package, Plus, Minus } from '@/components/ui/icons';
import AdjustmentModal from '@/features/inventory/components/AdjustmentModal';
import {
  UISKUOption as SKU,
  LayerLite as Layer,
  VendorSuggestion as Vendor,
  toVendorId,
} from '@/features/inventory/types/inventory.types';
import { processReceiving, getFIFOLayers, movementOperations, fifoOperations } from '@/features/inventory/services/inventory.adapter';
import { 
  formatUSD, 
  parseUSDInput, 
  getTypeFromSKU, 
  validateQuantity, 
  validateUnitCost, 
  validateVendor, 
  validateSKU,
  getCharacterCount,
  buildPackingSlipSuggestion,
  buildBatchPackingSlipSuggestion
} from '../utils/receiving.utils';

// Zod schema for runtime validation
import { receivePayloadSchema } from '@/features/inventory/types/schemas';
import { telemetry } from '@/features/inventory/services/telemetry';

// Types for Receiving
type DamageScope = 'NONE' | 'PARTIAL' | 'FULL';

// Damage modal state
type DamageModalState = {
  isOpen: boolean;
  lineId: string | null;
  scope: 'FULL' | 'PARTIAL';
  quantity: number;
  notes: string;
};

// Multi-SKU receiving line
type ReceivingLine = {
  id: string;          // UUID for line management
  skuId: string;       // Selected SKU
  qty: number;         // Quantity to receive
  unitCost: number;    // Unit cost for this SKU
  // Damage tracking per line
  isDamaged: boolean;  // Whether this line has damaged items
  damageScope: DamageScope; // Scope of damage: NONE, PARTIAL, or FULL
  damagedQty: number;  // Quantity of damaged items (for PARTIAL)
  damageNotes: string; // Notes specific to damage condition
};

// Shared form fields
type SharedReceivingFields = {
  date: string;
  vendor: string;
  packingSlip: string;
  globalNotes: string;
};

// Batch processing result
type BatchResult = {
  line: ReceivingLine;
  success: boolean;
  error?: string;
};

// Props interface
interface ReceivingProps {
  vendors: Vendor[];
  skus: SKU[];
  layersBySku: Record<string, Layer[]>;
  movements?: Array<{ datetime: string; type: 'RECEIVE' | 'ISSUE' | 'DAMAGE' | 'PRODUCE' | 'ADJUSTMENT'; skuOrName: string; qty: number; value: number; ref: string; notes?: string; generalNotes?: string; damageNotes?: string }>;
  onUpdateLayers?: (skuId: string, newLayers: Layer[]) => void;
  onUpdateSKU?: (skuId: string, updates: Partial<SKU>) => void;
  onAddMovement?: (movement: { datetime: string; type: 'RECEIVE' | 'ISSUE' | 'DAMAGE' | 'PRODUCE' | 'ADJUSTMENT'; skuOrName: string; qty: number; value: number; ref: string; notes?: string; generalNotes?: string; damageNotes?: string }) => void;
  onRefreshMovements?: () => void;
}

// Damage Configuration Modal
function DamageModal({
  isOpen,
  onClose,
  lineId,
  totalQty,
  currentScope,
  currentQty,
  currentNotes,
  onSave
}: {
  isOpen: boolean;
  onClose: () => void;
  lineId: string | null;
  totalQty: number;
  currentScope: 'FULL' | 'PARTIAL';
  currentQty: number;
  currentNotes: string;
  onSave: (scope: 'FULL' | 'PARTIAL', qty: number, notes: string) => void;
}) {
  const [scope, setScope] = useState<'FULL' | 'PARTIAL'>(currentScope);
  const [damagedQty, setDamagedQty] = useState(currentQty);
  const [notes, setNotes] = useState(currentNotes);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Reset modal state when opened
  useEffect(() => {
    if (isOpen) {
      setScope(currentScope);
      setDamagedQty(currentQty);
      setNotes(currentNotes);
      setErrors({});
    }
  }, [isOpen, currentScope, currentQty, currentNotes]);

  const validate = () => {
    const newErrors: Record<string, string> = {};
    
    if (scope === 'PARTIAL') {
      if (damagedQty <= 0) {
        newErrors.quantity = 'Damaged quantity must be greater than 0';
      } else if (damagedQty >= totalQty) {
        newErrors.quantity = 'Damaged quantity must be less than total quantity';
      }
    }
    
    if (notes.length > 500) {
      newErrors.notes = 'Notes cannot exceed 500 characters';
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = () => {
    if (validate()) {
      const finalQty = scope === 'FULL' ? totalQty : damagedQty;
      onSave(scope, finalQty, notes);
      onClose();
    }
  };

  const handleScopeChange = (newScope: 'FULL' | 'PARTIAL') => {
    setScope(newScope);
    if (newScope === 'FULL') {
      setDamagedQty(totalQty);
    } else {
      setDamagedQty(Math.min(currentQty || 1, totalQty - 1));
    }
    setErrors({});
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-slate-900">Configure Damage</h3>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 text-xl leading-none"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div className="space-y-4">
            {/* Scope Selection */}
            <div className="space-y-3">
              <Label className="text-sm font-medium text-slate-700">Damage Scope</Label>
              
              <div className="space-y-2">
                <label className="flex items-center space-x-3 p-3 border rounded-lg cursor-pointer hover:bg-slate-50">
                  <input
                    type="radio"
                    name="damageScope"
                    value="FULL"
                    checked={scope === 'FULL'}
                    onChange={() => handleScopeChange('FULL')}
                    className="text-blue-600"
                  />
                  <div>
                    <div className="font-medium text-sm">Full Batch Damaged</div>
                    <div className="text-xs text-slate-500">All {totalQty} units are damaged</div>
                  </div>
                </label>

                <label className="flex items-center space-x-3 p-3 border rounded-lg cursor-pointer hover:bg-slate-50">
                  <input
                    type="radio"
                    name="damageScope"
                    value="PARTIAL"
                    checked={scope === 'PARTIAL'}
                    onChange={() => handleScopeChange('PARTIAL')}
                    className="text-blue-600"
                  />
                  <div>
                    <div className="font-medium text-sm">Partial Damage</div>
                    <div className="text-xs text-slate-500">Some units are damaged, others are good</div>
                  </div>
                </label>
              </div>
            </div>

            {/* Quantity Input (only for PARTIAL) */}
            {scope === 'PARTIAL' && (
              <div className="space-y-2">
                <Label htmlFor="damaged-qty" className="text-sm font-medium text-slate-700">
                  Damaged Quantity
                </Label>
                <Input
                  id="damaged-qty"
                  type="number"
                  min="1"
                  max={totalQty - 1}
                  value={damagedQty || ''}
                  onChange={(e) => {
                    const val = parseInt(e.target.value) || 0;
                    setDamagedQty(val);
                    setErrors(prev => ({ ...prev, quantity: '' }));
                  }}
                  className={errors.quantity ? 'border-red-500' : ''}
                  placeholder="Enter damaged quantity"
                />
                {errors.quantity && (
                  <div className="text-xs text-red-600">{errors.quantity}</div>
                )}
                <div className="text-xs text-slate-500">
                  Received: {scope === 'PARTIAL' ? totalQty - damagedQty : 0} units | 
                  Damage: {scope === 'PARTIAL' ? damagedQty : totalQty} units
                </div>
              </div>
            )}

            {scope === 'FULL' && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <div className="text-sm text-amber-800">
                  <strong>Full Loss:</strong> All {totalQty} units will be marked as damage.
                  No inventory will be received for this item.
                </div>
              </div>
            )}

            {/* Notes Field */}
            <div className="space-y-2">
              <Label htmlFor="damage-notes" className="text-sm font-medium text-slate-700">
                Damage Notes <span className="text-slate-400">(Optional)</span>
              </Label>
              <Textarea
                id="damage-notes"
                value={notes}
                onChange={(e) => {
                  setNotes(e.target.value);
                  setErrors(prev => ({ ...prev, notes: '' }));
                }}
                placeholder="Describe the damage condition..."
                className={`min-h-[80px] ${errors.notes ? 'border-red-500' : ''}`}
                maxLength={500}
              />
              {errors.notes && (
                <div className="text-xs text-red-600">{errors.notes}</div>
              )}
              <div className="text-xs text-slate-500 text-right">
                {notes.length}/500 characters
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3 mt-6 pt-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              className="flex-1 bg-blue-600 text-white hover:bg-blue-700"
            >
              Save Changes
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// Simple vendor select with search capability
function VendorSelect({ 
  value, 
  onChange, 
  suggestions, 
  error, 
  id 
}: { 
  value: string; 
  onChange: (v: string) => void; 
  suggestions: Vendor[];
  error?: string;
  id: string;
}) {
  // Allow custom input as well as selection from list
  const [isCustom, setIsCustom] = useState(false);
  const [customValue, setCustomValue] = useState('');

  // Check if current value is in suggestions
  const isValueInSuggestions = suggestions.some(v => v.name === value);
  
  useEffect(() => {
    if (!isValueInSuggestions && value) {
      setIsCustom(true);
      setCustomValue(value);
    }
  }, [value, isValueInSuggestions]);

  if (isCustom) {
    return (
      <div className="flex items-stretch gap-2 h-10">
        <Input 
          id={id}
          value={customValue}
          onChange={(e) => {
            setCustomValue(e.target.value);
            onChange(e.target.value);
          }}
          placeholder="Enter vendor name..."
          className={`flex-1 h-10 ${error ? 'border-red-500 focus:ring-red-500' : ''}`}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setIsCustom(false);
            setCustomValue('');
            onChange('');
          }}
          className="h-10 w-10 px-0 flex items-center justify-center shrink-0"
          title="Select from list"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-stretch gap-2 h-10">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger 
          id={id}
          className={`flex-1 h-10 ${error ? 'border-red-500 focus:ring-red-500' : ''}`}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
        >
          <SelectValue placeholder="Select vendor..." />
        </SelectTrigger>
        <SelectContent className="max-h-64">
          {suggestions.map(v => (
            <SelectItem key={v.name} value={v.name}>
              <span className="font-medium">{v.name}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setIsCustom(true);
          setCustomValue(value);
        }}
        className="h-10 w-10 px-0 flex items-center justify-center shrink-0 hover:bg-green-50 hover:border-green-300"
        title="Add new vendor"
      >
        <svg className="h-4 w-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      </Button>
    </div>
  );
}

// SKU select component with validation and accessibility
function SKUSelect({ 
  skus, 
  value, 
  onChange, 
  placeholder, 
  error, 
  id 
}: { 
  skus: SKU[]; 
  value: string; 
  onChange: (v: string) => void; 
  placeholder?: string;
  error?: string;
  id: string;
}) {
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
        {skus.map(s => (
          <SelectItem key={s.id} value={s.id}>{s.id} — {s.description}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Alert triangle icon (simple SVG)
function AlertTriangle({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 18.5c-.77.833.192 2.5 1.732 2.5z" />
    </svg>
  );
}

// Error message component
function ErrorMessage({ message, id }: { message: string; id: string }) {
  return (
    <div id={id} className="flex items-center gap-1 text-sm text-red-600 mt-1">
      <AlertTriangle className="h-4 w-4" />
      <span>{message}</span>
    </div>
  );
}

// Currency input component
function CurrencyInput({ 
  value, 
  onChange, 
  error, 
  id, 
  placeholder = "$0.00" 
}: {
  value: number;
  onChange: (value: number) => void;
  error?: string;
  id: string;
  placeholder?: string;
}) {
  const [displayValue, setDisplayValue] = useState('');
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    // Only format when not focused and has a value
    if (!isFocused && value > 0) {
      setDisplayValue(formatUSD(value));
    } else if (!isFocused && value === 0) {
      setDisplayValue('');
    }
  }, [value, isFocused]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target.value;
    setDisplayValue(input);
    
    // Parse the input and update the value
    const parsed = parseUSDInput(input);
    onChange(parsed);
  };

  const handleFocus = () => {
    setIsFocused(true);
    // Show raw numeric value when focused for easier editing
    if (value > 0) {
      setDisplayValue(value.toString());
    }
  };

  const handleBlur = () => {
    setIsFocused(false);
    // Format the value when user finishes editing
    if (value > 0) {
      setDisplayValue(formatUSD(value));
    } else {
      setDisplayValue('');
    }
  };

  return (
    <Input
      id={id}
      type="text"
      value={displayValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      placeholder={placeholder}
      className={`h-9 w-full ${error ? 'border-red-500 focus:ring-red-500' : ''}`}
      aria-invalid={!!error}
      aria-describedby={error ? `${id}-error` : undefined}
    />
  );
}

// Package icon (simple SVG)
function Package({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
    </svg>
  );
}

// Section card wrapper
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

// Icons for multi-SKU functionality
function Plus({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function Trash({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  );
}

// SKU select for multi-line (enhanced version)
function MultiSKUSelect({ 
  skus, 
  value, 
  onChange, 
  error,
  id,
  usedSkus = [] 
}: { 
  skus: SKU[]; 
  value: string; 
  onChange: (value: string) => void;
  error?: string;
  id?: string;
  usedSkus?: string[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger 
        id={id}
        className={`h-10 w-full ${error ? 'border-red-500 focus:ring-red-500' : ''}`}
        aria-invalid={!!error}
      >
        <SelectValue placeholder="Select SKU" />
      </SelectTrigger>
      <SelectContent>
        {skus.map(sku => {
          const isUsed = usedSkus.includes(sku.id);
          return (
            <SelectItem 
              key={sku.id} 
              value={sku.id}
              disabled={isUsed}
            >
              <div className="flex items-center gap-2">
                <span className={isUsed ? 'text-slate-400' : ''}>{sku.id} — {sku.description}</span>
                {isUsed && <span className="text-xs text-orange-500">(Already used)</span>}
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

export default function Receiving({ vendors, skus, layersBySku, movements, onUpdateLayers, onUpdateSKU, onAddMovement, onRefreshMovements }: ReceivingProps) {
  const [selectedLayersSku, setSelectedLayersSku] = useState<string>('');
  const [activeLayers, setActiveLayers] = useState<Layer[]>([]);
  const [isLoadingLayers, setIsLoadingLayers] = useState<boolean>(false);
  const [showAllLayers, setShowAllLayers] = useState<boolean>(false);

  // Adjustment modal state
  const [adjustmentModal, setAdjustmentModal] = useState<{
    isOpen: boolean;
    layer: Layer | null;
    skuId: string;
  }>({
    isOpen: false,
    layer: null,
    skuId: '',
  });

  useEffect(() => {
    if (!selectedLayersSku) {
      setActiveLayers([]);
      return;
    }

    const fetchLayers = async () => {
      setIsLoadingLayers(true);
      try {
        const layers = await getFIFOLayers(selectedLayersSku);
        setActiveLayers(layers || []);
      } catch (error) {
        console.error("Failed to fetch FIFO layers:", error);
        setActiveLayers([]);
      } finally {
        setIsLoadingLayers(false);
      }
    };

    fetchLayers();
  }, [selectedLayersSku]);

  // Multi-SKU receiving lines
  const [receivingLines, setReceivingLines] = useState<ReceivingLine[]>([
    { 
      id: '1', 
      skuId: '', 
      qty: 0, 
      unitCost: 0, 
      isDamaged: false,
      damageScope: 'NONE',
      damagedQty: 0,
      damageNotes: ''
    }
  ]);
  
  // Shared form fields
  const [sharedFields, setSharedFields] = useState<SharedReceivingFields>({
    date: new Date().toISOString().split('T')[0],
    vendor: '',
    packingSlip: '',
    globalNotes: ''
  });

  // Damage modal state
  const [damageModal, setDamageModal] = useState<DamageModalState>({
    isOpen: false,
    lineId: null,
    scope: 'PARTIAL',
    quantity: 0,
    notes: ''
  });

  // Legacy single-field state for compatibility (to be removed gradually)
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [vendorValue, setVendorValue] = useState('');
  const [receivingSku, setReceivingSku] = useState('');
  const [receivingQty, setReceivingQty] = useState<number>(0);
  const [unitCost, setUnitCost] = useState<number>(0);
  const [packingSlip, setPackingSlip] = useState('');
  const [isDamaged, setIsDamaged] = useState(false);
  const [damageDescription, setDamageDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [packingSlipEdited, setPackingSlipEdited] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Ref for modal container (focus management)
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Non-blocking notifications (toast + aria-live)
  type Notice = { id: string; message: string; kind?: 'info' | 'success' | 'error' };
  const [notices, setNotices] = useState<Notice[]>([]);
  const notify = (message: string, kind: Notice['kind'] = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setNotices((prev) => [...prev, { id, message, kind }]);
    // auto-dismiss after 4s
    window.setTimeout(() => {
      setNotices((prev) => prev.filter((n) => n.id !== id));
    }, 4000);
  };

  // Multi-SKU line management functions
  const addReceivingLine = useCallback(() => {
    const newId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setReceivingLines(prev => [...prev, { 
      id: newId, 
      skuId: '', 
      qty: 0, 
      unitCost: 0, 
      isDamaged: false,
      damageScope: 'NONE',
      damagedQty: 0,
      damageNotes: ''
    }]);
  }, []);

  const removeReceivingLine = useCallback((id: string) => {
    if (receivingLines.length > 1) {
      setReceivingLines(prev => prev.filter(line => line.id !== id));
    }
  }, [receivingLines.length]);

  const updateReceivingLine = useCallback((id: string, updates: Partial<ReceivingLine>) => {
    setReceivingLines(prev => prev.map(line => line.id === id ? { ...line, ...updates } : line));
  }, []);

  // Damage modal functions
  const openDamageModal = useCallback((lineId: string) => {
    const line = receivingLines.find(l => l.id === lineId);
    if (!line || line.qty <= 0) return;
    
    setDamageModal({
      isOpen: true,
      lineId,
      scope: line.damageScope === 'NONE' ? 'PARTIAL' : (line.damageScope as 'FULL' | 'PARTIAL'),
      quantity: line.damagedQty || Math.min(1, line.qty),
      notes: line.damageNotes || ''
    });
  }, [receivingLines]);

  const closeDamageModal = useCallback(() => {
    setDamageModal({
      isOpen: false,
      lineId: null,
      scope: 'PARTIAL',
      quantity: 0,
      notes: ''
    });
  }, []);

  const saveDamageConfig = useCallback((scope: 'FULL' | 'PARTIAL', qty: number, notes: string) => {
    if (!damageModal.lineId) return;
    
    updateReceivingLine(damageModal.lineId, {
      isDamaged: true,
      damageScope: scope,
      damagedQty: qty,
      damageNotes: notes
    });
  }, [damageModal.lineId, updateReceivingLine]);

  const clearDamageConfig = useCallback((lineId: string) => {
    updateReceivingLine(lineId, {
      isDamaged: false,
      damageScope: 'NONE',
      damagedQty: 0,
      damageNotes: ''
    });
  }, [updateReceivingLine]);

  // Calculate effective quantities (what actually goes to inventory vs damage)
  const getEffectiveQuantities = useCallback((line: ReceivingLine) => {
    if (!line.isDamaged || line.damageScope === 'NONE') {
      return { receiveQty: line.qty, damageQty: 0 };
    }
    if (line.damageScope === 'FULL') {
      return { receiveQty: 0, damageQty: line.qty };
    }
    // PARTIAL
    const damageQty = Math.min(line.damagedQty, line.qty);
    const receiveQty = Math.max(0, line.qty - damageQty);
    return { receiveQty, damageQty };
  }, []);

  const updateSharedField = useCallback(<K extends keyof SharedReceivingFields>(
    field: K, 
    value: SharedReceivingFields[K]
  ) => {
    setSharedFields(prev => ({ ...prev, [field]: value }));
  }, []);

  // Batch processing state
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [showBatchResults, setShowBatchResults] = useState(false);

  // Validate all receiving lines
  const validateAllLines = useCallback((): Record<string, string> => {
    const errors: Record<string, string> = {};
    
    // Validate shared fields
    if (!sharedFields.vendor.trim()) errors.vendor = 'Vendor is required';
    if (!sharedFields.date) errors.date = 'Date is required';
    
    // Validate receiving lines
    receivingLines.forEach((line, index) => {
      if (!line.skuId) errors[`line-${line.id}-sku`] = 'SKU is required';
      if (line.qty <= 0) errors[`line-${line.id}-qty`] = 'Quantity must be greater than 0';
      if (line.unitCost <= 0) errors[`line-${line.id}-cost`] = 'Unit cost must be greater than 0';
      
      // Validate damage configuration
      if (line.isDamaged) {
        if (line.damageScope === 'PARTIAL') {
          if (line.damagedQty <= 0) {
            errors[`line-${line.id}-damage-qty`] = 'Damaged quantity must be greater than 0';
          } else if (line.damagedQty >= line.qty) {
            errors[`line-${line.id}-damage-qty`] = 'Damaged quantity must be less than total quantity';
          }
        }
        if (line.damageNotes && line.damageNotes.length > 500) {
          errors[`line-${line.id}-damage-notes`] = 'Damage notes cannot exceed 500 characters';
        }
      }
    });
    
    // Check for duplicate SKUs
    const skuCounts = receivingLines.reduce((acc, line) => {
      if (line.skuId) {
        acc[line.skuId] = (acc[line.skuId] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>);
    
    Object.entries(skuCounts).forEach(([skuId, count]) => {
      if (count > 1) {
        receivingLines.forEach(line => {
          if (line.skuId === skuId) {
            errors[`line-${line.id}-duplicate`] = 'Duplicate SKU detected';
          }
        });
      }
    });
    
    return errors;
  }, [receivingLines, sharedFields]);

  // Process all receiving lines in batch
  const processAllReceivings = useCallback(async () => {
    const errors = validateAllLines();
    if (Object.keys(errors).length > 0) {
      notify('Please fix validation errors before processing', 'error');
      return;
    }

    setBatchProcessing(true);
    setBatchResults([]);
    const results: BatchResult[] = [];

    try {
      for (const line of receivingLines) {
        try {
          const { receiveQty, damageQty } = getEffectiveQuantities(line);
          
          // Process RECEIVE movement (only if there's quantity to receive)
          if (receiveQty > 0) {
            await processReceiving({
              skuId: line.skuId,
              quantity: receiveQty,
              unitCost: line.unitCost,
              date: new Date(sharedFields.date),
              vendorName: sharedFields.vendor,
              packingSlipNo: sharedFields.packingSlip || undefined,
              notes: sharedFields.globalNotes?.trim() || undefined
            });
          }
          
          // Process DAMAGE movement (only if there's damaged quantity)
          if (damageQty > 0) {
            const damageRef = `${sharedFields.packingSlip || `BATCH-${Date.now()}`}-DAMAGED`;
            
            await movementOperations.createDamageMovement({
              skuId: line.skuId,
              quantity: damageQty,
              unitCost: line.unitCost,
              date: new Date(sharedFields.date),
              reference: damageRef,
              notes: line.damageNotes || undefined,
              generalNotes: sharedFields.globalNotes?.trim() || undefined,
              damageNotes: line.damageNotes || undefined
            });
            
            // Also add to UI optimistically
            onAddMovement?.({
              datetime: new Date().toISOString().replace('T', ' ').substring(0, 16),
              type: 'DAMAGE',
              skuOrName: line.skuId,
              qty: -damageQty,
              value: -(damageQty * line.unitCost),
              ref: damageRef,
              notes: line.damageNotes || undefined,
              generalNotes: sharedFields.globalNotes?.trim() || undefined,
              damageNotes: line.damageNotes || undefined
            });
          }
          
          results.push({ line, success: true });
          const statusText = receiveQty > 0 && damageQty > 0 
            ? `received ${receiveQty}, damaged ${damageQty}`
            : receiveQty > 0 
            ? `received ${receiveQty}` 
            : `damaged ${damageQty}`;
          notify(`✓ ${line.skuId} ${statusText}`, 'success');
        } catch (error: any) {
          results.push({ 
            line, 
            success: false, 
            error: error.message || 'Processing failed' 
          });
          notify(`✗ ${line.skuId} failed: ${error.message}`, 'error');
        }
      }

      setBatchResults(results);
      setShowBatchResults(true);

      const successCount = results.filter(r => r.success).length;
      const totalCount = results.length;
      
      if (successCount === totalCount) {
        notify(`All ${totalCount} items processed successfully!`, 'success');
        // Reset form on complete success
        setReceivingLines([{ 
          id: '1', 
          skuId: '', 
          qty: 0, 
          unitCost: 0, 
          isDamaged: false,
          damageScope: 'NONE',
          damagedQty: 0,
          damageNotes: ''
        }]);
        setSharedFields(prev => ({ ...prev, globalNotes: '', packingSlip: '' }));
      } else {
        notify(`${successCount}/${totalCount} items processed successfully`, 'info');
      }

      // Refresh inventory and movements to get real data from database
      if (onUpdateLayers || onUpdateSKU) {
        // Trigger refresh (implementation depends on parent component)
      }
      
      // Refresh movements to show real data with notes in tooltips
      if (onRefreshMovements) {
        onRefreshMovements();
      }
      
    } finally {
      setBatchProcessing(false);
    }
  }, [receivingLines, sharedFields, validateAllLines, notify, onUpdateLayers, onUpdateSKU]);

  // Focus management and keyboard handling for the confirmation modal
  useEffect(() => {
    if (!confirmOpen) return;
    // Initial focus: prefer element marked as initial, else first focusable
    const container = dialogRef.current;
    const prefer = container?.querySelector<HTMLElement>('[data-modal-initial="true"]');
    const fallback = container?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    (prefer || fallback)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (!confirmOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        setConfirmOpen(false);
        return;
      }
      if (e.key === 'Tab') {
        const container = dialogRef.current;
        if (!container) return;
        const focusables = Array.from(
          container.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        ).filter((el) => !el.hasAttribute('disabled'));
        if (!focusables.length) return;
        const active = document.activeElement as HTMLElement | null;
        let idx = active ? focusables.indexOf(active) : -1;
        e.preventDefault();
        if (e.shiftKey) idx = (idx - 1 + focusables.length) % focusables.length;
        else idx = (idx + 1) % focusables.length;
        focusables[idx]?.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [confirmOpen]);

  // Legacy damage scope states (keeping for compatibility)
  const [damageScope, setDamageScope] = useState<DamageScope>('NONE');
  const [rejectedQty, setRejectedQty] = useState<number>(0);

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({});

  const selectedSku = skus.find(s => s.id === receivingSku);
  
  // Real-time validation for Multi-SKU form
  useEffect(() => {
    const newErrors = validateAllLines();
    setErrors(newErrors);
  }, [validateAllLines]);

  // Clamp rejectedQty whenever qty changes (legacy compatibility)
  useEffect(() => {
    setRejectedQty((r) => {
      const qty = Math.max(0, receivingQty || 0);
      const rr = Math.max(0, Math.min(r || 0, qty));
      return rr;
    });
  }, [receivingQty]);

  // Auto-suggest Multi-SKU Batch Packing Slip when user hasn't manually edited it
  useEffect(() => {
    if (packingSlipEdited) return;
    
    // Only suggest if we have vendor and date
    if (!sharedFields.vendor.trim() || !sharedFields.date) {
      return;
    }
    
    // Check if we have at least one valid receiving line
    const hasValidLines = receivingLines.some(line => line.skuId && line.qty > 0);
    if (!hasValidLines) {
      return;
    }
    
    const existingRefs = (movements || []).map(m => m.ref).filter(Boolean);
    const suggestion = buildBatchPackingSlipSuggestion({
      vendorName: sharedFields.vendor,
      date: sharedFields.date,
      existingRefs,
    });
    
    if (suggestion && suggestion !== sharedFields.packingSlip) {
      setSharedFields(prev => ({ ...prev, packingSlip: suggestion }));
    }
  }, [sharedFields.vendor, sharedFields.date, receivingLines, movements, packingSlipEdited]);

  // Character count for notes
  const notesCharCount = useMemo(() => getCharacterCount(notes), [notes]);

  // Form validation
  const isFormValid = useMemo(() => {
    return Object.keys(errors).length === 0 && 
           vendorValue.trim().length >= 3 && 
           receivingSku && 
           receivingQty > 0 && 
           unitCost > 0;
  }, [errors, vendorValue, receivingSku, receivingQty, unitCost]);

  // Recent RECEIVE movements for display
  const recentReceives = useMemo(() => {
    if (!movements) return [];
    return movements
      .filter(m => m.type === 'RECEIVE')
      .sort((a, b) => new Date(b.datetime).getTime() - new Date(a.datetime).getTime())
      .slice(0, 3);
  }, [movements]);

  // Adjustment modal functions
  const openAdjustmentModal = useCallback((layer: Layer, skuId: string) => {
    setAdjustmentModal({
      isOpen: true,
      layer,
      skuId,
    });
  }, []);

  const closeAdjustmentModal = useCallback(() => {
    setAdjustmentModal({
      isOpen: false,
      layer: null,
      skuId: '',
    });
  }, []);

  const handleAdjustmentConfirm = useCallback(async (params: {
    layerId: string;
    quantity: number;
    reason: string;
    notes?: string;
    reference?: string;
  }) => {
    try {
      // Create adjustment movement
      await movementOperations.createAdjustmentMovement({
        skuId: selectedLayersSku,
        layerId: params.layerId,
        quantity: params.quantity,
        date: new Date(),
        reference: params.reference,
        reason: params.reason,
        notes: params.notes,
        adjustedBy: 'current_user', // TODO: Get from auth context
      });

      // Refresh layers to show updated quantities
      const updatedLayers = await getFIFOLayers(selectedLayersSku);
      setActiveLayers(updatedLayers || []);

      // Refresh movements if callback provided
      if (onRefreshMovements) {
        onRefreshMovements();
      }

      // Show success notification
      const adjustmentType = params.quantity > 0 ? 'increased' : 'decreased';
      const absQuantity = Math.abs(params.quantity);
      notify(`✓ Layer ${params.layerId} ${adjustmentType} by ${absQuantity} units`, 'success');

    } catch (error: any) {
      console.error('Error creating adjustment:', error);
      notify(`✗ Adjustment failed: ${error.message}`, 'error');
      throw error; // Re-throw so modal can handle error state
    }
  }, [selectedLayersSku, onRefreshMovements, notify]);

  // Focus management for errors
  const focusFirstError = () => {
    const errorFields = ['date', 'vendor', 'sku', 'quantity', 'unitCost'];
    for (const field of errorFields) {
      if (errors[field]) {
        const element = document.getElementById(field);
        element?.focus();
        break;
      }
    }
  };

  // Derive outcome quantities based on damage flags
  const outcome = useMemo(() => {
    const qty = Math.max(0, receivingQty || 0);
    if (!isDamaged || damageScope === 'NONE') {
      return { acceptQty: qty, damageQty: 0 };
    }
    if (damageScope === 'FULL') {
      return { acceptQty: 0, damageQty: qty };
    }
    // PARTIAL
    const rej = Math.max(0, Math.min(rejectedQty || 0, qty));
    return { acceptQty: Math.max(0, qty - rej), damageQty: rej };
  }, [isDamaged, damageScope, receivingQty, rejectedQty]);

  // API mutation for receiving
  const [isPending, setIsPending] = useState(false);

  // Actual submission logic (called after user confirms)
  const performApprove = async () => {
    if (!isFormValid) {
      focusFirstError();
      return;
    }
    const ref = packingSlip || `PS-${Date.now()}`;
    const { acceptQty, damageQty } = outcome;
    telemetry.event('receiving_submit_attempt', {
      sku: receivingSku,
      qty: acceptQty,
      unitCost,
      vendor: vendorValue,
      isDamaged,
      damageScope,
      ref,
    });
    // FULL damage: only DAMAGE, no RECEIVE
    if (isDamaged && damageScope === 'FULL') {
      onAddMovement?.({
        datetime: new Date().toISOString().replace('T', ' ').substring(0, 16),
        type: 'DAMAGE',
        skuOrName: receivingSku,
        qty: -damageQty,
        value: -(damageQty * unitCost),
        ref: `${ref}-FULL-REJECT`
      });

      notify(`Packing slip fully rejected. ${damageQty} units registered as damage.`, 'info');
      // Reset form
      setReceivingSku('');
      setReceivingQty(0);
      setUnitCost(0);
      setPackingSlip('');
      setIsDamaged(false);
      setDamageScope('NONE');
      setRejectedQty(0);
      setNotes('');
      setConfirmOpen(false);
      return;
    }

    if (acceptQty <= 0) {
      notify('No quantity to accept (all rejected)', 'error');
      setConfirmOpen(false);
      return;
    }

    // Zod validation: build ReceivePayload and validate
    let payload: any;
    try {
      const vendorId = toVendorId(vendorValue);
      const unit = selectedSku?.unit || '';
      payload = {
        vendorId,
        invoice: ref,
        datetime: new Date(`${date}T00:00:00Z`).toISOString(),
        lines: [
          { sku: receivingSku, unit, qty: acceptQty, unitCost }
        ],
        notes: notes?.trim() || undefined,
        isDamaged,
        damageScope,
        rejectedQty: isDamaged ? rejectedQty : undefined,
      };
      receivePayloadSchema.parse(payload);
    } catch (err: any) {
      // Map Zod issues to our UI error fields
      const issues = err?.issues as Array<{ path: (string | number)[]; message: string }> | undefined;
      const mapped: Record<string, string> = {};
      if (issues && Array.isArray(issues)) {
        for (const i of issues) {
          const key = i.path.join('.');
          if (key.startsWith('lines.0.qty')) mapped.quantity = i.message;
          else if (key.startsWith('lines.0.unitCost')) mapped.unitCost = i.message;
          else if (key.startsWith('lines.0.sku')) mapped.sku = i.message;
          else if (key === 'vendorId') mapped.vendor = i.message;
          else if (key === 'datetime') mapped.date = i.message;
        }
      }
      if (Object.keys(mapped).length > 0) setErrors(mapped);
      const message = issues?.[0]?.message || 'Invalid receiving data. Please review the form.';
      notify(message, 'error');
      focusFirstError();
      setConfirmOpen(false);
      return;
    }

    // Create new FIFO layer for accepted qty
    const newLayerId = `${receivingSku}-L${Date.now()}`;
    const newLayer: Layer = {
      id: newLayerId,
      date: new Date().toISOString().split('T')[0],
      remaining: acceptQty,
      cost: unitCost
    };

    try {
      setIsPending(true);
      await processReceiving({
        skuId: receivingSku,
        quantity: acceptQty,
        unitCost,
        date: new Date(date),
        vendorName: vendorValue,
        packingSlipNo: ref,
        notes: notes?.trim() || undefined,
      });

      // Local optimistic updates
      const currentLayers = layersBySku[receivingSku] || [];
      const updatedLayers = [...currentLayers, newLayer];
      onUpdateLayers?.(receivingSku, updatedLayers);

      const currentOnHand = selectedSku?.onHand || 0;
      onUpdateSKU?.(receivingSku, { onHand: currentOnHand + acceptQty });

      onAddMovement?.({
        datetime: new Date().toISOString().replace('T', ' ').substring(0, 16),
        type: 'RECEIVE',
        skuOrName: receivingSku,
        qty: acceptQty,
        value: acceptQty * unitCost,
        ref,
        notes: notes?.trim() || undefined,
        generalNotes: notes?.trim() || undefined
      });

      if (isDamaged && damageScope === 'PARTIAL' && damageQty > 0) {
        const damageRef = `${ref}-DAMAGED`;
        
        // Create real DAMAGE movement in database
        await movementOperations.createDamageMovement({
          skuId: receivingSku,
          quantity: damageQty,
          unitCost: unitCost,
          date: new Date(date),
          reference: damageRef,
          notes: notes?.trim() || undefined,
          generalNotes: notes?.trim() || undefined,
          damageNotes: damageDescription?.trim() || undefined
        });
        
        // Also add to UI optimistically
        onAddMovement?.({
          datetime: new Date().toISOString().replace('T', ' ').substring(0, 16),
          type: 'DAMAGE',
          skuOrName: receivingSku,
          qty: -damageQty,
          value: -(damageQty * unitCost),
          ref: damageRef,
          notes: notes?.trim() || undefined,
          generalNotes: notes?.trim() || undefined,
          damageNotes: damageDescription?.trim() || undefined
        });
        
        // Refresh movements to get real data with notes
        if (onRefreshMovements) {
          onRefreshMovements();
        }
      }

      notify(`Successfully approved! ${acceptQty} units added to inventory.`, 'success');
      telemetry.event('receiving_submit_success', {
        sku: receivingSku,
        acceptQty,
        damageQty,
        unitCost,
        ref,
      });

      // Reset form
      setDate(new Date().toISOString().split('T')[0]);
      setVendorValue('');
      setReceivingSku('');
      setReceivingQty(0);
      setUnitCost(0);
      setPackingSlip('');
      setIsDamaged(false);
      setDamageDescription('');
      setDamageScope('NONE');
      setRejectedQty(0);
      setNotes('');
      setErrors({});
      setConfirmOpen(false);
    } catch (e: any) {
      const message = e?.message || 'Failed to submit receiving. Please try again.';
      notify(message, 'error');
      telemetry.error('receiving_submit_failed', e, {
        sku: receivingSku,
        acceptQty,
        unitCost,
        ref,
      });
      setConfirmOpen(false);
      return;
    } finally {
      setIsPending(false);
    }
  };

  // Open confirmation dialog first
  const handleApprove = async () => {
    if (!isFormValid) {
      focusFirstError();
      return;
    }
    setConfirmOpen(true);
  };

  // DAM-01: Full rejection handler
  const handleRejectAll = async () => {
    if (!receivingSku || receivingQty <= 0) {
      notify('Please fill in SKU and quantity first', 'error');
      return;
    }

    telemetry.event('receiving_full_reject', {
      sku: receivingSku,
      qty: receivingQty,
      unitCost,
      ref: `${packingSlip || `PS-${Date.now()}`}-FULL-REJECT`,
    });
    const rejectRef = `${packingSlip || `PS-${Date.now()}`}-FULL-REJECT`;
    
    // Create real DAMAGE movement in database
    try {
      await movementOperations.createDamageMovement({
        skuId: receivingSku,
        quantity: receivingQty,
        unitCost: unitCost || 0,
        date: new Date(),
        reference: rejectRef,
        notes: notes?.trim() || undefined,
        generalNotes: notes?.trim() || undefined,
        damageNotes: 'Full rejection - entire packing slip rejected'
      });
      
      // Also add to UI optimistically
      onAddMovement?.({
        datetime: new Date().toISOString().replace('T', ' ').substring(0, 16),
        type: 'DAMAGE',
        skuOrName: receivingSku,
        qty: -receivingQty,
        value: -(receivingQty * (unitCost || 0)),
        ref: rejectRef,
        notes: notes?.trim() || undefined,
        generalNotes: notes?.trim() || undefined,
        damageNotes: 'Full rejection - entire packing slip rejected'
      });
      
      // Refresh movements to get real data with notes
      if (onRefreshMovements) {
        onRefreshMovements();
      }
    } catch (error: any) {
      notify(`Failed to create damage movement: ${error.message}`, 'error');
      return;
    }

    notify(`Entire packing slip rejected! ${receivingQty} units marked as damage.`, 'info');
    
    // Reset form
    setDate(new Date().toISOString().split('T')[0]);
    setVendorValue('');
    setReceivingSku('');
    setReceivingQty(0);
    setUnitCost(0);
    setPackingSlip('');
    setIsDamaged(false);
    setDamageScope('NONE');
    setRejectedQty(0);
    setNotes('');
    setErrors({});
  };

  // NAV-33: Return to vendor handler (only when isDamaged && damageScope === 'FULL')
  const handleReturnToVendor = async () => {
    if (!receivingSku || receivingQty <= 0) {
      notify('Please fill in SKU and quantity first', 'error');
      return;
    }
    if (!vendorValue.trim()) {
      notify('Please select a vendor first', 'error');
      return;
    }

    const ref = packingSlip || `PS-${Date.now()}`;
    telemetry.event('receiving_return_to_vendor', {
      sku: receivingSku,
      qty: receivingQty,
      unitCost,
      vendor: vendorValue,
      ref,
    });
    
    const returnRef = `${ref}-RETURN-TO-VENDOR`;
    
    // Create real DAMAGE movement in database
    try {
      await movementOperations.createDamageMovement({
        skuId: receivingSku,
        quantity: receivingQty,
        unitCost: unitCost || 0,
        date: new Date(),
        reference: returnRef,
        notes: notes?.trim() || undefined,
        generalNotes: notes?.trim() || undefined,
        damageNotes: `Returned to vendor: ${vendorValue}`
      });
      
      // Also add to UI optimistically
      onAddMovement?.({
        datetime: new Date().toISOString().replace('T', ' ').substring(0, 16),
        type: 'DAMAGE',
        skuOrName: receivingSku,
        qty: -receivingQty,
        value: -(receivingQty * (unitCost || 0)),
        ref: returnRef,
        notes: notes?.trim() || undefined,
        generalNotes: notes?.trim() || undefined,
        damageNotes: `Returned to vendor: ${vendorValue}`
      });
      
      // Refresh movements to get real data with notes
      if (onRefreshMovements) {
        onRefreshMovements();
      }
    } catch (error: any) {
      notify(`Failed to create damage movement: ${error.message}`, 'error');
      return;
    }

    notify(`${receivingQty} units of ${receivingSku} returned to vendor: ${vendorValue}`, 'info');
    
    // Reset form
    setDate(new Date().toISOString().split('T')[0]);
    setVendorValue('');
    setReceivingSku('');
    setReceivingQty(0);
    setUnitCost(0);
    setPackingSlip('');
    setIsDamaged(false);
    setDamageDescription('');
    setDamageScope('NONE');
    setRejectedQty(0);
    setNotes('');
    setErrors({});
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Screen reader announcements (non-blocking). Only announce the latest message. */}
      <div className="sr-only" aria-live="polite">
        {notices.slice(-1).map((n) => (
          <span key={n.id}>{n.message}</span>
        ))}
      </div>

      {/* Visual toast stack */}
      {notices.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[60] space-y-2">
          {notices.map((n) => (
            <div
              key={n.id}
              role="status"
              className={`rounded-lg shadow-lg px-3 py-2 text-sm ring-1 ${
                n.kind === 'error'
                  ? 'bg-red-600 text-white ring-red-700'
                  : n.kind === 'success'
                  ? 'bg-emerald-600 text-white ring-emerald-700'
                  : 'bg-slate-800 text-white ring-slate-900'
              }`}
            >
              {n.message}
            </div>
          ))}
        </div>
      )}
      {/* Multi-SKU Receiving Form */}
      <Card className="max-w-7xl mx-auto">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5 text-slate-500" />
            Multi-SKU Receiving Form
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6 space-y-6">
          {/* Shared Fields */}
          <div className="bg-slate-50 rounded-lg p-6">
            <h3 className="text-sm font-semibold text-slate-900 mb-4">Batch Information</h3>
            
            {/* Desktop: Grid layout, Mobile: Stacked */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
              {/* Date Field - Short width */}
              <div className="md:col-span-3">
                <Label htmlFor="shared-date" className="text-sm font-medium text-slate-700 block mb-2">Date</Label>
                <Input 
                  id="shared-date"
                  type="date" 
                  value={sharedFields.date}
                  onChange={(e) => setSharedFields(prev => ({ ...prev, date: e.target.value }))}
                  className="h-10 w-full"
                />
                {/* Fixed error space to prevent layout shift */}
                <div className="h-5 mt-1"></div>
              </div>
              
              {/* Vendor Field - Medium width with integrated button */}
              <div className="md:col-span-5">
                <Label htmlFor="shared-vendor" className="text-sm font-medium text-slate-700 block mb-2">Vendor *</Label>
                <VendorSelect 
                  id="shared-vendor"
                  value={sharedFields.vendor} 
                  onChange={(value) => setSharedFields(prev => ({ ...prev, vendor: value }))}
                  suggestions={vendors}
                  error={errors.vendor}
                />
                {/* Fixed error space to prevent layout shift */}
                <div className="h-5 mt-1">
                  {errors.vendor && <span className="text-xs text-red-600">{errors.vendor}</span>}
                </div>
              </div>

              {/* Packing Slip Field - Remaining space */}
              <div className="md:col-span-4">
                <Label htmlFor="shared-packing-slip" className="text-sm font-medium text-slate-700 block mb-2">Packing Slip</Label>
                <div className="relative">
                  <Input 
                    id="shared-packing-slip"
                    value={sharedFields.packingSlip}
                    onChange={(e) => {
                      setSharedFields(prev => ({ ...prev, packingSlip: e.target.value }));
                      setPackingSlipEdited(true);
                    }}
                    onFocus={() => {
                      if (!sharedFields.packingSlip) {
                        setPackingSlipEdited(false);
                      }
                    }}
                    className="h-10 w-full pr-12"
                    placeholder="Auto after Vendor & SKU & Qty"
                  />
                  {!packingSlipEdited && sharedFields.packingSlip && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2">
                      <Badge variant="secondary" className="text-xs px-1.5 py-0.5">
                        Auto
                      </Badge>
                    </div>
                  )}
                </div>
                {/* Fixed error space to prevent layout shift */}
                <div className="h-5 mt-1"></div>
              </div>
            </div>
          </div>


          {/* Global Notes */}
          <div className="bg-white border rounded-lg p-4">
            <Label htmlFor="shared-notes" className="text-sm font-medium text-slate-700 block mb-2">Global Notes</Label>
            <Textarea 
              id="shared-notes"
              value={sharedFields.globalNotes}
              onChange={(e) => setSharedFields(prev => ({ ...prev, globalNotes: e.target.value }))}
              placeholder="Optional notes that will be applied to all items in this batch..."
              className="min-h-[80px] resize-none"
            />
            <p className="text-xs text-slate-500 mt-2">These notes will be saved with each item in this receiving batch.</p>
          </div>

          {/* Multi-SKU Table */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Receiving Items</h3>
                <p className="text-xs text-slate-500 mt-1">Add multiple SKUs to process in this batch</p>
              </div>
              <Button 
                type="button" 
                variant="outline" 
                size="sm" 
                onClick={addReceivingLine}
                className="text-green-700 border-green-300 hover:bg-green-50 hover:border-green-400 transition-colors"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Item
              </Button>
            </div>

            <div className="border rounded-lg overflow-hidden">
              {/* Single Grid Container for Header and Body */}
              <div className="w-full">
                {/* Combined Header and Body Grid */}
                <div 
                  className="grid gap-2 sm:gap-3"
                  style={{
                    gridTemplateColumns: '3fr 1fr 1fr 1.5fr 0.5fr'
                  }}
                >
                  {/* Header Row */}
                  <div className="bg-slate-50 border-b px-3 py-3 text-sm font-medium text-slate-700">SKU</div>
                  <div className="bg-slate-50 border-b px-2 py-3 text-sm font-medium text-slate-700">Quantity</div>
                  <div className="bg-slate-50 border-b px-2 py-3 text-sm font-medium text-slate-700">Unit Cost</div>
                  <div className="bg-slate-50 border-b px-2 py-3 text-sm font-medium text-slate-700">Damage Status</div>
                  <div className="bg-slate-50 border-b px-1 py-3 text-sm font-medium text-slate-700 text-center">Actions</div>
                  
                  {/* Data Rows */}
                  {receivingLines.map((line, index) => {
                    const lineErrors = Object.keys(errors).filter(key => 
                      key.startsWith(`line-${line.id}`)
                    );
                    const hasErrors = lineErrors.length > 0;
                    
                    return (
                      <React.Fragment key={line.id}>
                        {/* SKU Column */}
                        <div className={`px-3 py-3 min-h-[60px] ${hasErrors ? "bg-red-50" : ""} ${index > 0 ? "border-t" : ""}`}>
                          <div className="space-y-1">
                            <SKUSelect 
                              id={`sku-${line.id}`}
                              skus={skus}
                              value={line.skuId}
                              onChange={(value) => updateReceivingLine(line.id, { skuId: value })}
                              placeholder="Select SKU"
                              error={errors[`line-${line.id}-sku`]}
                            />
                            {errors[`line-${line.id}-sku`] && (
                              <div className="text-xs text-red-600 flex items-start gap-1 min-h-[16px] leading-tight">
                                <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                                <span className="break-words">{errors[`line-${line.id}-sku`]}</span>
                              </div>
                            )}
                          </div>
                        </div>
                        
                        {/* Quantity Column */}
                        <div className={`px-2 py-3 min-h-[60px] ${hasErrors ? "bg-red-50" : ""} ${index > 0 ? "border-t" : ""}`}>
                          <div className="space-y-1">
                            <div className="flex items-center gap-0.5">
                              <Input 
                                id={`qty-${line.id}`}
                                type="number"
                                step="any"
                                min="0"
                                value={line.qty || ''}
                                onChange={(e) => {
                                  const n = Number.isNaN(parseFloat(e.target.value)) ? 0 : parseFloat(e.target.value);
                                  updateReceivingLine(line.id, { qty: Math.max(0, n) });
                                }}
                                className={`h-9 w-full min-w-0 ${errors[`line-${line.id}-qty`] ? 'border-red-500' : ''}`}
                                placeholder="0"
                              />
                              <span className="text-xs text-slate-500 min-w-[20px] text-center flex-shrink-0">
                                {line.skuId ? skus.find(s => s.id === line.skuId)?.unit || '' : ''}
                              </span>
                            </div>
                            {errors[`line-${line.id}-qty`] && (
                              <div className="text-xs text-red-600 flex items-start gap-1 min-h-[16px] leading-tight">
                                <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                                <span className="break-words">{errors[`line-${line.id}-qty`]}</span>
                              </div>
                            )}
                          </div>
                        </div>
                        
                        {/* Unit Cost Column */}
                        <div className={`px-2 py-3 min-h-[60px] ${hasErrors ? "bg-red-50" : ""} ${index > 0 ? "border-t" : ""}`}>
                          <div className="space-y-1">
                            <CurrencyInput 
                              id={`cost-${line.id}`}
                              value={line.unitCost}
                              onChange={(value) => updateReceivingLine(line.id, { unitCost: value })}
                              error={errors[`line-${line.id}-cost`]}
                              placeholder="$0.00"
                            />
                            {errors[`line-${line.id}-cost`] && (
                              <div className="text-xs text-red-600 flex items-start gap-1 min-h-[16px] leading-tight">
                                <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                                <span className="break-words">{errors[`line-${line.id}-cost`]}</span>
                              </div>
                            )}
                          </div>
                        </div>
                        
                        {/* Damage Status Column */}
                        <div className={`px-2 py-3 min-h-[60px] ${hasErrors ? "bg-red-50" : ""} ${index > 0 ? "border-t" : ""}`}>
                          <div className="flex flex-col gap-1.5">
                            <div className="flex items-center gap-1.5">
                              <input
                                type="checkbox"
                                id={`damage-${line.id}`}
                                checked={line.isDamaged}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    openDamageModal(line.id);
                                  } else {
                                    clearDamageConfig(line.id);
                                  }
                                }}
                                className="rounded w-3 h-3"
                                disabled={!line.skuId || line.qty <= 0}
                              />
                              <Label 
                                htmlFor={`damage-${line.id}`} 
                                className="text-xs cursor-pointer leading-tight"
                              >
                                Damaged
                              </Label>
                            </div>
                            
                            {line.isDamaged && (
                              <div className="text-xs space-y-1">
                                <div className="flex items-center gap-1 flex-wrap">
                                  {line.damageScope === 'FULL' ? (
                                    <Badge variant="destructive" className="text-xs px-1 py-0 h-5">Full</Badge>
                                  ) : (
                                    <Badge variant="secondary" className="text-xs px-1 py-0 h-5">
                                      {line.damagedQty}/{line.qty}
                                    </Badge>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => openDamageModal(line.id)}
                                    className="text-blue-600 hover:text-blue-800 text-xs underline leading-tight"
                                  >
                                    Edit
                                  </button>
                                </div>
                                {line.damageNotes && (
                                  <div className="text-slate-500 text-xs truncate leading-tight" title={line.damageNotes}>
                                    {line.damageNotes}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                        
                        {/* Actions Column */}
                        <div className={`px-1 py-3 min-h-[60px] ${hasErrors ? "bg-red-50" : ""} ${index > 0 ? "border-t" : ""} flex justify-center items-start pt-6`}>
                          <Button 
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => removeReceivingLine(line.id)}
                            disabled={receivingLines.length <= 1}
                            className="text-red-600 border-red-200 hover:bg-red-50 h-8 w-8 p-0 min-w-8"
                          >
                            <Minus className="h-3 w-3" />
                          </Button>
                        </div>
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Processing Summary */}
            <div className="bg-slate-50 p-3 rounded-lg text-sm">
              <div className="grid grid-cols-2 gap-4 text-xs">
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-slate-600">Total Items:</span>
                    <span className="font-medium">{receivingLines.filter(l => l.skuId && l.qty > 0).length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600">Total Quantity:</span>
                    <span className="font-medium">{receivingLines.filter(l => l.skuId && l.qty > 0).reduce((sum, l) => sum + l.qty, 0).toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600">Total Value:</span>
                    <span className="font-medium">${receivingLines.filter(l => l.skuId && l.qty > 0).reduce((sum, l) => sum + (l.qty * l.unitCost), 0).toFixed(2)}</span>
                  </div>
                </div>
                <div className="space-y-1 border-l pl-4">
                  <div className="flex justify-between">
                    <span className="text-green-600">To Inventory:</span>
                    <span className="font-medium text-green-600">
                      {receivingLines.filter(l => l.skuId && l.qty > 0).reduce((sum, l) => sum + getEffectiveQuantities(l).receiveQty, 0).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-red-600">Damage:</span>
                    <span className="font-medium text-red-600">
                      {receivingLines.filter(l => l.skuId && l.qty > 0).reduce((sum, l) => sum + getEffectiveQuantities(l).damageQty, 0).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-green-600">Effective Value:</span>
                    <span className="font-medium text-green-600">
                      ${receivingLines.filter(l => l.skuId && l.qty > 0).reduce((sum, l) => {
                        const { receiveQty } = getEffectiveQuantities(l);
                        return sum + (receiveQty * l.unitCost);
                      }, 0).toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-between pt-4">
              <div className="text-sm text-slate-500">
                {batchProcessing && "Processing items..."}
              </div>
              <div className="flex gap-2">
                <Button 
                  type="button"
                  variant="outline"
                  onClick={() => setConfirmOpen(true)}
                  disabled={batchProcessing || receivingLines.filter(l => l.skuId && l.qty > 0).length === 0}
                  className="bg-blue-600 text-white hover:bg-blue-700"
                >
                  {batchProcessing ? "Processing..." : `Process ${receivingLines.filter(l => l.skuId && l.qty > 0).length} Items`}
                </Button>
              </div>
            </div>
          </div>

        </CardContent>
        
        {/* Batch Confirmation Modal */}
        {confirmOpen && createPortal(
          <div className="fixed inset-0 z-50" role="presentation">
            <div
              className="absolute inset-0 bg-black/30"
              aria-hidden="true"
              onClick={() => setConfirmOpen(false)}
            />
            <div
              className="absolute left-1/2 top-24 -translate-x-1/2 w-[min(100%,640px)]"
              role="dialog"
              aria-modal="true"
              aria-labelledby="confirm-batch-title"
              ref={dialogRef}
            >
              <Card className="rounded-2xl shadow-2xl bg-white ring-1 ring-black/10">
                <CardHeader>
                  <CardTitle id="confirm-batch-title">Confirm Multi-SKU Receiving</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="text-sm space-y-2">
                    <div><span className="text-slate-700">Date:</span> {sharedFields.date}</div>
                    <div><span className="text-slate-700">Vendor:</span> {sharedFields.vendor || '-'}</div>
                    <div><span className="text-slate-700">Packing Slip:</span> {sharedFields.packingSlip || '-'}</div>
                  </div>

                  <div className="space-y-3">
                    <h4 className="font-medium text-sm">Items to Process ({receivingLines.filter(l => l.skuId && l.qty > 0).length}):</h4>
                    <div className="border rounded-lg overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-slate-50">
                            <TableHead className="text-xs">SKU</TableHead>
                            <TableHead className="text-xs text-right">Total Qty</TableHead>
                            <TableHead className="text-xs text-right text-green-700">To Inventory</TableHead>
                            <TableHead className="text-xs text-right text-red-700">Damage</TableHead>
                            <TableHead className="text-xs text-right">Cost</TableHead>
                            <TableHead className="text-xs text-right text-green-700">Effective Value</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {receivingLines.filter(l => l.skuId && l.qty > 0).map(line => {
                            const { receiveQty, damageQty } = getEffectiveQuantities(line);
                            return (
                              <TableRow key={line.id} className="text-xs">
                                <TableCell>{line.skuId}</TableCell>
                                <TableCell className="text-right">{line.qty}</TableCell>
                                <TableCell className="text-right text-green-700 font-medium">{receiveQty}</TableCell>
                                <TableCell className="text-right text-red-700">{damageQty}</TableCell>
                                <TableCell className="text-right">${line.unitCost.toFixed(2)}</TableCell>
                                <TableCell className="text-right text-green-700 font-medium">${(receiveQty * line.unitCost).toFixed(2)}</TableCell>
                              </TableRow>
                            );
                          })}
                          <TableRow className="bg-slate-50 font-medium text-xs">
                            <TableCell>Total</TableCell>
                            <TableCell className="text-right">
                              {receivingLines.filter(l => l.skuId && l.qty > 0).reduce((sum, l) => sum + l.qty, 0)}
                            </TableCell>
                            <TableCell className="text-right text-green-700">
                              {receivingLines.filter(l => l.skuId && l.qty > 0).reduce((sum, l) => sum + getEffectiveQuantities(l).receiveQty, 0)}
                            </TableCell>
                            <TableCell className="text-right text-red-700">
                              {receivingLines.filter(l => l.skuId && l.qty > 0).reduce((sum, l) => sum + getEffectiveQuantities(l).damageQty, 0)}
                            </TableCell>
                            <TableCell></TableCell>
                            <TableCell className="text-right text-green-700">
                              ${receivingLines.filter(l => l.skuId && l.qty > 0).reduce((sum, l) => {
                                const { receiveQty } = getEffectiveQuantities(l);
                                return sum + (receiveQty * l.unitCost);
                              }, 0).toFixed(2)}
                            </TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <Button
                      variant="outline"
                      onClick={() => setConfirmOpen(false)}
                      data-modal-initial="true"
                    >
                      Cancel
                    </Button>
                    <Button 
                      onClick={() => {
                        setConfirmOpen(false);
                        processAllReceivings();
                      }} 
                      disabled={batchProcessing}
                    >
                      {batchProcessing ? 'Processing...' : 'Confirm & Process All'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>,
          document.body
        )}

        {/* Batch Results Modal */}
        {showBatchResults && batchResults.length > 0 && createPortal(
          <div className="fixed inset-0 z-50" role="presentation">
            <div
              className="absolute inset-0 bg-black/30"
              aria-hidden="true"
              onClick={() => setShowBatchResults(false)}
            />
            <div
              className="absolute left-1/2 top-24 -translate-x-1/2 w-[min(100%,640px)]"
              role="dialog"
              aria-modal="true"
              aria-labelledby="batch-results-title"
            >
              <Card className="rounded-2xl shadow-2xl bg-white ring-1 ring-black/10">
                <CardHeader>
                  <CardTitle id="batch-results-title">Processing Results</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    {batchResults.map((result, index) => (
                      <div 
                        key={result.line.id} 
                        className={`flex items-center gap-3 p-3 rounded-lg text-sm ${
                          result.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
                        }`}
                      >
                        <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
                          result.success ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
                        }`}>
                          {result.success ? '✓' : '✗'}
                        </span>
                        <span className="flex-1">
                          <strong>{result.line.skuId}</strong> - {(() => {
                            const { receiveQty, damageQty } = getEffectiveQuantities(result.line);
                            if (receiveQty > 0 && damageQty > 0) {
                              return `${receiveQty} received, ${damageQty} damaged`;
                            } else if (receiveQty > 0) {
                              return `${receiveQty} units received`;
                            } else {
                              return `${damageQty} units damaged (full loss)`;
                            }
                          })()}
                          {result.error && <div className="text-xs mt-1">Error: {result.error}</div>}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <Button onClick={() => setShowBatchResults(false)}>
                      Close
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>,
          document.body
        )}
      </Card>

      {/* Recent Layers Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Card className="rounded-xl border border-dashed">
            <CardHeader className="py-4">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Layers className="h-5 w-5 text-slate-500"/>
                  Inventory Layers (FIFO)
                </CardTitle>
                <div className="w-1/2">
                  <Select value={selectedLayersSku} onValueChange={setSelectedLayersSku}>
                    <SelectTrigger placeholder="Select a SKU...">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {skus.map(s => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.id} — {s.description}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[300px] pr-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Layer ID</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Remaining qty</TableHead>
                      <TableHead>Unit cost</TableHead>
                      <TableHead>Asset Value</TableHead>
                      <TableHead className="w-32">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoadingLayers ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-sm text-slate-500">Loading layers...</TableCell>
                      </TableRow>
                    ) : !selectedLayersSku ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-sm text-slate-500">Select a SKU to view its layers.</TableCell>
                      </TableRow>
                    ) : activeLayers.filter(l => l.remaining > 0).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-sm text-slate-500">No active layers found for the selected SKU.</TableCell>
                      </TableRow>
                    ) : (
                      (showAllLayers ? activeLayers.filter(l => l.remaining > 0) : activeLayers.filter(l => l.remaining > 0).slice(0, 10)).map((l) => (
                        <TableRow key={l.id} className="hover:bg-slate-50">
                          <TableCell className="font-mono text-xs">{l.id}</TableCell>
                          <TableCell>{typeof l.date === 'string' ? l.date : new Date(l.date).toLocaleDateString()}</TableCell>
                          <TableCell className="font-medium">{l.remaining}</TableCell>
                          <TableCell>{formatUSD(l.cost)}</TableCell>
                          <TableCell className="font-medium">{formatUSD(l.remaining * l.cost)}</TableCell>
                          <TableCell>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openAdjustmentModal(l, selectedLayersSku)}
                              className="h-7 px-2 text-xs bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 hover:border-blue-300"
                              title={`Adjust layer ${l.id}`}
                            >
                              Adjust
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
              {activeLayers.filter(l => l.remaining > 0).length > 10 && (
                <div className="mt-2 text-center">
                  <Button variant="link" onClick={() => setShowAllLayers(!showAllLayers)}>
                    {showAllLayers ? 'Show less' : `View all ${activeLayers.filter(l => l.remaining > 0).length} layers`}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <SectionCard title="Recent submissions" icon={<Package className="h-5 w-5 text-slate-500"/>}>
            <div className="space-y-2">
              {recentReceives.map((r, index) => (
                <div key={`${r.datetime}-${index}`} className="p-3 rounded-xl border border-dashed">
                  <div className="flex items-center justify-between">
                    <div className="text-sm">{r.ref} — {r.skuOrName}</div>
                    <Badge variant="secondary">RECEIVED</Badge>
                  </div>
                  <p className="text-xs text-slate-500">{new Date(r.datetime).toLocaleDateString()} • {r.qty} units • {formatUSD(r.value)}</p>
                </div>
              ))}
              {recentReceives.length === 0 && (
                <div className="p-3 rounded-xl border border-dashed">
                  <p className="text-sm text-slate-500">No recent submissions.</p>
                </div>
              )}
            </div>
          </SectionCard>
        </div>
      </div>

      {/* Damage Configuration Modal */}
      <DamageModal
        isOpen={damageModal.isOpen}
        onClose={closeDamageModal}
        lineId={damageModal.lineId}
        totalQty={damageModal.lineId ? receivingLines.find(l => l.id === damageModal.lineId)?.qty || 0 : 0}
        currentScope={damageModal.scope}
        currentQty={damageModal.quantity}
        currentNotes={damageModal.notes}
        onSave={saveDamageConfig}
      />

      {/* Layer Adjustment Modal */}
      <AdjustmentModal
        isOpen={adjustmentModal.isOpen}
        onClose={closeAdjustmentModal}
        layer={adjustmentModal.layer}
        skuId={adjustmentModal.skuId}
        onConfirm={handleAdjustmentConfirm}
      />
    </div>
  );
}
