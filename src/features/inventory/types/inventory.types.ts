/**
 * Inventário - Tipos centrais
 * Criado: 2025-08-15 03:37 (local)
 * Última modificação: 2025-08-15 03:37 (local)
 */

// Branded Types para segurança adicional (ordem alfabética)
export type LayerId = string & { readonly __brand: 'LayerId' };
export type MovementId = string & { readonly __brand: 'MovementId' };
export type SKUId = string & { readonly __brand: 'SKUId' };
export type VendorId = string & { readonly __brand: 'VendorId' };

// ---------------------------------------------------------------------------
// Construtores e type guards para Branded Types
// ---------------------------------------------------------------------------
// A ideia é garantir que strings externas (inputs de UI/API) sejam validadas
// antes de assumirem a marca (brand). Assim mantemos segurança de tipos em
// tempo de compilação e disciplina de validação em tempo de execução.

/**
 * Valida se uma string atende ao padrão de SKU.
 * Regra: somente letras maiúsculas, dígitos e hífen: /^[A-Z0-9-]+$/
 */
export const isSKUId = (value: unknown): value is SKUId =>
  typeof value === 'string' && /^[A-Z0-9-]+$/.test(value);

/**
 * Constrói um `SKUId` a partir de uma string válida.
 * Lança erro se a string não obedecer ao regex especificado.
 */
export const toSKUId = (value: string): SKUId => {
  if (!isSKUId(value)) {
    throw new Error(`SKUId inválido: esperado /^[A-Z0-9-]+$/, recebido "${value}"`);
  }
  return value as SKUId;
};

/**
 * Valida se uma string pode ser `VendorId`.
 * Regra: deve iniciar com prefixo 'VND-' OU possuir length > 0.
 */
export const isVendorId = (value: unknown): value is VendorId =>
  typeof value === 'string' && (value.startsWith('VND-') || value.length > 0);

/**
 * Constrói um `VendorId` a partir de uma string válida.
 */
export const toVendorId = (value: string): VendorId => {
  if (!isVendorId(value)) {
    throw new Error(`VendorId inválido: use prefixo 'VND-' ou uma string não vazia. Recebido "${value}"`);
  }
  return value as VendorId;
};

/**
 * Valida se uma string pode ser `LayerId`.
 * Não há regra de formato específica definida pelo projeto neste momento;
 * exigimos apenas string não vazia para evitar IDs inválidos.
 */
export const isLayerId = (value: unknown): value is LayerId =>
  typeof value === 'string' && value.length > 0;

/**
 * Constrói um `LayerId` a partir de uma string (não vazia).
 */
export const toLayerId = (value: string): LayerId => {
  if (!isLayerId(value)) {
    throw new Error('LayerId inválido: string vazia não é permitida.');
  }
  return value as LayerId;
};

/**
 * Valida se uma string pode ser `MovementId`.
 * Sem regra específica de formato; exigimos string não vazia.
 */
export const isMovementId = (value: unknown): value is MovementId =>
  typeof value === 'string' && value.length > 0;

/**
 * Constrói um `MovementId` a partir de uma string (não vazia).
 */
export const toMovementId = (value: string): MovementId => {
  if (!isMovementId(value)) {
    throw new Error('MovementId inválido: string vazia não é permitida.');
  }
  return value as MovementId;
};

// Enums com valores explícitos (ordem alfabética por nome)
export enum DamageScope {
  FULL = 'FULL',
  NONE = 'NONE',
  PARTIAL = 'PARTIAL'
}

export enum MaterialType {
  RAW = 'RAW',
  SELLABLE = 'SELLABLE'
}

export enum MovementType {
  ADJUSTMENT = 'ADJUSTMENT',
  ISSUE = 'ISSUE',
  PRODUCE = 'PRODUCE',
  RECEIVE = 'RECEIVE',
  TRANSFER = 'TRANSFER',
  WASTE = 'WASTE'
}

export enum ProductCategory {
  ADHESIVES = 'Adhesives',
  BOXES = 'Boxes',
  CORK_RUBBER = 'Cork/Rubber',
  FELT = 'Felt',
  FIBRE_FOAM = 'Fibre Foam',
  FILM_FOIL = 'Film and Foil',
  POLYURETHANE_ESTER = 'Polyurethane Ester',
  POLYURETHANE_ETHER = 'Polyurethane Ether'
}

