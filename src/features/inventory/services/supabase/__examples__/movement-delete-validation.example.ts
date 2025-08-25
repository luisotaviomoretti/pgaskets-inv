/**
 * Examples of Movement Delete Validation Service Usage
 * Demonstrates how to use the validation service in different scenarios
 */

import {
  canDeleteReceivingMovement,
  validateBulkReceivingDelete,
  canDeleteMovementQuick,
  getReceivingConsumptionDetails
} from '../movement-delete-validation.service';

/**
 * Example 1: Single Movement Validation
 */
export async function example1_SingleMovementValidation() {
  const movementId = 123;
  
  try {
    const result = await canDeleteReceivingMovement(movementId);
    
    if (result.canDelete) {
      console.log('✅ Safe to delete:', result.reason);
      console.log('Remaining quantity:', result.totalRemaining);
    } else {
      console.log('❌ Cannot delete:', result.reason);
      console.log('Total consumed:', result.totalConsumed);
      console.log('Affected layers:', result.affectedLayers?.length);
      console.log('Work Orders affected:', result.workOrdersAffected);
      
      // Show detailed breakdown
      result.affectedLayers?.forEach((layer, index) => {
        console.log(`Layer ${index + 1}:`, {
          layerId: layer.layerId,
          skuId: layer.skuId,
          consumed: layer.consumedQuantity,
          remaining: layer.remainingQuantity,
          value: layer.consumedValue
        });
      });
    }
  } catch (error) {
    console.error('Validation failed:', error);
  }
}

/**
 * Example 2: Bulk Validation
 */
export async function example2_BulkValidation() {
  const movementIds = [101, 102, 103, 104];
  
  try {
    const result = await validateBulkReceivingDelete(movementIds);
    
    console.log('📊 Bulk Validation Summary:');
    console.log('Total movements:', result.summary.totalMovements);
    console.log('Can delete:', result.summary.allowedCount);
    console.log('Blocked:', result.summary.blockedCount);
    
    console.log('\n✅ Allowed deletions:');
    result.allowed.forEach(id => console.log(`- Movement ${id}`));
    
    console.log('\n❌ Blocked deletions:');
    result.blocked.forEach(blocked => {
      console.log(`- Movement ${blocked.movementId}: ${blocked.reason}`);
      console.log(`  Work Orders: ${blocked.workOrdersAffected.join(', ')}`);
    });
  } catch (error) {
    console.error('Bulk validation failed:', error);
  }
}

/**
 * Example 3: Quick Check (Performance Optimized)
 */
export async function example3_QuickCheck() {
  const movementId = 123;
  
  try {
    const canDelete = await canDeleteMovementQuick(movementId);
    
    if (canDelete) {
      console.log('✅ Quick check: Safe to delete');
      // Proceed with deletion
    } else {
      console.log('❌ Quick check: Cannot delete - getting details...');
      // Get full details for user feedback
      const fullResult = await canDeleteReceivingMovement(movementId);
      console.log('Reason:', fullResult.reason);
    }
  } catch (error) {
    console.error('Quick check failed:', error);
  }
}

/**
 * Example 4: Detailed Consumption Information
 */
export async function example4_DetailedConsumption() {
  const movementId = 123;
  
  try {
    const details = await getReceivingConsumptionDetails(movementId);
    
    if (!details.hasConsumptions) {
      console.log('No consumptions found - safe to delete');
      return;
    }
    
    console.log('🔍 Consumption Details:');
    console.log('Total consumed:', details.totalConsumed);
    console.log('Total value:', details.totalValue);
    console.log('Work Orders:', details.workOrdersCount);
    
    details.details.forEach((layerDetail, index) => {
      console.log(`\nLayer ${index + 1}: ${layerDetail.layer.layerId}`);
      console.log('SKU:', layerDetail.layer.skuId);
      console.log('Consumed:', layerDetail.layer.consumedQuantity);
      console.log('Value:', layerDetail.layer.consumedValue);
      
      console.log('Consumptions:');
      layerDetail.consumptions.forEach(consumption => {
        console.log(`  - WO ${consumption.workOrderId}: ${consumption.quantityConsumed} units`);
        console.log(`    Product: ${consumption.workOrderName}`);
        console.log(`    Date: ${consumption.consumedAt}`);
      });
    });
  } catch (error) {
    console.error('Failed to get consumption details:', error);
  }
}

