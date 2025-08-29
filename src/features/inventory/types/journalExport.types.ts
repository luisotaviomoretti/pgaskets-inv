/**
 * Journal Export History Types
 * Strict TypeScript definitions for data integrity
 */

import { z } from 'zod';
import { MovementType } from './inventory.types';

// ============================================================================
// ENUMS
// ============================================================================

export enum ExportStatus {
  EXPORTED = 'exported',
  SYNCED = 'synced', 
  FAILED = 'failed',
  PENDING = 'pending'
}

export enum SyncStatus {
  SYNCED = 'synced',
  PENDING = 'pending',
  FAILED = 'failed',
  NOT_REQUIRED = 'not_required'
}

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

// Movement breakdown schema
const MovementBreakdownSchema = z.record(
  z.nativeEnum(MovementType),
  z.number().int().min(0)
);

// Financial breakdown schema  
const FinancialBreakdownSchema = z.record(
  z.nativeEnum(MovementType),
  z.number().min(0)
);

// Export metadata schema
const ExportMetadataSchema = z.object({
  filename: z.string().min(1),
  fileSize: z.number().int().min(0).optional(),
  checksum: z.string().optional(),
  exportedBy: z.string().min(1),
  syncedAt: z.date().optional(),
});

// Export actions schema
const ExportActionsSchema = z.object({
  canRedownload: z.boolean(),
  canResend: z.boolean(), 
  canModify: z.boolean(),
});

// Main export history schema
export const ExportHistorySchema = z.object({
  id: z.string().uuid(),
  journalNumber: z.string().regex(/^JNL-\d{8}-\d{3}$/, 'Invalid journal number format'),
  exportDate: z.date(),
  
  movements: z.object({
    total: z.number().int().min(0),
    byType: MovementBreakdownSchema,
  }),
  
  financials: z.object({
    totalValue: z.number().min(0),
    byType: FinancialBreakdownSchema,
  }),
  
  status: z.nativeEnum(ExportStatus),
  syncStatus: z.nativeEnum(SyncStatus),
  
  metadata: ExportMetadataSchema,
  actions: ExportActionsSchema,
  
  // Audit fields
  createdAt: z.date(),
  updatedAt: z.date().optional(),
  deletedAt: z.date().optional(),
});

// Export record for database insertion
export const ExportRecordSchema = z.object({
  journalNumber: z.string(),
  movements: z.array(z.any()), // Raw movement data
  filename: z.string(),
  exportedBy: z.string(),
  totalValue: z.number().min(0).optional(),
});

// Export filters schema
export const ExportHistoryFiltersSchema = z.object({
  dateFrom: z.date().optional(),
  dateTo: z.date().optional(),
  status: z.nativeEnum(ExportStatus).optional(),
  syncStatus: z.nativeEnum(SyncStatus).optional(),
  minValue: z.number().min(0).optional(),
  maxValue: z.number().min(0).optional(),
  movementTypes: z.array(z.nativeEnum(MovementType)).optional(),
  searchTerm: z.string().optional(),
  limit: z.number().int().min(1).max(1000).default(50),
  offset: z.number().int().min(0).default(0),
});

// ============================================================================
// TYPESCRIPT INTERFACES
// ============================================================================

export type ExportHistory = z.infer<typeof ExportHistorySchema>;
export type ExportRecord = z.infer<typeof ExportRecordSchema>;
export type ExportHistoryFilters = z.infer<typeof ExportHistoryFiltersSchema>;

export interface ExportMetrics {
  totalExports: number;
  totalValue: number;
  lastExportDate?: Date;
  syncStatus: {
    synced: number;
    pending: number;
    failed: number;
  };
  movementBreakdown: Record<MovementType, number>;
}

export interface ExportHistoryState {
  history: ExportHistory[];
  loading: boolean;
  error: string | null;
  filters: ExportHistoryFilters;
  metrics: ExportMetrics | null;
}

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

/**
 * Validate export history data
 */
export function validateExportHistory(data: unknown): ExportHistory {
  try {
    return ExportHistorySchema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(issue => 
        `${issue.path.join('.')}: ${issue.message}`
      ).join(', ');
      throw new Error(`Export history validation failed: ${issues}`);
    }
    throw error;
  }
}

/**
 * Validate export record for insertion
 */
export function validateExportRecord(data: unknown): ExportRecord {
  try {
    return ExportRecordSchema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(issue => 
        `${issue.path.join('.')}: ${issue.message}`
      ).join(', ');
      throw new Error(`Export record validation failed: ${issues}`);
    }
    throw error;
  }
}

/**
 * Validate export filters
 */
export function validateExportFilters(data: unknown): ExportHistoryFilters {
  try {
    return ExportHistoryFiltersSchema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.warn('Invalid export filters, using defaults:', error);
      return ExportHistoryFiltersSchema.parse({});
    }
    throw error;
  }
}

/**
 * Safe data transformation utilities
 */
export const ExportDataUtils = {
  
  /**
   * Safely convert database row to ExportHistory
   */
  fromDatabaseRow(row: any): ExportHistory | null {
    try {
      const transformed = {
        id: row.id,
        journalNumber: row.journal_number,
        exportDate: new Date(row.export_date),
        movements: {
          total: row.movements_count || 0,
          byType: row.movement_breakdown || {},
        },
        financials: {
          totalValue: parseFloat(row.total_value || '0'),
          byType: row.financial_breakdown || {},
        },
        status: row.export_status || ExportStatus.EXPORTED,
        syncStatus: row.sync_status || SyncStatus.PENDING,
        metadata: {
          filename: row.filename || 'unknown.xlsx',
          fileSize: row.file_size,
          checksum: row.checksum,
          exportedBy: row.exported_by || 'unknown',
          syncedAt: row.synced_at ? new Date(row.synced_at) : undefined,
        },
        actions: {
          canRedownload: true,
          canResend: row.export_status === ExportStatus.SYNCED,
          canModify: false, // Future feature
        },
        createdAt: new Date(row.created_at),
        updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
        deletedAt: row.deleted_at ? new Date(row.deleted_at) : undefined,
      };
      
      return validateExportHistory(transformed);
    } catch (error) {
      console.error('Failed to transform database row:', error);
      return null;
    }
  },

  /**
   * Calculate movement breakdown from movement array
   */
  calculateMovementBreakdown(movements: any[]): Record<MovementType, number> {
    const breakdown: Record<string, number> = {};
    
    movements.forEach(([movement]) => {
      const type = movement.type;
      breakdown[type] = (breakdown[type] || 0) + 1;
    });
    
    return breakdown as Record<MovementType, number>;
  },

  /**
   * Calculate financial breakdown from movement array
   */
  calculateFinancialBreakdown(movements: any[]): Record<MovementType, number> {
    const breakdown: Record<string, number> = {};
    
    movements.forEach(([movement]) => {
      const type = movement.type;
      const value = Math.abs(movement.value || 0);
      breakdown[type] = (breakdown[type] || 0) + value;
    });
    
    return breakdown as Record<MovementType, number>;
  },

  /**
   * Generate unique journal number
   */
  generateJournalNumber(): string {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
    const timeStr = String(now.getTime()).slice(-3);
    return `JNL-${dateStr}-${timeStr}`;
  },

  /**
   * Calculate file checksum (simple hash for integrity)
   */
  calculateChecksum(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }
};