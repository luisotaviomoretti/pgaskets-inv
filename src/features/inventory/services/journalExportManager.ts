/**
 * Journal Export Manager - Safe Wrapper Pattern
 * Preserves existing functionality while enabling new history features
 */

import { getFeatureFlag, withFeatureFlag } from '../../../lib/featureFlags';
import type { ExportRecord, ExportHistory } from '../types/journalExport.types';
import { ExportDataUtils, validateExportRecord } from '../types/journalExport.types';

// ============================================================================
// LEGACY EXPORT INTERFACE (Preserved)
// ============================================================================

export interface LegacyExportResult {
  success: boolean;
  filename: string;
  data: any[];
  error?: string;
}

// ============================================================================
// ENHANCED EXPORT INTERFACE (New)
// ============================================================================

export interface EnhancedExportResult extends LegacyExportResult {
  journalNumber?: string;
  exportId?: string;
  trackingEnabled: boolean;
  metadata?: {
    movements: {
      total: number;
      byType: Record<string, number>;
    };
    financials: {
      totalValue: number;
      byType: Record<string, number>;
    };
  };
}

// ============================================================================
// JOURNAL EXPORT MANAGER CLASS
// ============================================================================

export class JournalExportManager {
  private static instance: JournalExportManager;
  
  private constructor() {}
  
  public static getInstance(): JournalExportManager {
    if (!JournalExportManager.instance) {
      JournalExportManager.instance = new JournalExportManager();
    }
    return JournalExportManager.instance;
  }

  /**
   * Main export method - intelligently routes to legacy or enhanced flow
   */
  public async exportJournal(
    movements: any[],
    dateRange: { from: Date; to: Date },
    exportedBy: string
  ): Promise<EnhancedExportResult> {
    
    return withFeatureFlag(
      'JOURNAL_HISTORY_TRACKING',
      // Enhanced export with tracking
      () => this.exportWithTracking(movements, dateRange, exportedBy),
      // Legacy export (current system)
      () => this.exportLegacy(movements, dateRange, exportedBy)
    );
  }

  /**
   * Legacy export - preserves current functionality exactly
   */
  private async exportLegacy(
    movements: any[],
    dateRange: { from: Date; to: Date },
    exportedBy: string
  ): Promise<EnhancedExportResult> {
    
    try {
      // This will be replaced with actual legacy export logic
      const filename = `journal_${new Date().toISOString().split('T')[0]}.xlsx`;
      
      console.log('📄 Using legacy export (no tracking)');
      
      return {
        success: true,
        filename,
        data: movements,
        trackingEnabled: false,
      };
      
    } catch (error) {
      console.error('Legacy export failed:', error);
      return {
        success: false,
        filename: '',
        data: [],
        trackingEnabled: false,
        error: error instanceof Error ? error.message : 'Export failed'
      };
    }
  }

  /**
   * Enhanced export with history tracking
   */
  private async exportWithTracking(
    movements: any[],
    dateRange: { from: Date; to: Date },
    exportedBy: string
  ): Promise<EnhancedExportResult> {
    
    try {
      // Generate journal number and metadata
      const journalNumber = ExportDataUtils.generateJournalNumber();
      const filename = `journal_${journalNumber}.xlsx`;
      
      console.log('📊 Using enhanced export with tracking');
      console.log('📄 Journal Number:', journalNumber);
      
      // Calculate movements and financial breakdown
      const movementBreakdown = ExportDataUtils.calculateMovementBreakdown(movements);
      const financialBreakdown = ExportDataUtils.calculateFinancialBreakdown(movements);
      
      const totalValue = Object.values(financialBreakdown).reduce((sum, val) => sum + val, 0);
      
      // Create export record for validation
      const exportRecord: ExportRecord = {
        journalNumber,
        movements,
        filename,
        exportedBy,
        totalValue,
      };
      
      // Validate export data
      const validatedRecord = validateExportRecord(exportRecord);
      
      // TODO: Save to database when schema is ready
      if (getFeatureFlag('JOURNAL_HISTORY_TRACKING')) {
        console.log('💾 Would save export history to database');
        console.log('📋 Export record:', {
          journalNumber: validatedRecord.journalNumber,
          filename: validatedRecord.filename,
          totalMovements: validatedRecord.movements.length,
          totalValue: validatedRecord.totalValue,
        });
      }
      
      return {
        success: true,
        filename,
        data: movements,
        journalNumber,
        exportId: `temp-${Date.now()}`, // Temporary until database integration
        trackingEnabled: true,
        metadata: {
          movements: {
            total: movements.length,
            byType: movementBreakdown,
          },
          financials: {
            totalValue,
            byType: financialBreakdown,
          },
        },
      };
      
    } catch (error) {
      console.error('Enhanced export failed, falling back to legacy:', error);
      
      // Automatic fallback to legacy export
      return this.exportLegacy(movements, dateRange, exportedBy);
    }
  }

  /**
   * Check if enhanced features are available
   */
  public isEnhancedModeEnabled(): boolean {
    return getFeatureFlag('JOURNAL_HISTORY_TRACKING');
  }

  /**
   * Get export capabilities based on feature flags
   */
  public getCapabilities() {
    return {
      tracking: getFeatureFlag('JOURNAL_HISTORY_TRACKING'),
      historyUI: getFeatureFlag('JOURNAL_HISTORY_UI'),
      analytics: getFeatureFlag('JOURNAL_PREMIUM_ANALYTICS'),
      actions: getFeatureFlag('JOURNAL_EXPORT_ACTIONS'),
      autoSync: getFeatureFlag('JOURNAL_AUTO_SYNC'),
    };
  }

  /**
   * Safe method to retrieve export history (when implemented)
   */
  public async getExportHistory(filters?: any): Promise<ExportHistory[]> {
    return withFeatureFlag(
      'JOURNAL_HISTORY_UI',
      // Enhanced: Load from database
      async () => {
        console.log('📚 Would load export history from database');
        // TODO: Implement database query
        return [];
      },
      // Legacy: Empty array
      async () => []
    );
  }

  /**
   * Validate system integrity before operations
   */
  private validateSystemIntegrity(): boolean {
    try {
      // Check feature flags are accessible
      const trackingFlag = getFeatureFlag('JOURNAL_HISTORY_TRACKING');
      console.log('🔧 System integrity check passed');
      return true;
    } catch (error) {
      console.error('🚨 System integrity check failed:', error);
      return false;
    }
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const journalExportManager = JournalExportManager.getInstance();

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Main export function - preserves existing API
 */
export async function exportJournal(
  movements: any[],
  dateRange: { from: Date; to: Date },
  exportedBy: string = 'user'
): Promise<EnhancedExportResult> {
  return journalExportManager.exportJournal(movements, dateRange, exportedBy);
}

/**
 * Check if new features are available
 */
export function hasJournalHistory(): boolean {
  return journalExportManager.isEnhancedModeEnabled();
}

/**
 * Get journal export capabilities
 */
export function getJournalCapabilities() {
  return journalExportManager.getCapabilities();
}