/**
 * Inventory Service Adapter
 * Bridges the gap between existing mock interfaces and new Supabase services
 */

import type { 
  UISKUOption, 
  VendorSuggestion, 
  LayerLite, 
  MovementWithDetails
} from '@/features/inventory/types/inventory.types';

// Import Supabase services
import * as SkuService from './supabase/sku.service';
import * as MovementService from './supabase/movement.service';
import * as FifoService from './supabase/fifo.service';
import * as WorkOrderService from './supabase/workorder.service';
import * as AuditService from './supabase/audit.service';
import * as VendorService from './supabase/vendor.service';
import * as CategoryService from './supabase/category.service';

/**
 * SKU Operations
 */
export const skuOperations = {
  async getAllSKUs(): Promise<UISKUOption[]> {
    return await SkuService.getSKUs({ active: true });
  },

  async getSKUsByType(type: 'RAW' | 'SELLABLE'): Promise<UISKUOption[]> {
    return await SkuService.getSKUs({ type: type as any, active: true });
  },

  async getSKUById(id: string): Promise<UISKUOption | null> {
    return await SkuService.getSKUById(id);
  },

  async createSKU(sku: Omit<UISKUOption, 'onHand'>): Promise<UISKUOption> {
    return await SkuService.createSKU(sku);
  },

  async updateSKU(id: string, updates: Partial<UISKUOption>): Promise<UISKUOption> {
    return await SkuService.updateSKU(id, updates);
  },

  async deleteSKU(id: string): Promise<void> {
    return await SkuService.deleteSKU(id);
  },

  async getInventorySummary() {
    return await SkuService.getInventorySummary();
  },

  async countSKUsByCategory(categoryName: string, options?: { activeOnly?: boolean }) {
    return await SkuService.countSKUsByCategory(categoryName, options);
  }
};

/**
 * Vendor Operations
 */
export const vendorOperations = {
  async getVendorSuggestions(query: string): Promise<VendorSuggestion[]> {
    return await VendorService.getVendorSuggestions(query);
  },

  async createOrGetVendor(name: string) {
    return await VendorService.createOrGetVendorByName(name);
  },

  async getAllVendors() {
    return await VendorService.getVendors({ active: true });
  },

  async getVendorById(id: string) {
    return await VendorService.getVendorById(id);
  },

  async createVendor(vendor: {
    name: string;
    address?: string;
    email?: string;
    phone?: string;
    bank?: string;
  }) {
    // Map frontend Vendor type to backend createVendor params
    return await VendorService.createVendor({
      name: vendor.name,
      address: vendor.address,
      email: vendor.email,
      phone: vendor.phone,
      bankInfo: vendor.bank ? { display: vendor.bank } : undefined
    });
  },

  async updateVendor(id: string, updates: {
    name?: string;
    address?: string;
    email?: string;
    phone?: string;
    bank?: string;
  }) {
    // Map frontend updates to backend format
    return await VendorService.updateVendor(id, {
      name: updates.name,
      address: updates.address,
      email: updates.email,
      phone: updates.phone,
      bank_info: updates.bank ? { display: updates.bank } : undefined
    });
  },

  async deleteVendor(id: string): Promise<void> {
    return await VendorService.deleteVendor(id);
  }
};
 
/**
 * Category Operations
 */
export const categoryOperations = {
  async getCategories(filters?: { active?: boolean; searchTerm?: string }) {
    return await CategoryService.getCategories(filters);
  },

  async getCategoryById(id: string) {
    return await CategoryService.getCategoryById(id);
  },

  async createCategory(input: { name: string; description?: string; sortOrder?: number }) {
    return await CategoryService.createCategory(input);
  },

  async updateCategory(id: string, updates: Partial<CategoryService.UICategory>) {
    return await CategoryService.updateCategory(id, updates);
  },

  async deleteCategory(id: string): Promise<void> {
    return await CategoryService.deleteCategory(id);
  },

  async renameCategoryAndRetagSkus(oldName: string, newName: string, options?: { dryRun?: boolean }) {
    return await CategoryService.renameCategoryAndRetagSkus(oldName, newName, options);
  }
};
 
/**
 * FIFO Layer Operations
 */
