import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { receivePayloadSchema } from '@/features/inventory/types/schemas';

const baseValid = {
  vendorId: 'VEN-123',
  invoice: 'INV-001',
  datetime: new Date().toISOString(),
  lines: [
    { sku: 'SKU-1', unit: 'pcs', qty: 1.5, unitCost: 2.25 },
  ],
  notes: 'ok',
};

describe('receivePayloadSchema', () => {
  it('accepts a valid payload with decimals', () => {
    const parsed = receivePayloadSchema.parse(baseValid);
    expect(parsed.lines[0].qty).toBe(1.5);
    expect(parsed.lines[0].unitCost).toBe(2.25);
  });

  it('rejects non-ISO datetime', () => {
    expect(() => receivePayloadSchema.parse({ ...baseValid, datetime: '2020-01-01' })).toThrow(z.ZodError);
  });

  it('requires vendorId', () => {
    expect(() => receivePayloadSchema.parse({ ...baseValid, vendorId: '' })).toThrow(z.ZodError);
  });

  it('requires at least one line', () => {
    expect(() => receivePayloadSchema.parse({ ...baseValid, lines: [] })).toThrow(z.ZodError);
  });

  it('requires qty > 0 and unitCost > 0', () => {
    expect(() => receivePayloadSchema.parse({
      ...baseValid,
      lines: [{ sku: 'SKU', unit: 'pcs', qty: 0, unitCost: 1 }],
    })).toThrow(z.ZodError);
    expect(() => receivePayloadSchema.parse({
      ...baseValid,
      lines: [{ sku: 'SKU', unit: 'pcs', qty: 1, unitCost: 0 }],
    })).toThrow(z.ZodError);
  });
});
