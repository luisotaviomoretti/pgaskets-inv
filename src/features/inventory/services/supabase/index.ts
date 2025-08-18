/**
 * Supabase Services - Main Export Index
 * Centralized exports for all Supabase-based inventory services
 */

// SKU Services
export * from './sku.service';

// Vendor Services  
export * from './vendor.service';

// FIFO Layer Services
export * from './fifo.service';

// Movement Services
export * from './movement.service';

// Work Order Services
export * from './workorder.service';

// Re-export types for convenience
export type {
  RawMaterialLine,
  WasteLine,
  WorkOrderParams,
  MultiSKUFIFOPlan,
  WorkOrderResult,
} from './workorder.service';

export type {
  FIFOConsumptionPlan,
  FIFOPlanResult,
} from './fifo.service';