export const fifoOperations = {
  async getFIFOLayers(skuId: string): Promise<LayerLite[]> {
    return await FifoService.getFIFOLayers(skuId);
  },

  async getAllFIFOLayers(): Promise<Record<string, LayerLite[]>> {
    return await FifoService.getAllFIFOLayers();
  },

  async calculateFIFOPlan(skuId: string, quantity: number) {
    return await FifoService.calculateFIFOPlan(skuId, quantity);
  },

  async getAvailableQuantity(skuId: string): Promise<number> {
    return await FifoService.getAvailableQuantity(skuId);
  },

  async getLayerAdjustmentInfo(layerId: string) {
    return await FifoService.getLayerAdjustmentInfo(layerId);
  }
};

/**
 * Movement Operations
 */
export const movementOperations = {

  async createReceiveMovement(params: {
    skuId: string;
    quantity: number;
    unitCost: number;
    date: Date;
    vendorName: string;
    packingSlipNo?: string;
    lotNumber?: string;
    notes?: string;
  }): Promise<MovementWithDetails> {
    return await MovementService.createReceiveMovement(params);
  },

  async createIssueMovement(params: {
    skuId: string;
    quantity: number;
    date: Date;
    reference?: string;
    notes?: string;
  }) {
    return await MovementService.createIssueMovement(params);
  },

  async createWasteMovement(params: {
    skuId: string;
    quantity: number;
    date: Date;
    reference?: string;
    notes?: string;
  }) {
    return await MovementService.createWasteMovement(params);
  },

  async createDamageMovement(params: {
    skuId: string;
    quantity: number;
    unitCost?: number;
    date: Date;
    reference?: string;
    notes?: string;
    generalNotes?: string;
    damageNotes?: string;
  }) {
    return await MovementService.createDamageMovement(params);
  },

  async createAdjustmentMovement(params: {
    skuId: string;
    layerId: string;
    quantity: number; // Can be positive (increase) or negative (decrease)
    date: Date;
    reference?: string;
    reason: string; // Mandatory adjustment reason
    notes?: string;
    adjustedBy?: string;
  }) {
    return await MovementService.createAdjustmentMovement(params);
  },

  async createProduceMovement(params: {
    skuId?: string;
    productName?: string;
    quantity: number;
    unitCost: number;
    date: Date;
    reference?: string;
    notes?: string;
  }): Promise<MovementWithDetails> {
    return await MovementService.createProduceMovement(params);
  },

  async getMovementDeletionInfo(movementId: number) {
    return await MovementService.getMovementDeletionInfo(movementId);
  },

  async canReverseMovement(movementId: number) {
    return await MovementService.canReverseMovement(movementId);
  },

  async reverseMovement(movementId: number, options?: { reason?: string; deletedBy?: string }) {
    return await MovementService.reverseMovement(movementId, options);
  },

  async deleteMovement(movementId: number, options?: { reason?: string; deletedBy?: string }) {
    return await MovementService.deleteMovement(movementId, options);
  },

  async softDeleteMovement(movementId: number, options?: { reason?: string; deletedBy?: string }) {
    return await MovementService.softDeleteMovement(movementId, options);
  },

  async restoreMovement(movementId: number, restoredBy?: string) {
    return await MovementService.restoreMovement(movementId, restoredBy);
  },

  async getMovements(filters?: { 
    skuId?: string; 
    type?: string; 
    dateFrom?: Date; 
    dateTo?: Date; 
    limit?: number; 
    offset?: number;
    includeDeleted?: boolean;
  }) {
    return await MovementService.getMovements(filters as any);
  },

  // Work Order specific operations
  async validateWorkOrderState(reference: string) {
    return await MovementService.validateWorkOrderState(reference);
  },

  async deleteWorkOrderAtomic(reference: string, options?: { reason?: string; deletedBy?: string }) {
    return await MovementService.deleteWorkOrderAtomic(reference, options);
  },

  async restoreWorkOrderAtomic(reference: string, restoredBy?: string) {
    return await MovementService.restoreWorkOrderAtomic(reference, restoredBy);
  },

  async diagnoseWorkOrderIntegrity(reference: string) {
    return await MovementService.diagnoseWorkOrderIntegrity(reference);
  },

  async repairSkuIntegrity(skuId: string) {
    return await MovementService.repairSkuIntegrity(skuId);
  }
};

/**
 * Audit Operations
 */