// Domain Models com validação
export interface SKU {
  readonly id: SKUId;
  description: string;
  type: MaterialType;
  productCategory: ProductCategory;
  unit: string;
  active: boolean;
  minStock: number;
  maxStock?: number;
  reorderPoint?: number;
  onHand: number;
  reserved: number;
  available: number;
  averageCost: number | null;
  lastCost: number | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
  metadata?: Record<string, unknown>;
}

export interface Layer {
  readonly id: LayerId;
  skuId: SKUId;
  receivingDate: Date;
  expiryDate?: Date;
  remainingQuantity: number;
  originalQuantity: number;
  unitCost: number;
  vendorId?: VendorId;
  packingSlipNo?: string;
  lotNumber?: string;
  location?: string;
  status: 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED' | 'QUARANTINE';
  createdAt: Date;
  lastMovementAt?: Date;
}

export interface Vendor {
  readonly id: VendorId;
  name: string;
  legalName?: string;
  taxId?: string;
  address: Address;
  contacts: Contact[];
  bankAccounts: BankAccount[];
  paymentTerms?: PaymentTerms;
  rating?: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface Address {
  street: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  coordinates?: {
    lat: number;
    lng: number;
  };
}

export interface Contact {
  name: string;
  role?: string;
  email?: string;
  phone?: string;
  isPrimary: boolean;
}

export interface BankAccount {
  bankName: string;
  accountNumber: string;
  routingNumber?: string;
  iban?: string;
  swift?: string;
  isPrimary: boolean;
}

export interface PaymentTerms {
  days: number;
  discountPercentage?: number;
  discountDays?: number;
}

export interface Movement {
  readonly id: MovementId;
  datetime: Date;
  type: MovementType;
  skuId?: SKUId;
  productName?: string;
  quantity: number;
  unitCost: number;
  totalValue: number;
  reference: string;
  workOrderId?: string;
  userId: string;
  notes?: string;
  layers?: LayerConsumption[];
  createdAt: Date;
  reversedAt?: Date;
  reversedBy?: string;
}

export interface LayerConsumption {
  layerId: LayerId;
  quantity: number;
  unitCost: number;
  totalCost: number;
}

// DTOs para API
export interface ReceivingDTO {
  vendorId: VendorId;
  receivingDate: Date;
  items: ReceivingItemDTO[];
  packingSlipNo: string;
  notes?: string;
  isDamaged: boolean;
  damageDetails?: DamageDetailsDTO;
}

export interface ReceivingItemDTO {
  skuId: SKUId;
  quantity: number;
  unitCost: number;
  lotNumber?: string;
  expiryDate?: Date;
}

export interface DamageDetailsDTO {
  scope: DamageScope;
  rejectedQuantity: number;
  reason: string;
  photos?: string[];
}

export interface WorkOrderDTO {
  workOrderNo: string;
  startDate: Date;
  endDate?: Date;
  consumption: ConsumptionDTO[];
  waste?: WasteDTO[];
  output: OutputDTO[];
  laborHours?: number;
  notes?: string;
}

export interface ConsumptionDTO {
  skuId: SKUId;
  quantity: number;
  notes?: string;
}

export interface WasteDTO {
  skuId: SKUId;
  quantity: number;
  reason: string;
}

export interface OutputDTO {
  productName: string;
  skuId?: SKUId;
  quantity: number;
  unitCost?: number;
}

// Query Parameters
export interface InventoryFilters {
  type?: MaterialType;
  category?: ProductCategory;
  belowMinimum?: boolean;
  searchTerm?: string;
  active?: boolean;
  sortBy?: 'id' | 'description' | 'onHand' | 'value';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface MovementFilters {
  type?: MovementType;
  skuId?: SKUId;
  dateFrom?: Date;
  dateTo?: Date;
  reference?: string;
  userId?: string;
  page?: number;
  pageSize?: number;
}

// API Responses
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    totalPages: number;
    totalItems: number;
  };
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  timestamp: Date;
  path?: string;
}

// Metrics Types
export interface InventoryMetrics {
  totalQuantity: number;
  totalValue: number;
  turnoverRate: number;
  daysOfInventory: number;
  stockoutRisk: SKUId[];
  overstockItems: SKUId[];
  expiringItems: Array<{
    skuId: SKUId;
    layerId: LayerId;
    expiryDate: Date;
    quantity: number;
  }>;
}

export interface DashboardPeriod {
  start: Date;
  end: Date;
  bins: Array<[Date, Date]>;
}

