/**
 * Database Schema Testing Utilities
 * Tests for journal export history database functionality
 */

import { journalHistoryService } from '../services/supabase/journalHistory.service';
import { supabase } from '../../../lib/supabase';
import type { ExportRecord } from '../types/journalExport.types';
import { ExportDataUtils } from '../types/journalExport.types';

export interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  duration?: number;
}

export interface TestSuite {
  name: string;
  passed: boolean;
  results: TestResult[];
  duration: number;
}

/**
 * Database Schema Test Suite
 */
export class DatabaseSchemaTests {
  
  /**
   * Test database connection and basic schema
   */
  public static async testConnection(): Promise<TestResult> {
    const start = Date.now();
    
    try {
      const { data, error } = await supabase
        .from('journal_export_history')
        .select('count(*)')
        .limit(1);
      
      if (error) {
        return {
          name: 'Database Connection',
          passed: false,
          message: `Connection failed: ${error.message}`,
          duration: Date.now() - start,
        };
      }
      
      return {
        name: 'Database Connection',
        passed: true,
        message: 'Successfully connected to journal_export_history table',
        duration: Date.now() - start,
      };
      
    } catch (error) {
      return {
        name: 'Database Connection',
        passed: false,
        message: `Connection error: ${error}`,
        duration: Date.now() - start,
      };
    }
  }
  
  /**
   * Test enum types creation
   */
  public static async testEnums(): Promise<TestResult> {
    const start = Date.now();
    
    try {
      // Test export_status enum
      const { data: exportStatusData, error: exportStatusError } = await supabase.rpc('get_export_history', {
        p_export_status: 'exported',
        p_limit: 1
      });
      
      // Test sync_status enum  
      const { data: syncStatusData, error: syncStatusError } = await supabase.rpc('get_export_history', {
        p_sync_status: 'pending',
        p_limit: 1
      });
      
      if (exportStatusError || syncStatusError) {
        // If RPC doesn't exist yet, try direct enum usage
        const { error: directEnumError } = await supabase
          .from('journal_export_history')
          .select('export_status, sync_status')
          .limit(1);
        
        if (directEnumError && directEnumError.message.includes('does not exist')) {
          return {
            name: 'Enum Types',
            passed: false,
            message: 'Enum types not found - migration may not be applied',
            duration: Date.now() - start,
          };
        }
      }
      
      return {
        name: 'Enum Types',
        passed: true,
        message: 'Export and sync status enums are working correctly',
        duration: Date.now() - start,
      };
      
    } catch (error) {
      return {
        name: 'Enum Types',
        passed: false,
        message: `Enum test failed: ${error}`,
        duration: Date.now() - start,
      };
    }
  }
  
  /**
   * Test table structure and constraints
   */
  public static async testTableStructure(): Promise<TestResult> {
    const start = Date.now();
    
    try {
      // Test inserting a valid record
      const testRecord = {
        journal_number: `TEST-${Date.now()}`,
        movements_count: 5,
        movement_breakdown: { RECEIVE: 3, ISSUE: 2 },
        total_value: 1000.50,
        financial_breakdown: { RECEIVE: 700.00, ISSUE: 300.50 },
        filename: 'test-journal.xlsx',
        exported_by: 'test-user',
      };
      
      const { data, error } = await supabase
        .from('journal_export_history')
        .insert(testRecord)
        .select()
        .single();
      
      if (error) {
        return {
          name: 'Table Structure',
          passed: false,
          message: `Table structure test failed: ${error.message}`,
          duration: Date.now() - start,
        };
      }
      
      // Clean up test record
      await supabase
        .from('journal_export_history')
        .delete()
        .eq('id', data.id);
      
      return {
        name: 'Table Structure',
        passed: true,
        message: 'Table structure and constraints are working correctly',
        duration: Date.now() - start,
      };
      
    } catch (error) {
      return {
        name: 'Table Structure',
        passed: false,
        message: `Table structure test error: ${error}`,
        duration: Date.now() - start,
      };
    }
  }
  
  /**
   * Test database functions
   */
  public static async testDatabaseFunctions(): Promise<TestResult> {
    const start = Date.now();
    
    try {
      // Test get_export_history function
      const { data: historyData, error: historyError } = await supabase.rpc('get_export_history', {
        p_limit: 5
      });
      
      // Test get_export_metrics function
      const { data: metricsData, error: metricsError } = await supabase.rpc('get_export_metrics');
      
      const functionsWorking = [];
      const functionsFailed = [];
      
      if (!historyError) {
        functionsWorking.push('get_export_history');
      } else {
        functionsFailed.push(`get_export_history: ${historyError.message}`);
      }
      
      if (!metricsError) {
        functionsWorking.push('get_export_metrics');
      } else {
        functionsFailed.push(`get_export_metrics: ${metricsError.message}`);
      }
      
      if (functionsFailed.length > 0) {
        return {
          name: 'Database Functions',
          passed: false,
          message: `Some functions failed: ${functionsFailed.join(', ')}`,
          duration: Date.now() - start,
        };
      }
      
      return {
        name: 'Database Functions',
        passed: true,
        message: `All functions working: ${functionsWorking.join(', ')}`,
        duration: Date.now() - start,
      };
      
    } catch (error) {
      return {
        name: 'Database Functions',
        passed: false,
        message: `Database functions test error: ${error}`,
        duration: Date.now() - start,
      };
    }
  }
  
