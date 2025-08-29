/**
 * AdjustmentModal Component
 * Modal for adjusting FIFO layer quantities with validation and audit trail
 */

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import type { LayerLite } from '@/features/inventory/types/inventory.types';

// Predefined adjustment reasons
const ADJUSTMENT_REASONS = [
  'Physical Count Discrepancy',
  'System Error Correction',
  'Damaged/Spoiled Inventory',
  'Quality Control Rejection',
  'Inventory Reconciliation',
  'Location Transfer',
  'Other (specify in notes)'
];

interface AdjustmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  layer: LayerLite | null;
  skuId: string;
  onConfirm: (params: {
    layerId: string;
    quantity: number;
    reason: string;
    notes?: string;
    reference?: string;
  }) => Promise<void>;
}

export default function AdjustmentModal({
  isOpen,
  onClose,
  layer,
  skuId,
  onConfirm
}: AdjustmentModalProps) {
  const [adjustmentType, setAdjustmentType] = useState<'increase' | 'decrease'>('decrease');
  const [adjustmentQty, setAdjustmentQty] = useState<number>(0);
  const [newQuantity, setNewQuantity] = useState<number>(0);
  const [reason, setReason] = useState<string>('');
  const [customReason, setCustomReason] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [reference, setReference] = useState<string>('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isProcessing, setIsProcessing] = useState(false);

  // Reset form when modal opens/closes
  useEffect(() => {
    if (isOpen && layer) {
      setAdjustmentType('decrease');
      setAdjustmentQty(0);
      setNewQuantity(layer.remaining);
      setReason('');
      setCustomReason('');
      setNotes('');
      setReference(`ADJ-${Date.now()}`);
      setErrors({});
    }
  }, [isOpen, layer]);

  // Calculate new quantity based on adjustment
  useEffect(() => {
    if (layer) {
      const adjustment = adjustmentType === 'increase' ? adjustmentQty : -adjustmentQty;
      setNewQuantity(Math.max(0, layer.remaining + adjustment));
    }
  }, [adjustmentQty, adjustmentType, layer]);

  const validate = () => {
    const newErrors: Record<string, string> = {};

    if (adjustmentQty <= 0) {
      newErrors.adjustmentQty = 'Adjustment quantity must be greater than 0';
    }

    if (adjustmentType === 'decrease' && layer && adjustmentQty > layer.remaining) {
      newErrors.adjustmentQty = `Cannot exceed available quantity (${layer.remaining})`;
    }

    if (!reason.trim()) {
      newErrors.reason = 'Adjustment reason is required';
    }

    if (reason === 'Other (specify in notes)' && !customReason.trim()) {
      newErrors.customReason = 'Please specify the custom reason';
    }

    if (notes.length > 500) {
      newErrors.notes = 'Notes cannot exceed 500 characters';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleConfirm = async () => {
    if (!validate() || !layer) return;

    setIsProcessing(true);
    try {
      const finalQuantity = adjustmentType === 'increase' ? adjustmentQty : -adjustmentQty;
      const finalReason = reason === 'Other (specify in notes)' ? customReason : reason;
      
      await onConfirm({
        layerId: typeof layer.id === 'string' ? layer.id : layer.id.toString(),
        quantity: finalQuantity,
        reason: finalReason,
        notes: notes.trim() || undefined,
        reference: reference.trim() || undefined,
      });

      onClose();
    } catch (error: any) {
      setErrors({ general: error.message || 'Failed to process adjustment' });
    } finally {
      setIsProcessing(false);
    }
  };

  const formatCurrency = (value: number) => 
    `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (!isOpen || !layer) return null;

  return createPortal(
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-semibold text-slate-900">
              Adjust Inventory Layer
            </h3>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 text-xl leading-none"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          {/* Layer Information */}
          <div className="bg-slate-50 rounded-lg p-4 mb-6">
            <h4 className="font-medium text-slate-900 mb-3">Layer Information</h4>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-slate-600">Layer ID:</span>
                <div className="font-mono text-slate-900">{layer.id}</div>
              </div>
              <div>
                <span className="text-slate-600">SKU:</span>
                <div className="font-medium text-slate-900">{skuId}</div>
              </div>
              <div>
                <span className="text-slate-600">Current Quantity:</span>
                <div className="font-medium text-slate-900">{layer.remaining}</div>
              </div>
              <div>
                <span className="text-slate-600">Unit Cost:</span>
                <div className="font-medium text-slate-900">{formatCurrency(layer.cost)}</div>
              </div>
              <div>
                <span className="text-slate-600">Date:</span>
                <div className="text-slate-900">
                  {typeof layer.date === 'string' 
                    ? new Date(layer.date).toLocaleDateString()
                    : layer.date.toLocaleDateString()
                  }
                </div>
              </div>
              <div>
                <span className="text-slate-600">Current Value:</span>
                <div className="font-medium text-slate-900">
                  {formatCurrency(layer.remaining * layer.cost)}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            {/* Adjustment Type */}
            <div className="space-y-3">
              <Label className="text-sm font-medium text-slate-700">Adjustment Type</Label>
              
              <div className="grid grid-cols-2 gap-3">
                <label className={`flex items-center space-x-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                  adjustmentType === 'increase' 
                    ? 'bg-green-50 border-green-300 text-green-800' 
                    : 'hover:bg-slate-50'
                }`}>
                  <input
                    type="radio"
                    name="adjustmentType"
                    value="increase"
                    checked={adjustmentType === 'increase'}
                    onChange={() => setAdjustmentType('increase')}
                    className="text-green-600"
                  />
                  <div>
                    <div className="font-medium text-sm">Increase</div>
                    <div className="text-xs text-slate-500">Add inventory</div>
                  </div>
                </label>

                <label className={`flex items-center space-x-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                  adjustmentType === 'decrease' 
                    ? 'bg-red-50 border-red-300 text-red-800' 
                    : 'hover:bg-slate-50'
                }`}>
                  <input
                    type="radio"
                    name="adjustmentType"
                    value="decrease"
                    checked={adjustmentType === 'decrease'}
                    onChange={() => setAdjustmentType('decrease')}
                    className="text-red-600"
                  />
                  <div>
                    <div className="font-medium text-sm">Decrease</div>
                    <div className="text-xs text-slate-500">Remove inventory</div>
                  </div>
                </label>
              </div>
            </div>

            {/* Adjustment Quantity */}
            <div className="space-y-2">
              <Label htmlFor="adjustment-qty" className="text-sm font-medium text-slate-700">
                Adjustment Quantity
              </Label>
              <Input
                id="adjustment-qty"
                type="number"
                min="0.01"
                step="0.01"
                max={adjustmentType === 'decrease' ? layer.remaining : undefined}
                value={adjustmentQty || ''}
                onChange={(e) => {
                  const val = parseFloat(e.target.value) || 0;
                  setAdjustmentQty(val);
                  setErrors(prev => ({ ...prev, adjustmentQty: '' }));
                }}
                className={errors.adjustmentQty ? 'border-red-500' : ''}
                placeholder="Enter quantity to adjust"
              />
              {errors.adjustmentQty && (
                <div className="text-xs text-red-600">{errors.adjustmentQty}</div>
              )}
            </div>

            {/* Impact Preview */}
            {adjustmentQty > 0 && (
              <div className={`p-3 rounded-lg border ${
                adjustmentType === 'increase' 
                  ? 'bg-green-50 border-green-200' 
                  : 'bg-red-50 border-red-200'
              }`}>
                <div className="text-sm">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-slate-600">Current Quantity:</span>
                    <span className="font-medium">{layer.remaining}</span>
                  </div>
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-slate-600">Adjustment:</span>
                    <span className={`font-medium ${
                      adjustmentType === 'increase' ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {adjustmentType === 'increase' ? '+' : '-'}{adjustmentQty}
                    </span>
                  </div>
                  <div className="flex justify-between items-center font-medium text-slate-900 pt-1 border-t border-slate-200">
                    <span>New Quantity:</span>
                    <span>{newQuantity}</span>
                  </div>
                  <div className="flex justify-between items-center text-xs text-slate-500 mt-1">
                    <span>Value Impact:</span>
                    <span>{formatCurrency((adjustmentType === 'increase' ? adjustmentQty : -adjustmentQty) * layer.cost)}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Adjustment Reason */}
            <div className="space-y-2">
              <Label htmlFor="adjustment-reason" className="text-sm font-medium text-slate-700">
                Adjustment Reason *
              </Label>
              <Select value={reason} onValueChange={(value) => {
                setReason(value);
                setErrors(prev => ({ ...prev, reason: '', customReason: '' }));
              }}>
                <SelectTrigger className={errors.reason ? 'border-red-500' : ''}>
                  <SelectValue placeholder="Select adjustment reason..." />
                </SelectTrigger>
                <SelectContent>
                  {ADJUSTMENT_REASONS.map(r => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.reason && (
                <div className="text-xs text-red-600">{errors.reason}</div>
              )}
            </div>

            {/* Custom Reason Input */}
            {reason === 'Other (specify in notes)' && (
              <div className="space-y-2">
                <Label htmlFor="custom-reason" className="text-sm font-medium text-slate-700">
                  Custom Reason *
                </Label>
                <Input
                  id="custom-reason"
                  value={customReason}
                  onChange={(e) => {
                    setCustomReason(e.target.value);
                    setErrors(prev => ({ ...prev, customReason: '' }));
                  }}
                  placeholder="Please specify the reason for this adjustment"
                  className={errors.customReason ? 'border-red-500' : ''}
                />
                {errors.customReason && (
                  <div className="text-xs text-red-600">{errors.customReason}</div>
                )}
              </div>
            )}

            {/* Reference */}
            <div className="space-y-2">
              <Label htmlFor="adjustment-ref" className="text-sm font-medium text-slate-700">
                Reference
              </Label>
              <Input
                id="adjustment-ref"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Optional reference number"
              />
            </div>

            {/* Notes */}
            <div className="space-y-2">
              <Label htmlFor="adjustment-notes" className="text-sm font-medium text-slate-700">
                Notes <span className="text-slate-400">(Optional)</span>
              </Label>
              <Textarea
                id="adjustment-notes"
                value={notes}
                onChange={(e) => {
                  setNotes(e.target.value);
                  setErrors(prev => ({ ...prev, notes: '' }));
                }}
                placeholder="Additional notes about this adjustment..."
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

            {/* General Error */}
            {errors.general && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {errors.general}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3 mt-6 pt-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="flex-1"
              disabled={isProcessing}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleConfirm}
              className={`flex-1 ${
                adjustmentType === 'increase' 
                  ? 'bg-green-600 hover:bg-green-700' 
                  : 'bg-red-600 hover:bg-red-700'
              } text-white`}
              disabled={isProcessing || adjustmentQty <= 0}
            >
              {isProcessing 
                ? 'Processing...' 
                : `Confirm ${adjustmentType === 'increase' ? 'Increase' : 'Decrease'}`
              }
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}