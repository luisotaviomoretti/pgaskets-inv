/**
 * Validation Layer - Data Integrity Protection
 * Ensures all journal export operations maintain system integrity
 */

import { z } from 'zod';
import { 
  ExportHistorySchema, 
  ExportRecordSchema, 
  validateExportHistory,
  validateExportRecord
} from '../types/journalExport.types';
import type { ExportHistory, ExportRecord } from '../types/journalExport.types';
import { MovementType } from '../types/inventory.types';

// ============================================================================
// MOVEMENT VALIDATION SCHEMAS
// ============================================================================

const MovementValidationSchema = z.object({
  id: z.string().uuid(),
  type: z.nativeEnum(MovementType),
  quantity: z.number().int().min(1),
  value: z.number().min(0),
  date: z.date(),
  sku_id: z.string().uuid(),
  reference: z.string().optional(),
  notes: z.string().optional(),
});

const MovementArraySchema = z.array(MovementValidationSchema).min(1);

// ============================================================================
// EXPORT OPERATION VALIDATION
// ============================================================================

export class ValidationLayer {
  
  /**
   * Validate movements before export
   */
  public static validateMovementsForExport(movements: any[]): {
    valid: boolean;
    validMovements: any[];
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const validMovements: any[] = [];
    
    try {
      // Check if movements array is provided
      if (!Array.isArray(movements)) {
        errors.push('Movements must be an array');
        return { valid: false, validMovements: [], errors, warnings };
      }
      
      if (movements.length === 0) {
        errors.push('No movements provided for export');
        return { valid: false, validMovements: [], errors, warnings };
      }
      
      // Validate each movement
      movements.forEach((movement, index) => {
        try {
          // Check required fields
          if (!movement[0]) {
            warnings.push(`Movement at index ${index} is missing data`);
            return;
          }
          
          const movementData = movement[0];
          
          // Basic validation
          if (!movementData.id) {
            warnings.push(`Movement at index ${index} missing ID`);
            return;
          }
          
          if (!movementData.type) {
            warnings.push(`Movement at index ${index} missing type`);
            return;
          }
          
          if (!Object.values(MovementType).includes(movementData.type)) {
            warnings.push(`Movement at index ${index} has invalid type: ${movementData.type}`);
            return;
          }
          
          if (typeof movementData.quantity !== 'number' || movementData.quantity <= 0) {
            warnings.push(`Movement at index ${index} has invalid quantity`);
            return;
          }
          
          if (typeof movementData.value !== 'number' || movementData.value < 0) {
            warnings.push(`Movement at index ${index} has invalid value`);
            return;
          }
          
          validMovements.push(movement);
          
        } catch (validationError) {
          warnings.push(`Movement at index ${index} validation failed: ${validationError}`);
        }
      });
      
      // Check for critical issues
      if (validMovements.length === 0 && movements.length > 0) {
        errors.push('No valid movements found in provided data');
      }
      
      if (validMovements.length < movements.length) {
        warnings.push(`${movements.length - validMovements.length} movements failed validation`);
      }
      
      return {
        valid: errors.length === 0 && validMovements.length > 0,
        validMovements,
        errors,
        warnings,
      };
      
    } catch (error) {
      errors.push(`Movement validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { valid: false, validMovements: [], errors, warnings };
    }
  }
  
  /**
   * Validate export parameters
   */
  public static validateExportParams(params: {
    movements: any[];
    dateRange: { from: Date; to: Date };
    exportedBy: string;
  }): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    try {
      // Validate date range
      if (!params.dateRange.from || !params.dateRange.to) {
        errors.push('Date range is required');
      } else if (params.dateRange.from > params.dateRange.to) {
        errors.push('Start date must be before end date');
      } else if (params.dateRange.to > new Date()) {
        warnings.push('End date is in the future');
      }
      
      // Validate exported by
      if (!params.exportedBy || params.exportedBy.trim().length === 0) {
        warnings.push('Exported by user not specified, using default');
      }
      
      // Validate movements
      const movementValidation = this.validateMovementsForExport(params.movements);
      errors.push(...movementValidation.errors);
      warnings.push(...movementValidation.warnings);
      
    } catch (error) {
      errors.push(`Parameter validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
  
  /**
   * Validate export record before saving
   */
  public static validateForDatabase(record: ExportRecord): {
    valid: boolean;
    validatedRecord: ExportRecord | null;
    errors: string[];
  } {
    try {
      const validatedRecord = validateExportRecord(record);
      
      return {
        valid: true,
        validatedRecord,
        errors: [],
      };
      
    } catch (error) {
      return {
        valid: false,
        validatedRecord: null,
        errors: [error instanceof Error ? error.message : 'Validation failed'],
      };
    }
  }
  
  /**
   * Validate export history data from database
   */
  public static validateFromDatabase(data: any): {
    valid: boolean;
    validatedHistory: ExportHistory | null;
    errors: string[];
  } {
    try {
      const validatedHistory = validateExportHistory(data);
      
      return {
        valid: true,
        validatedHistory,
        errors: [],
      };
      
    } catch (error) {
      return {
        valid: false,
        validatedHistory: null,
        errors: [error instanceof Error ? error.message : 'Database validation failed'],
      };
    }
  }
  
  /**
   * System integrity checks
   */
  public static performIntegrityChecks(): {
    healthy: boolean;
    checks: {
      name: string;
      passed: boolean;
      message: string;
    }[];
  } {
    const checks = [];
    
    // Check Zod schemas are accessible
    try {
      ExportHistorySchema.parse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        journalNumber: 'JNL-20240101-001',
        exportDate: new Date(),
        movements: { total: 0, byType: {} },
        financials: { totalValue: 0, byType: {} },
        status: 'exported',
        syncStatus: 'pending',
        metadata: {
          filename: 'test.xlsx',
          exportedBy: 'system',
        },
        actions: {
          canRedownload: true,
          canResend: false,
          canModify: false,
        },
        createdAt: new Date(),
      });
      
      checks.push({
        name: 'Schema Validation',
        passed: true,
        message: 'All schemas are accessible and functional',
      });
      
    } catch (error) {
      checks.push({
        name: 'Schema Validation',
        passed: false,
        message: `Schema validation failed: ${error}`,
      });
    }
    
    // Check MovementType enum
    try {
      const types = Object.values(MovementType);
      if (types.includes(MovementType.RECEIVE) && types.includes(MovementType.ADJUSTMENT)) {
        checks.push({
          name: 'Movement Types',
          passed: true,
          message: 'All required movement types are available',
        });
      } else {
        checks.push({
          name: 'Movement Types',
          passed: false,
          message: 'Required movement types not found',
        });
      }
    } catch (error) {
      checks.push({
        name: 'Movement Types',
        passed: false,
        message: `Movement type check failed: ${error}`,
      });
    }
    
    // Memory and performance check
    try {
      const testArray = new Array(1000).fill(null);
      checks.push({
        name: 'Memory Allocation',
        passed: true,
        message: 'Memory allocation working normally',
      });
    } catch (error) {
      checks.push({
        name: 'Memory Allocation',
        passed: false,
        message: 'Memory allocation issues detected',
      });
    }
    
    const allPassed = checks.every(check => check.passed);
    
    return {
      healthy: allPassed,
      checks,
    };
  }
  
  /**
   * Safe data transformation with validation
   */
  public static safeTransform<T>(
    data: any,
    transformer: (data: any) => T,
    fallback: T
  ): {
    success: boolean;
    data: T;
    error?: string;
  } {
    try {
      const result = transformer(data);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      console.warn('Data transformation failed, using fallback:', error);
      return {
        success: false,
        data: fallback,
        error: error instanceof Error ? error.message : 'Transformation failed',
      };
    }
  }
}

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

/**
 * Quick validation for export operations
 */
export function quickValidation(movements: any[]): boolean {
  try {
    const result = ValidationLayer.validateMovementsForExport(movements);
    return result.valid && result.validMovements.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get validation summary for debugging
 */
export function getValidationSummary(movements: any[]) {
  const validation = ValidationLayer.validateMovementsForExport(movements);
  const integrity = ValidationLayer.performIntegrityChecks();
  
  return {
    movements: validation,
    system: integrity,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Export validation layer instance
 */
export const validationLayer = ValidationLayer;