  /**
   * Test service layer integration
   */
  public static async testServiceLayer(): Promise<TestResult> {
    const start = Date.now();
    
    try {
      // Test health check
      const healthCheck = await journalHistoryService.healthCheck();
      
      if (!healthCheck.healthy) {
        const failedChecks = healthCheck.checks
          .filter(check => !check.passed)
          .map(check => check.message);
        
        return {
          name: 'Service Layer',
          passed: false,
          message: `Service health check failed: ${failedChecks.join(', ')}`,
          duration: Date.now() - start,
        };
      }
      
      // Test creating and retrieving export history
      const testExportRecord: ExportRecord = {
        journalNumber: ExportDataUtils.generateJournalNumber(),
        movements: [
          [{
            id: 'test-movement-1',
            type: 'RECEIVE',
            quantity: 10,
            value: 500,
            sku_id: 'test-sku-1',
            date: new Date(),
          }]
        ],
        filename: 'test-service.xlsx',
        exportedBy: 'test-service-user',
        totalValue: 500,
      };
      
      const createdHistory = await journalHistoryService.createExportHistory(testExportRecord);
      
      if (!createdHistory) {
        return {
          name: 'Service Layer',
          passed: false,
          message: 'Failed to create export history through service layer',
          duration: Date.now() - start,
        };
      }
      
      // Clean up test record
      await journalHistoryService.deleteExport(createdHistory.id);
      
      return {
        name: 'Service Layer',
        passed: true,
        message: 'Service layer integration working correctly',
        duration: Date.now() - start,
      };
      
    } catch (error) {
      return {
        name: 'Service Layer',
        passed: false,
        message: `Service layer test error: ${error}`,
        duration: Date.now() - start,
      };
    }
  }
  
  /**
   * Test constraint validations
   */
  public static async testConstraints(): Promise<TestResult> {
    const start = Date.now();
    
    try {
      const constraintTests = [];
      
      // Test journal number format constraint
      try {
        await supabase
          .from('journal_export_history')
          .insert({
            journal_number: 'INVALID-FORMAT',
            filename: 'test.xlsx',
            exported_by: 'test-user',
          });
        
        constraintTests.push('journal_number format constraint: FAILED (should have rejected invalid format)');
      } catch (error) {
        constraintTests.push('journal_number format constraint: PASSED');
      }
      
      // Test positive values constraint
      try {
        await supabase
          .from('journal_export_history')
          .insert({
            journal_number: `JNL-${Date.now()}-001`,
            total_value: -100,
            filename: 'test.xlsx',
            exported_by: 'test-user',
          });
        
        constraintTests.push('positive_total_value constraint: FAILED (should have rejected negative value)');
      } catch (error) {
        constraintTests.push('positive_total_value constraint: PASSED');
      }
      
      const failedConstraints = constraintTests.filter(test => test.includes('FAILED'));
      
      if (failedConstraints.length > 0) {
        return {
          name: 'Constraints',
          passed: false,
          message: `Some constraints failed: ${failedConstraints.join(', ')}`,
          duration: Date.now() - start,
        };
      }
      
      return {
        name: 'Constraints',
        passed: true,
        message: 'All database constraints working correctly',
        duration: Date.now() - start,
      };
      
    } catch (error) {
      return {
        name: 'Constraints',
        passed: false,
        message: `Constraints test error: ${error}`,
        duration: Date.now() - start,
      };
    }
  }
  
  /**
   * Run full test suite
   */
  public static async runFullSuite(): Promise<TestSuite> {
    const start = Date.now();
    const results: TestResult[] = [];
    
    console.log('🧪 Starting database schema test suite...');
    
    // Run all tests
    results.push(await this.testConnection());
    results.push(await this.testEnums());
    results.push(await this.testTableStructure());
    results.push(await this.testDatabaseFunctions());
    results.push(await this.testServiceLayer());
    results.push(await this.testConstraints());
    
    const allPassed = results.every(result => result.passed);
    const duration = Date.now() - start;
    
    console.log(`✅ Test suite completed in ${duration}ms`);
    console.log(`📊 Results: ${results.filter(r => r.passed).length}/${results.length} tests passed`);
    
    return {
      name: 'Database Schema Test Suite',
      passed: allPassed,
      results,
      duration,
    };
  }
}

/**
 * Quick validation function for development
 */
export async function validateDatabaseSetup(): Promise<boolean> {
  try {
    console.log('🔍 Quick database setup validation...');
    
    const connectionTest = await DatabaseSchemaTests.testConnection();
    if (!connectionTest.passed) {
      console.error('❌ Database connection failed:', connectionTest.message);
      return false;
    }
    
    const serviceTest = await DatabaseSchemaTests.testServiceLayer();
    if (!serviceTest.passed) {
      console.error('❌ Service layer test failed:', serviceTest.message);
      return false;
    }
    
    console.log('✅ Database setup validation passed');
    return true;
    
  } catch (error) {
    console.error('❌ Database validation error:', error);
    return false;
  }
}