export const auditOperations = {
  async getMovementDeletionHistory(filters?: {
    limit?: number;
    offset?: number;
    skuId?: string;
    deletedBy?: string;
    dateFrom?: Date;
    dateTo?: Date;
  }) {
    return await AuditService.getMovementDeletionHistory(filters);
  },

  async getDeletionStatistics(filters?: { dateFrom?: Date; dateTo?: Date }) {
    return await AuditService.getDeletionStatistics(filters);
  },

  async getMovementDeletionAuditById(auditId: number) {
    return await AuditService.getMovementDeletionAuditById(auditId);
  },

  async getSkuDeletionHistory(skuId: string, limit = 50) {
    return await AuditService.getSkuDeletionHistory(skuId, limit);
  },

  async getRecentDeletions(hoursBack = 24, limit = 20) {
    return await AuditService.getRecentDeletions(hoursBack, limit);
  },

  exportDeletionAuditToCsv(audits: any[]) {
    return AuditService.exportDeletionAuditToCsv(audits);
  }
};

/**
 * Work Order Operations
 */
export const workOrderOperations = {
  async calculateWorkOrderPlans(
    rawMaterials: Array<{ skuId: string; quantity: number }>,
    wasteLines: Array<{ skuId: string; quantity: number }>
  ) {
    return await WorkOrderService.calculateWorkOrderFIFOPlans(rawMaterials, wasteLines);
  },

  async createWorkOrder(params: WorkOrderService.WorkOrderParams) {
    return await WorkOrderService.createWorkOrder(params);
  },

  async getWorkOrders(filters?: {
    outputSkuId?: string;
    dateFrom?: Date;
    dateTo?: Date;
    limit?: number;
    offset?: number;
  }) {
    return await WorkOrderService.getWorkOrders(filters);
  },

  async getWorkOrderById(id: string) {
    return await WorkOrderService.getWorkOrderById(id);
  }
};

/**
 * Legacy Mock Interface Compatibility
 * These functions maintain compatibility with existing components
 */

// For ReceivingForm compatibility
export async function getVendorSuggestions(query: string): Promise<VendorSuggestion[]> {
  return vendorOperations.getVendorSuggestions(query);
}

export async function getSKUOptions(): Promise<UISKUOption[]> {
  return skuOperations.getAllSKUs();
}

export async function getRawSKUOptions(): Promise<UISKUOption[]> {
  return skuOperations.getSKUsByType('RAW');
}

export async function getSellableSKUOptions(): Promise<UISKUOption[]> {
  return skuOperations.getSKUsByType('SELLABLE');
}

// For WorkOrder compatibility  
export async function getFIFOLayers(skuId: string): Promise<LayerLite[]> {
  return fifoOperations.getFIFOLayers(skuId);
}

export async function getAllFIFOLayers(): Promise<Record<string, LayerLite[]>> {
  return fifoOperations.getAllFIFOLayers();
}

// For Movements compatibility
export async function getMovements(filters?: any) {
  return movementOperations.getMovements(filters);
}

// Deletion operation (exposed for Wireframe.tsx import)
export async function deleteMovement(
  movementId: number,
  options?: { reason?: string; deletedBy?: string }
) {
  return movementOperations.deleteMovement(movementId, options);
}

// Receiving operation
export async function processReceiving(params: {
  skuId: string;
  quantity: number;
  unitCost: number;
  date: Date;
  vendorName: string;
  packingSlipNo?: string;
  lotNumber?: string;
  notes?: string;
}): Promise<MovementWithDetails> {
  return movementOperations.createReceiveMovement(params);
}

// Work Order operation
export async function processWorkOrder(params: {
  outputName: string;
  outputSkuId?: string;
  outputQuantity: number;
  rawMaterials: Array<{ skuId: string; quantity: number }>;
  wasteLines: Array<{ skuId: string; quantity: number }>;
  date: Date;
  reference?: string;
  notes?: string;
}) {
  return workOrderOperations.createWorkOrder(params);
}

/**
 * Utility functions for validation
 */
export async function validateSKUAvailability(skuId: string, requiredQty: number): Promise<{
  available: number;
  canFulfill: boolean;
  shortage: number;
}> {
  const available = await fifoOperations.getAvailableQuantity(skuId);
  return {
    available,
    canFulfill: available >= requiredQty,
    shortage: Math.max(0, requiredQty - available)
  };
}

export async function validateMultiSKUAvailability(
  requirements: Array<{ skuId: string; quantity: number }>
): Promise<Array<{
  skuId: string;
  available: number;
  required: number;
  canFulfill: boolean;
  shortage: number;
}>> {
  const results = [];
  
  for (const req of requirements) {
    const validation = await validateSKUAvailability(req.skuId, req.quantity);
    results.push({
      skuId: req.skuId,
      available: validation.available,
      required: req.quantity,
      canFulfill: validation.canFulfill,
      shortage: validation.shortage
    });
  }
  
  return results;
}
