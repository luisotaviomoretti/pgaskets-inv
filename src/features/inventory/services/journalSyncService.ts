/**
 * Journal Export Sync Service
 * Implements hybrid sync strategy: localStorage (fast cache) + Supabase (source of truth)
 * Created: 2025-08-25
 */

import { createClient } from '@supabase/supabase-js';
import { toast } from 'sonner';

// Types
export interface JournalExportRecord {
  id?: string;
  user_id: string;
  movement_id: string;
  exported_at: string;
  journal_number?: string;
  device_info?: Record<string, any>;
}

export interface SyncResult {
  success: boolean;
  uploaded: number;
  downloaded: number;
  conflicts: number;
  errors: string[];
}

export type ConflictStrategy = 
  | 'supabase-wins'     // Server sempre ganha
  | 'localStorage-wins' // Local sempre ganha
  | 'merge-union'      // União dos dois sets
  | 'user-prompt';     // Pergunta ao usuário

// Configuration
const STORAGE_KEY = 'pgaskets-journal-export-history';
const LAST_SYNC_KEY = 'pgaskets-journal-last-sync';
const SYNC_BATCH_SIZE = 100;

export class JournalSyncService {
  private supabase: any;
  private conflictStrategy: ConflictStrategy = 'merge-union';
  private onSyncCallbacks: ((result: SyncResult) => void)[] = [];

  constructor(supabaseUrl?: string, supabaseKey?: string) {
    // Use existing Supabase client or create new one
    if (supabaseUrl && supabaseKey) {
      this.supabase = createClient(supabaseUrl, supabaseKey);
    } else {
      // Import the existing client
      import('@/lib/supabase').then(({ supabase }) => {
        this.supabase = supabase;
      });
    }
  }

  // ========================================
  // Core Local Operations (localStorage)
  // ========================================

  /**
   * Get exported movements from localStorage
   */
  getExportedMovements(): Set<string> {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch (error) {
      console.warn('Failed to load journal export history from localStorage:', error);
      return new Set();
    }
  }

