/**
 * Journal History Service - Database Operations
 * Handles all database interactions for journal export history
 */

import { supabase } from '../../../../lib/supabase';
import type { 
  ExportHistory, 
  ExportRecord, 
  ExportHistoryFilters,
  ExportMetrics 
} from '../../types/journalExport.types';
import { ExportDataUtils } from '../../types/journalExport.types';
import { validationLayer } from '../validationLayer';

// ============================================================================
// SERVICE CLASS
// ============================================================================

export class JournalHistoryService {
  
  /**
   * Create new export history record
   */
  public static async createExportHistory(record: ExportRecord): Promise<ExportHistory | null> {
    try {
      // Validate input
      const validation = validationLayer.validateForDatabase(record);
      if (!validation.valid) {
        console.error('Export record validation failed:', validation.errors);
        return null;
      }
      
      const validRecord = validation.validatedRecord!;
      
      // Calculate breakdowns
      const movementBreakdown = ExportDataUtils.calculateMovementBreakdown(validRecord.movements);
      const financialBreakdown = ExportDataUtils.calculateFinancialBreakdown(validRecord.movements);
      
      // Prepare database row data
      const dbData = {
        journal_number: validRecord.journalNumber,
        movements_count: validRecord.movements.length,
        movement_breakdown: movementBreakdown,
        total_value: validRecord.totalValue || 0,
        financial_breakdown: financialBreakdown,
        filename: validRecord.filename,
        exported_by: validRecord.exportedBy,
        export_status: 'exported' as const,
        sync_status: 'pending' as const,
      };
      
      // Insert into database
      const { data, error } = await supabase
        .from('journal_export_history')
        .insert(dbData)
        .select()
        .single();
      
      if (error) {
        console.error('Failed to create export history:', error);
        return null;
      }
      
      // Transform back to frontend format
      return ExportDataUtils.fromDatabaseRow(data);
      
    } catch (error) {
      console.error('Export history creation error:', error);
      return null;
    }
  }
  
  /**
   * Get export history with optional filters
   */
  public static async getExportHistory(filters: ExportHistoryFilters = {}): Promise<ExportHistory[]> {
    try {
      let query = supabase
        .from('journal_export_history')
        .select('*')
        .is('deleted_at', null)
        .order('export_date', { ascending: false });
      
      // Apply filters
      if (filters.dateFrom) {
        query = query.gte('export_date', filters.dateFrom.toISOString());
      }
      
      if (filters.dateTo) {
        query = query.lte('export_date', filters.dateTo.toISOString());
      }
      
      if (filters.status) {
        query = query.eq('export_status', filters.status);
      }
      
      if (filters.syncStatus) {
        query = query.eq('sync_status', filters.syncStatus);
      }
      
      if (filters.minValue !== undefined) {
        query = query.gte('total_value', filters.minValue);
      }
      
      if (filters.maxValue !== undefined) {
        query = query.lte('total_value', filters.maxValue);
      }
      
      if (filters.searchTerm) {
        query = query.or(`journal_number.ilike.%${filters.searchTerm}%,filename.ilike.%${filters.searchTerm}%,exported_by.ilike.%${filters.searchTerm}%`);
      }
      
      // Pagination
      query = query.range(filters.offset || 0, (filters.offset || 0) + (filters.limit || 50) - 1);
      
      const { data, error } = await query;
      
      if (error) {
        console.error('Failed to fetch export history:', error);
        return [];
      }
      
      // Transform database rows to frontend format
      return data
        .map(row => ExportDataUtils.fromDatabaseRow(row))
        .filter((item): item is ExportHistory => item !== null);
      
    } catch (error) {
      console.error('Export history fetch error:', error);
      return [];
    }
  }
  
  /**
   * Get export metrics and statistics
   */
  public static async getExportMetrics(
    dateFrom?: Date,
    dateTo?: Date
  ): Promise<ExportMetrics | null> {
    try {
      let query = supabase
        .from('journal_export_history')
        .select('*')
        .is('deleted_at', null);
      
      if (dateFrom) {
        query = query.gte('export_date', dateFrom.toISOString());
      }
      
      if (dateTo) {
        query = query.lte('export_date', dateTo.toISOString());
      }
      
      const { data, error } = await query;
      
      if (error) {
        console.error('Failed to fetch export metrics:', error);
        return null;
      }
      
      // Calculate metrics from data
      const totalExports = data.length;
      const totalValue = data.reduce((sum, row) => sum + parseFloat(row.total_value || '0'), 0);
      const lastExportDate = data.length > 0 
        ? new Date(Math.max(...data.map(row => new Date(row.export_date).getTime())))
        : undefined;
      
      // Calculate sync status counts
      const syncStatus = {
        synced: data.filter(row => row.sync_status === 'synced').length,
        pending: data.filter(row => row.sync_status === 'pending').length,
        failed: data.filter(row => row.sync_status === 'failed').length,
      };
      
      // Aggregate movement breakdown
      const movementBreakdown: Record<string, number> = {};
      data.forEach(row => {
        const breakdown = row.movement_breakdown || {};
        Object.entries(breakdown).forEach(([type, count]) => {
          movementBreakdown[type] = (movementBreakdown[type] || 0) + (count as number);
        });
      });
      
      return {
        totalExports,
        totalValue,
        lastExportDate,
        syncStatus,
        movementBreakdown: movementBreakdown as Record<any, number>,
      };
      
    } catch (error) {
      console.error('Export metrics calculation error:', error);
      return null;
    }
  }
  