// Validation Types
export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
  suggestion?: string;
}

// ---------------------------------------------------------------------------
// UI types migrated from inventory_wireframe.jsx (strict equivalents)
// ---------------------------------------------------------------------------

// Vendor suggestions used by the autocomplete component
export interface VendorSuggestion {
  name: string;
  address?: string;
  bank?: string;
  email?: string;
  phone?: string;
}

// Minimal SKU option used in selects and tables in the wireframe
export interface UISKUOption {
  id: SKUId; // wireframe used string
  description?: string;
  type: MaterialType; // wireframe used 'RAW' | 'SELLABLE'
  productCategory: ProductCategory; // wireframe used string union
  unit?: string;
  active?: boolean;
  min?: number; // minimum stock threshold displayed
  onHand?: number; // current balance displayed
}

// Lightweight FIFO layer representation used in UI tables
export interface LayerLite {
  // Compatibilidade de migração: aceitamos `LayerId | string` e `Date | string`
  // para permitir uma transição gradual do wireframe (.jsx) para tipos estritos.
  id: LayerId | string; // wireframe usava string simples
  date: Date | string; // wireframe usava string de data
  remaining: number;
  cost: number; // unit cost per layer
}

// Movement log entry used in dashboard/tables
export interface MovementLogEntry {
  movementId: MovementId;
  datetime: Date; // wireframe used timestamp string
  // Restrict to the subset used in the wireframe
  type: Extract<
    MovementType,
    MovementType.RECEIVE | MovementType.ISSUE | MovementType.WASTE | MovementType.PRODUCE
  >;
  skuOrName: string; // SKU code or product name
  qty: number; // negative for ISSUE/WASTE
  value: number; // absolute value in currency units
  ref: string; // reference (e.g., WO number)
}

// Time range presets used in dashboard helpers
export type PeriodOption = 'today' | 'last7' | 'month' | 'quarter' | 'custom';


export interface MovementWithDetails {
  id: MovementId;
  date: Date;
  type: MovementType;
  skuId: string;
  skuDescription: string;
  unit: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
  vendor?: string;
  reference?: string;
  notes?: string;
}

// Outcome model used by damaged receiving flow
export enum DamageOutcomeMode {
  APPROVE = 'APPROVE',
  REJECT_ALL = 'REJECT_ALL',
  PARTIAL = 'PARTIAL',
}

export interface DamageOutcome {
  mode: DamageOutcomeMode;
  acceptQty: number;
  rejectQty: number;
}

// ---------------------------------------------------------------------------
// Tipos de compatibilidade para migração gradual
// ---------------------------------------------------------------------------
// Estes tipos representam os formatos "legado" usados no wireframe/JSX antes
// da adoção total do TypeScript estrito. As funções `toModern*` convertem os
// objetos para suas versões modernas (tipadas) garantindo validação básica.

// SKU legado: mantém todos os campos, mas `id` é string simples
export type LegacySKU = Omit<UISKUOption, 'id'> & { id: string };

// Layer legado: `id` e `date` como strings
export type LegacyLayer = Omit<LayerLite, 'id' | 'date'> & { id: string; date: string };

// Movimento legado: `datetime` como string
export type LegacyMovement = Omit<MovementLogEntry, 'datetime'> & { datetime: string };

/**
 * Converte SKU legado (id string) para SKU moderno (id `SKUId`).
 * Valida o formato do SKU através do `toSKUId`.
 */
export const toModernSKU = (legacy: LegacySKU): UISKUOption => ({
  ...legacy,
  id: toSKUId(legacy.id),
});

/**
 * Converte Layer legado (id/date string) para Layer moderno:
 *  - id: `LayerId`
 *  - date: `Date` válida
 */
export const toModernLayer = (legacy: LegacyLayer): LayerLite => {
  const d = new Date(legacy.date);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Data inválida para LayerLite: "${legacy.date}"`);
  }
  return {
    ...legacy,
    id: toLayerId(legacy.id),
    date: d,
  };
};

/**
 * Converte Movimento legado (datetime string) para Movimento moderno (`Date`).
 */
export const toModernMovement = (legacy: LegacyMovement): MovementLogEntry => {
  const dt = new Date(legacy.datetime);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Datetime inválido para MovementLogEntry: "${legacy.datetime}"`);
  }
  return {
    ...legacy,
    datetime: dt,
  };
};