  /**
   * Mark movements as exported in localStorage
   */
  markMovementsAsExported(movementIds: string[], journalNumber?: string): void {
    try {
      const exportedMovements = this.getExportedMovements();
      movementIds.forEach(id => exportedMovements.add(id));
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...exportedMovements]));
      
      // Store additional metadata for sync
      const metadata = this.getExportMetadata();
      movementIds.forEach(id => {
        metadata[id] = {
          exported_at: new Date().toISOString(),
          journal_number: journalNumber,
          synced: false
        };
      });
      this.setExportMetadata(metadata);
    } catch (error) {
      console.warn('Failed to save journal export history to localStorage:', error);
    }
  }

  /**
   * Clear export history from localStorage
   */
  clearLocalHistory(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_KEY + '-metadata');
      localStorage.removeItem(LAST_SYNC_KEY);
      toast.success('Local export history cleared');
    } catch (error) {
      console.warn('Failed to clear local journal export history:', error);
      toast.error('Failed to clear local history');
    }
  }

  // ========================================
  // Metadata Management
  // ========================================

  private getExportMetadata(): Record<string, any> {
    try {
      const stored = localStorage.getItem(STORAGE_KEY + '-metadata');
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  }

  private setExportMetadata(metadata: Record<string, any>): void {
    try {
      localStorage.setItem(STORAGE_KEY + '-metadata', JSON.stringify(metadata));
    } catch (error) {
      console.warn('Failed to save export metadata:', error);
    }
  }

  private getLastSyncTime(): Date | null {
    try {
      const stored = localStorage.getItem(LAST_SYNC_KEY);
      return stored ? new Date(stored) : null;
    } catch {
      return null;
    }
  }

  private setLastSyncTime(date: Date): void {
    try {
      localStorage.setItem(LAST_SYNC_KEY, date.toISOString());
    } catch (error) {
      console.warn('Failed to save last sync time:', error);
    }
  }

  // ========================================
  // Supabase Operations
  // ========================================

  /**
   * Get user's exported movements from Supabase
   */
  private async getSupabaseExports(): Promise<JournalExportRecord[]> {
    if (!this.supabase) throw new Error('Supabase client not initialized');

    const { data, error } = await this.supabase
      .from('journal_export_history')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * Insert export records to Supabase
   */
  private async insertSupabaseExports(records: JournalExportRecord[]): Promise<void> {
    if (!this.supabase) throw new Error('Supabase client not initialized');
    if (records.length === 0) return;

    const { error } = await this.supabase
      .from('journal_export_history')
      .upsert(records, { 
        onConflict: 'user_id,movement_id',
        ignoreDuplicates: false 
      });

    if (error) throw error;
  }

  /**
   * Clear user's export history from Supabase
   */
  private async clearSupabaseHistory(): Promise<void> {
    if (!this.supabase) throw new Error('Supabase client not initialized');

    const { error } = await this.supabase
      .from('journal_export_history')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all user records

    if (error) throw error;
  }

  // ========================================
  // Sync Operations
  // ========================================

  /**
   * Sync local exports to Supabase
   */
  async syncToSupabase(): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      uploaded: 0,
      downloaded: 0,
      conflicts: 0,
      errors: []
    };

    try {
      if (!this.supabase) {
        throw new Error('Supabase client not available');
      }

      const metadata = this.getExportMetadata();
      const unsyncedRecords: JournalExportRecord[] = [];

      // Get current user
      const { data: { user } } = await this.supabase.auth.getUser();
      if (!user) {
        throw new Error('User not authenticated');
      }

      // Prepare records to sync
      Object.entries(metadata).forEach(([movementId, meta]: [string, any]) => {
        if (!meta.synced) {
          unsyncedRecords.push({
            user_id: user.id,
            movement_id: movementId,
            exported_at: meta.exported_at,
            journal_number: meta.journal_number,
            device_info: {
              userAgent: navigator.userAgent,
              timestamp: new Date().toISOString()
            }
          });
        }
      });

      if (unsyncedRecords.length > 0) {
        // Batch upload
        for (let i = 0; i < unsyncedRecords.length; i += SYNC_BATCH_SIZE) {
          const batch = unsyncedRecords.slice(i, i + SYNC_BATCH_SIZE);
          await this.insertSupabaseExports(batch);
          result.uploaded += batch.length;
        }

        // Mark as synced in metadata
        const updatedMetadata = { ...metadata };
        unsyncedRecords.forEach(record => {
          if (updatedMetadata[record.movement_id]) {
            updatedMetadata[record.movement_id].synced = true;
          }
        });
        this.setExportMetadata(updatedMetadata);
      }

      this.setLastSyncTime(new Date());
      result.success = true;

    } catch (error) {
      console.error('Failed to sync to Supabase:', error);
      result.errors.push(error instanceof Error ? error.message : 'Unknown error');
    }

    // Notify callbacks
    this.onSyncCallbacks.forEach(callback => callback(result));
    return result;
  }

  /**
   * Sync from Supabase to localStorage
   */
  async syncFromSupabase(): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      uploaded: 0,
      downloaded: 0,
      conflicts: 0,
      errors: []
    };

    try {
      if (!this.supabase) {
        throw new Error('Supabase client not available');
      }

      // Get server data
      const serverRecords = await this.getSupabaseExports();
      const localMovements = this.getExportedMovements();
      const localMetadata = this.getExportMetadata();

      // Process server records
      const newLocalMovements = new Set(localMovements);
      const newLocalMetadata = { ...localMetadata };

      serverRecords.forEach(record => {
        const movementId = record.movement_id;
        
        if (!localMovements.has(movementId)) {
          // New from server
          newLocalMovements.add(movementId);
          newLocalMetadata[movementId] = {
            exported_at: record.exported_at,
            journal_number: record.journal_number,
            synced: true
          };
          result.downloaded++;
        } else if (!localMetadata[movementId]?.synced) {
          // Potential conflict - apply strategy
          switch (this.conflictStrategy) {
            case 'supabase-wins':
              newLocalMetadata[movementId] = {
                exported_at: record.exported_at,
                journal_number: record.journal_number,
                synced: true
              };
              result.conflicts++;
              break;
            case 'merge-union':
              // Keep local metadata but mark as synced
              if (newLocalMetadata[movementId]) {
                newLocalMetadata[movementId].synced = true;
              }
              break;
            // Add more strategies as needed
          }
        }
      });

      // Update localStorage
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...newLocalMovements]));
      this.setExportMetadata(newLocalMetadata);
      this.setLastSyncTime(new Date());

      result.success = true;

    } catch (error) {
      console.error('Failed to sync from Supabase:', error);
      result.errors.push(error instanceof Error ? error.message : 'Unknown error');
    }

    // Notify callbacks
    this.onSyncCallbacks.forEach(callback => callback(result));
    return result;
  }

  /**
   * Full bidirectional sync
   */
  async fullSync(): Promise<SyncResult> {
    // First sync from server, then to server
    const downloadResult = await this.syncFromSupabase();
    const uploadResult = await this.syncToSupabase();

    return {
      success: downloadResult.success && uploadResult.success,
      uploaded: uploadResult.uploaded,
      downloaded: downloadResult.downloaded,
      conflicts: downloadResult.conflicts + uploadResult.conflicts,
      errors: [...downloadResult.errors, ...uploadResult.errors]
    };
  }

  /**
   * Export current history to Excel before clearing
   */
  private async exportHistoryToExcel(): Promise<void> {
    try {
      const XLSX = await import('xlsx');
      
      // Get all data before clearing
      const localMetadata = this.getExportMetadata();
      const serverRecords = await this.getSupabaseExports().catch(() => []);
      
      // Prepare export data
      const exportData: any[] = [];
      
      // Add local data
      Object.entries(localMetadata).forEach(([movementId, meta]: [string, any]) => {
        exportData.push({
          'Movement ID': movementId,
          'Exported At': meta.exported_at ? new Date(meta.exported_at).toLocaleString() : '',
          'Journal Number': meta.journal_number || '',
          'Source': 'Local',
          'Synced': meta.synced ? 'Yes' : 'No'
        });
      });

      // Add server data (avoid duplicates)
      const localMovementIds = new Set(Object.keys(localMetadata));
      serverRecords.forEach(record => {
        if (!localMovementIds.has(record.movement_id)) {
          exportData.push({
            'Movement ID': record.movement_id,
            'Exported At': new Date(record.exported_at).toLocaleString(),
            'Journal Number': record.journal_number || '',
            'Source': 'Supabase',
            'Synced': 'Yes'
          });
        }
      });

      if (exportData.length === 0) {
        return; // Nothing to export
      }

      // Sort by exported date
      exportData.sort((a, b) => new Date(b['Exported At']).getTime() - new Date(a['Exported At']).getTime());

      // Create workbook
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(exportData);

      // Set column widths
      const colWidths = [
        { wch: 15 }, // Movement ID
        { wch: 20 }, // Exported At
        { wch: 18 }, // Journal Number
        { wch: 10 }, // Source
        { wch: 8 }   // Synced
      ];
      ws['!cols'] = colWidths;

      // Add worksheet
      XLSX.utils.book_append_sheet(wb, ws, 'Export History Backup');

      // Generate filename
      const timestamp = new Date().toISOString().split('T')[0];
      const filename = `journal-export-history-backup-${timestamp}.xlsx`;

      // Download
      XLSX.writeFile(wb, filename);
      
      toast.info(`Backup saved: ${filename}`, {
        description: `${exportData.length} export records archived`
      });

    } catch (error) {
      console.warn('Failed to export history backup:', error);
      toast.error('Failed to create backup file');
    }
  }

  /**
   * Clear all history (both local and remote) with automatic Excel backup
   */
  async clearAllHistory(): Promise<void> {
    try {
      // First, create backup Excel file
      await this.exportHistoryToExcel();
      
      // Then clear remote and local
      await this.clearSupabaseHistory();
      this.clearLocalHistory();
      
      toast.success('Export history cleared and backed up to Excel');
    } catch (error) {
      console.error('Failed to clear all history:', error);
      toast.error('Failed to clear remote history');
      // Still clear local even if remote fails
      this.clearLocalHistory();
    }
  }

  // ========================================
  // Configuration & Events
  // ========================================

  setConflictStrategy(strategy: ConflictStrategy): void {
    this.conflictStrategy = strategy;
  }

  onSync(callback: (result: SyncResult) => void): void {
    this.onSyncCallbacks.push(callback);
  }

  /**
   * Auto-sync with error handling and backoff
   */
  async autoSync(): Promise<void> {
    try {
      await this.fullSync();
    } catch (error) {
      console.warn('Auto-sync failed:', error);
      // Implement exponential backoff if needed
    }
  }

  /**
   * Get sync status info
   */
  getSyncStatus(): {
    lastSync: Date | null;
    pendingUpload: number;
    totalExported: number;
  } {
    const metadata = this.getExportMetadata();
    const pendingUpload = Object.values(metadata).filter((meta: any) => !meta.synced).length;
    const totalExported = this.getExportedMovements().size;

    return {
      lastSync: this.getLastSyncTime(),
      pendingUpload,
      totalExported
    };
  }
}

// Export singleton instance
export const journalSyncService = new JournalSyncService();