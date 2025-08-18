// Shared domain types for Inventory/FIFO system

export type MovementType = 'RECEIVE' | 'ISSUE' | 'WASTE' | 'PRODUCE';

export type Movement = {
  datetime: string; // ISO string
  type: MovementType;
  skuOrName: string; // SKU for RECEIVE/ISSUE/WASTE; output name for PRODUCE
  qty: number; // positive for RECEIVE/PRODUCE; negative for ISSUE/WASTE when applicable in UI
  value: number; // signed monetary value of the movement
  ref: string; // e.g., WO code or PO number
};

// Receiving domain
export interface ReceiveLine {
  sku: string;
  unit: string;
  qty: number; // > 0
  unitCost: number; // > 0
}

export interface ReceivePayload {
  vendorId: string;
  invoice?: string;
  datetime: string; // ISO
  lines: ReceiveLine[];
}

// Work order domain (multi-SKU RAW + mirrored waste)
export interface RawMaterialLine {
  sku: string;
  unit: string;
  qty: number; // > 0
}

export interface WasteLine {
  sku: string; // mirrors RAW
  unit: string;
  qty: number; // 0 <= waste <= raw for that SKU
}

export type OutputMode = 'AUTO' | 'MANUAL';

export interface WorkOrderPayload {
  code: string; // WO reference
  datetime: string; // ISO
  outputName: string; // required
  outputUnit: string;
  mode: OutputMode;
  outputQty: number; // > 0 for MANUAL; AUTO derived
  raw: RawMaterialLine[];
  waste: WasteLine[]; // mirrors raw by SKU
}