/**
 * Example 5: Integration with UI Components
 */
export async function example5_UIIntegration() {
  // Example of how this would be used in a React component
  
  const movementId = 123;
  
  // Step 1: Quick check for initial UI state
  const canDelete = await canDeleteMovementQuick(movementId);
  
  // Update UI immediately
  const deleteButton = {
    disabled: !canDelete,
    loading: false,
    tooltip: canDelete ? 'Delete movement' : 'Cannot delete - checking details...'
  };
  
  // Step 2: If blocked, get full details for user feedback
  if (!canDelete) {
    const validation = await canDeleteReceivingMovement(movementId);
    
    // Update UI with detailed feedback
    const errorModal = {
      show: true,
      title: 'Cannot Delete Movement',
      message: validation.reason,
      details: {
        consumedLayers: validation.affectedLayers?.length || 0,
        totalConsumed: validation.totalConsumed || 0,
        workOrders: validation.workOrdersAffected || []
      }
    };
    
    console.log('Show error modal:', errorModal);
  }
}

/**
 * Example 6: Error Handling Patterns
 */
export async function example6_ErrorHandling() {
  const movementId = 999; // Non-existent movement
  
  try {
    const result = await canDeleteReceivingMovement(movementId);
    
    // Handle different validation outcomes
    switch (true) {
      case result.canDelete && result.reason?.includes('No FIFO layers'):
        console.log('Safe: Movement has no inventory impact');
        break;
        
      case result.canDelete && result.totalRemaining !== undefined:
        console.log('Safe: All inventory is unconsumed');
        break;
        
      case !result.canDelete && result.reason?.includes('not found'):
        console.log('Error: Movement does not exist');
        break;
        
      case !result.canDelete && result.workOrdersAffected?.length:
        console.log('Blocked: Active Work Orders depend on this inventory');
        break;
        
      default:
        console.log('Unknown validation state:', result);
    }
    
  } catch (error) {
    // Handle service errors
    if (error instanceof Error) {
      if (error.message.includes('Cannot delete movement')) {
        console.log('Business rule violation:', error.message);
      } else {
        console.log('Technical error:', error.message);
      }
    }
  }
}

/**
 * Example 7: Performance Monitoring
 */
export async function example7_PerformanceMonitoring() {
  const movementIds = [101, 102, 103];
  
  // Measure validation performance
  const start = performance.now();
  
  try {
    const results = await Promise.all(
      movementIds.map(async (id) => {
        const startSingle = performance.now();
        const result = await canDeleteMovementQuick(id);
        const endSingle = performance.now();
        
        return {
          movementId: id,
          canDelete: result,
          duration: endSingle - startSingle
        };
      })
    );
    
    const end = performance.now();
    
    console.log('⚡ Performance Results:');
    console.log('Total time:', end - start, 'ms');
    console.log('Average per movement:', (end - start) / movementIds.length, 'ms');
    
    results.forEach(result => {
      console.log(`Movement ${result.movementId}: ${result.duration.toFixed(2)}ms`);
    });
    
  } catch (error) {
    console.error('Performance test failed:', error);
  }
}

// Export all examples for easy testing
export const examples = {
  singleValidation: example1_SingleMovementValidation,
  bulkValidation: example2_BulkValidation,
  quickCheck: example3_QuickCheck,
  detailedConsumption: example4_DetailedConsumption,
  uiIntegration: example5_UIIntegration,
  errorHandling: example6_ErrorHandling,
  performanceMonitoring: example7_PerformanceMonitoring
};

/**
 * Run all examples (for testing purposes)
 */
export async function runAllExamples() {
  const exampleNames = Object.keys(examples) as Array<keyof typeof examples>;
  
  for (const name of exampleNames) {
    console.log(`\n🔥 Running ${name}...`);
    try {
      await examples[name]();
      console.log(`✅ ${name} completed`);
    } catch (error) {
      console.log(`❌ ${name} failed:`, error);
    }
  }
}