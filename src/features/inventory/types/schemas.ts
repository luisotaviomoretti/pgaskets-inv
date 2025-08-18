import { z } from 'zod';
import type { MovementType } from './domain';

export const movementTypeSchema = z.enum(['RECEIVE', 'ISSUE', 'WASTE', 'PRODUCE']) as z.ZodType<MovementType>;

export const movementSchema = z.object({
  datetime: z.string().datetime({ message: 'Invalid ISO datetime' }),
  type: movementTypeSchema,
  skuOrName: z.string().min(1),
  qty: z.number(),
  value: z.number(),
  ref: z.string().min(1),
});

export const receiveLineSchema = z.object({
  sku: z.string().min(1, { message: 'SKU is required' }),
  unit: z.string().min(1, { message: 'Unit is required' }),
  qty: z.number().positive({ message: 'Quantity must be > 0' }),
  unitCost: z.number().positive({ message: 'Unit cost must be > 0' }),
});

export const receivePayloadSchema = z.object({
  vendorId: z.string().min(1, { message: 'Vendor is required' }),
  invoice: z.string().optional(),
  datetime: z.string().datetime({ message: 'Invalid ISO datetime' }),
  lines: z.array(receiveLineSchema).min(1, { message: 'At least one line is required' }),
});

export const rawMaterialLineSchema = z.object({
  sku: z.string().min(1),
  unit: z.string().min(1),
  qty: z.number().positive(),
});

export const wasteLineSchema = z.object({
  sku: z.string().min(1),
  unit: z.string().min(1),
  qty: z.number().min(0),
});

export const workOrderPayloadSchema = z.object({
  code: z.string().min(1),
  datetime: z.string().datetime({ message: 'Invalid ISO datetime' }),
  outputName: z.string().min(1),
  outputUnit: z.string().min(1),
  mode: z.enum(['AUTO', 'MANUAL']),
  outputQty: z.number().positive(), // for MANUAL; callers can ignore if AUTO
  raw: z.array(rawMaterialLineSchema).min(1),
  waste: z.array(wasteLineSchema), // validate mirroring by business logic
});

export type MovementInput = z.infer<typeof movementSchema>;
export type ReceivePayloadInput = z.infer<typeof receivePayloadSchema>;
export type WorkOrderPayloadInput = z.infer<typeof workOrderPayloadSchema>;