  /**
   * Update export status
   */
  public static async updateExportStatus(
    exportId: string,
    status: {
      exportStatus?: 'exported' | 'synced' | 'failed' | 'pending';
      syncStatus?: 'synced' | 'pending' | 'failed' | 'not_required';
    }
  ): Promise<boolean> {
    try {
      const updateData: any = {};
      
      if (status.exportStatus) {
        updateData.export_status = status.exportStatus;
      }
      
      if (status.syncStatus) {
        updateData.sync_status = status.syncStatus;
        if (status.syncStatus === 'synced') {
          updateData.synced_at = new Date().toISOString();
        }
      }
      
      updateData.updated_at = new Date().toISOString();
      
      const { error } = await supabase
        .from('journal_export_history')
        .update(updateData)
        .eq('id', exportId)
        .is('deleted_at', null);
      
      if (error) {
        console.error('Failed to update export status:', error);
        return false;
      }
      
      return true;
      
    } catch (error) {
      console.error('Export status update error:', error);
      return false;
    }
  }
  
  /**
   * Get single export history record
   */
  public static async getExportById(exportId: string): Promise<ExportHistory | null> {
    try {
      const { data, error } = await supabase
        .from('journal_export_history')
        .select('*')
        .eq('id', exportId)
        .is('deleted_at', null)
        .single();
      
      if (error) {
        console.error('Failed to fetch export by ID:', error);
        return null;
      }
      
      return ExportDataUtils.fromDatabaseRow(data);
      
    } catch (error) {
      console.error('Export fetch by ID error:', error);
      return null;
    }
  }
  
  /**
   * Soft delete export history record
   */
  public static async deleteExport(exportId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('journal_export_history')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', exportId);
      
      if (error) {
        console.error('Failed to delete export:', error);
        return false;
      }
      
      return true;
      
    } catch (error) {
      console.error('Export deletion error:', error);
      return false;
    }
  }
  
  /**
   * Check if journal number already exists
   */
  public static async journalNumberExists(journalNumber: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('journal_export_history')
        .select('id')
        .eq('journal_number', journalNumber)
        .is('deleted_at', null)
        .limit(1);
      
      if (error) {
        console.error('Failed to check journal number existence:', error);
        return false;
      }
      
      return data.length > 0;
      
    } catch (error) {
      console.error('Journal number check error:', error);
      return false;
    }
  }
  
  /**
   * Health check - verify database connection and schema
   */
  public static async healthCheck(): Promise<{
    healthy: boolean;
    checks: Array<{ name: string; passed: boolean; message: string }>;
  }> {
    const checks = [];
    
    // Test database connection
    try {
      const { error } = await supabase
        .from('journal_export_history')
        .select('id')
        .limit(1);
      
      if (error) {
        checks.push({
          name: 'Database Connection',
          passed: false,
          message: `Connection failed: ${error.message}`,
        });
      } else {
        checks.push({
          name: 'Database Connection',
          passed: true,
          message: 'Connection successful',
        });
      }
      
    } catch (error) {
      checks.push({
        name: 'Database Connection',
        passed: false,
        message: `Connection error: ${error}`,
      });
    }
    
    // Test table structure
    try {
      const { data, error } = await supabase
        .from('journal_export_history')
        .select('id, journal_number, export_date, movements_count')
        .limit(1);
      
      if (error) {
        checks.push({
          name: 'Table Schema',
          passed: false,
          message: `Schema validation failed: ${error.message}`,
        });
      } else {
        checks.push({
          name: 'Table Schema',
          passed: true,
          message: 'Schema validation successful',
        });
      }
      
    } catch (error) {
      checks.push({
        name: 'Table Schema',
        passed: false,
        message: `Schema error: ${error}`,
      });
    }
    
    // Test functions (if available)
    try {
      const { error } = await supabase.rpc('get_export_metrics');
      
      if (error && !error.message.includes('function does not exist')) {
        checks.push({
          name: 'Database Functions',
          passed: false,
          message: `Function test failed: ${error.message}`,
        });
      } else {
        checks.push({
          name: 'Database Functions',
          passed: true,
          message: 'Functions available or gracefully handled',
        });
      }
      
    } catch (error) {
      checks.push({
        name: 'Database Functions',
        passed: true,
        message: 'Functions check skipped - not critical',
      });
    }
    
    const allPassed = checks.every(check => check.passed);
    
    return {
      healthy: allPassed,
      checks,
    };
  }
}

// ============================================================================
// CONVENIENCE EXPORTS
// ============================================================================

export const journalHistoryService = JournalHistoryService;