/**
 * Utility functions for the Receiving Form component
 * 
 * This file contains:
 * - USD currency formatting and parsing functions
 * - SKU to Type mapping logic
 * - Form validation helpers
 * - Packing slip reference suggestion helper
 */

// USD Currency formatting utilities
export const formatUSD = (value: number): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
};

export const parseUSDInput = (input: string): number => {
  // Handle empty or whitespace-only input
  if (!input || !input.trim()) {
    return 0;
  }
  
  // Remove currency symbols, commas, and spaces, but keep dots and digits
  const cleaned = input.replace(/[$,\s]/g, '');
  
  // Handle partial inputs like "." or incomplete numbers
  if (cleaned === '.' || cleaned === '') {
    return 0;
  }
  
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : Math.max(0, parsed);
};

// SKU Type mapping
export type SKUType = 'RAW' | 'SELLABLE';

export const getTypeFromSKU = (skuId: string, skus: Array<{ id: string; type: SKUType }>): string => {
  const sku = skus.find(s => s.id === skuId);
  if (!sku) return '';
  
  return sku.type === 'RAW' ? 'Raw Material' : 'Sellable Product';
};

// Form validation helpers
export const validateQuantity = (qty: number): string | null => {
  if (!qty || qty <= 0) {
    return 'Quantity must be at least 1.';
  }
  return null;
};

export const validateUnitCost = (cost: number): string | null => {
  if (!cost || cost <= 0) {
    return 'Invalid unit cost.';
  }
  return null;
};

export const validateVendor = (vendor: string): string | null => {
  if (!vendor || vendor.trim().length < 3) {
    return 'Vendor name must be at least 3 characters.';
  }
  return null;
};

export const validateSKU = (skuId: string): string | null => {
  if (!skuId) {
    return 'Please select a SKU.';
  }
  return null;
};

// Character counter helper
export const getCharacterCount = (text: string, maxLength: number = 1000): { count: number; remaining: number; isOverLimit: boolean } => {
  const count = text.length;
  const remaining = maxLength - count;
  const isOverLimit = count > maxLength;
  
  return { count, remaining, isOverLimit };
};

// Builds a suggested packing slip reference like: PS-VEN-SKU-YYYYMMDD-001
export function buildPackingSlipSuggestion(params: {
  vendorName: string;
  skuId: string;
  date: string; // in YYYY-MM-DD
  existingRefs?: string[]; // list of existing refs to compute next sequence
}): string {
  const { vendorName, skuId, date, existingRefs = [] } = params;
  if (!vendorName || !skuId || !date) return '';

  const vendorCode = vendorName
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word[0])
    .join('')
    .slice(0, 3) || 'VEN';

  const skuCode = skuId.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
  const dateCode = date.replace(/-/g, '');
  const prefix = `PS-${vendorCode}-${skuCode}-${dateCode}`;

  const nextSeq = (existingRefs.filter(r => r?.startsWith(prefix)).length || 0) + 1;
  const seq = String(nextSeq).padStart(3, '0');
  return `${prefix}-${seq}`;
}
