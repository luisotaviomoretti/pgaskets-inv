import { supabase } from '@/lib/supabase';
import type { MovementType } from '@/features/inventory/types/domain';

/**
 * Movement Deletion Audit Service
 * Handles querying and managing movement deletion audit records
 */

export interface MovementDeletionAudit {
  auditId: number;
  originalMovementId: number;
  movementType: MovementType;
  skuId: string | null;
  productName: string | null;
  quantity: number;
  unitCost: number | null;
  totalValue: number;
  reference: string;
  movementDatetime: string;
  deletionType: 'REVERSE' | 'DELETE';
  deletionReason: string | null;
  deletedBy: string;
  deletedAt: string;
  restoredLayers: any[] | null;
}

export interface DeletionStatistics {
  totalDeletions: number;
  deletionsByType: Record<string, number>;
  deletionsByMovementType: Record<string, number>;
  deletionsByUser: Record<string, number>;
  dateRange: {
    from: string;
    to: string;
  };
}

/**
 * Get movement deletion history with filtering and pagination
 */
export async function getMovementDeletionHistory(filters?: {
  limit?: number;
  offset?: number;
  skuId?: string;
  deletedBy?: string;
  dateFrom?: Date;
  dateTo?: Date;
}): Promise<{ audits: MovementDeletionAudit[]; total: number }> {
  const { data, error } = await supabase.rpc('get_movement_deletion_history', {
    p_limit: filters?.limit || 100,
    p_offset: filters?.offset || 0,
    p_sku_id: filters?.skuId || null,
    p_deleted_by: filters?.deletedBy || null,
    p_date_from: filters?.dateFrom?.toISOString() || null,
    p_date_to: filters?.dateTo?.toISOString() || null,
  });

  if (error) throw error;

  const audits: MovementDeletionAudit[] = (data || []).map((row: any) => ({
    auditId: row.audit_id,
    originalMovementId: row.original_movement_id,
    movementType: row.movement_type,
    skuId: row.sku_id,
    productName: row.product_name,
    quantity: row.quantity,
    unitCost: row.unit_cost,
    totalValue: row.total_value,
    reference: row.reference,
    movementDatetime: row.movement_datetime,
    deletionType: row.deletion_type,
    deletionReason: row.deletion_reason,
    deletedBy: row.deleted_by,
    deletedAt: row.deleted_at,
    restoredLayers: row.restored_layers,
  }));

  return { audits, total: audits.length };
}

/**
 * Get deletion statistics for reporting and analytics
 */
export async function getDeletionStatistics(filters?: {
  dateFrom?: Date;
  dateTo?: Date;
}): Promise<DeletionStatistics> {
  const { data, error } = await supabase.rpc('get_deletion_statistics', {
    p_date_from: filters?.dateFrom?.toISOString() || null,
    p_date_to: filters?.dateTo?.toISOString() || null,
  });

  if (error) throw error;

  return {
    totalDeletions: data?.total_deletions || 0,
    deletionsByType: data?.deletions_by_type || {},
    deletionsByMovementType: data?.deletions_by_movement_type || {},
    deletionsByUser: data?.deletions_by_user || {},
    dateRange: {
      from: data?.date_range?.from || '',
      to: data?.date_range?.to || '',
    },
  };
}

/**
 * Get audit details for a specific movement deletion
 */
export async function getMovementDeletionAuditById(auditId: number): Promise<MovementDeletionAudit | null> {
  const { data, error } = await supabase
    .from('movement_deletion_audit')
    .select('*')
    .eq('id', auditId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null; // Not found
    }
    throw error;
  }

  if (!data) return null;

  return {
    auditId: data.id,
    originalMovementId: data.original_movement_id,
    movementType: data.original_movement_type,
    skuId: data.original_sku_id,
    productName: data.original_product_name,
    quantity: data.original_quantity,
    unitCost: data.original_unit_cost,
    totalValue: data.original_total_value,
    reference: data.original_reference,
    movementDatetime: data.original_datetime,
    deletionType: data.deletion_type,
    deletionReason: data.deletion_reason,
    deletedBy: data.deleted_by,
    deletedAt: data.deleted_at,
    restoredLayers: data.restored_layers,
  };
}

/**
 * Get all deletions for a specific SKU
 */
export async function getSkuDeletionHistory(skuId: string, limit = 50): Promise<MovementDeletionAudit[]> {
  const { audits } = await getMovementDeletionHistory({
    skuId,
    limit,
    offset: 0,
  });

  return audits;
}

/**
 * Get recent deletions (last 24 hours by default)
 */
export async function getRecentDeletions(hoursBack = 24, limit = 20): Promise<MovementDeletionAudit[]> {
  const dateFrom = new Date();
  dateFrom.setHours(dateFrom.getHours() - hoursBack);

  const { audits } = await getMovementDeletionHistory({
    dateFrom,
    limit,
    offset: 0,
  });

  return audits;
}

/**
 * Export deletion audit data to CSV format
 */
export function exportDeletionAuditToCsv(audits: MovementDeletionAudit[]): string {
  const headers = [
    'Audit ID',
    'Original Movement ID',
    'Movement Type',
    'SKU ID',
    'Product Name',
    'Quantity',
    'Unit Cost',
    'Total Value',
    'Reference',
    'Movement Date',
    'Deletion Type',
    'Deletion Reason',
    'Deleted By',
    'Deleted At',
    'Restored Layers Count',
  ];

  const rows = audits.map(audit => [
    audit.auditId,
    audit.originalMovementId,
    audit.movementType,
    audit.skuId || '',
    audit.productName || '',
    audit.quantity,
    audit.unitCost || '',
    audit.totalValue,
    audit.reference,
    audit.movementDatetime,
    audit.deletionType,
    audit.deletionReason || '',
    audit.deletedBy,
    audit.deletedAt,
    audit.restoredLayers ? audit.restoredLayers.length : 0,
  ]);

  const csvContent = [headers, ...rows]
    .map(row => row.map(cell => `"${cell}"`).join(','))
    .join('\n');

  return csvContent;
}
