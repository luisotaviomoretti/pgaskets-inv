/**
 * Database Testing Script
 * Run this after applying the migration to validate everything works
 */

import { DatabaseSchemaTests } from '../utils/testDatabaseSchema';

/**
 * Main test runner
 */
async function runDatabaseTests() {
  console.log('\n🚀 PHASE 1: DATABASE MIGRATION TESTING');
  console.log('=====================================\n');
  
  try {
    // Run full test suite
    const testSuite = await DatabaseSchemaTests.runFullSuite();
    
    console.log('\n📋 TEST RESULTS:');
    console.log('================');
    
    testSuite.results.forEach(result => {
      const status = result.passed ? '✅' : '❌';
      const duration = result.duration ? ` (${result.duration}ms)` : '';
      console.log(`${status} ${result.name}${duration}`);
      
      if (!result.passed) {
        console.log(`   └─ ${result.message}`);
      }
    });
    
    console.log(`\n📊 SUMMARY: ${testSuite.results.filter(r => r.passed).length}/${testSuite.results.length} tests passed`);
    console.log(`⏱️  Total time: ${testSuite.duration}ms`);
    
    if (testSuite.passed) {
      console.log('\n🎉 ALL TESTS PASSED! Database is ready for Phase 2.');
      console.log('\n📝 Next steps:');
      console.log('1. Enable JOURNAL_HISTORY_TRACKING feature flag');
      console.log('2. Test journal export functionality');
      console.log('3. Verify data integrity');
    } else {
      console.log('\n⚠️  SOME TESTS FAILED. Please check migration and try again.');
      
      const criticalFailures = testSuite.results.filter(r => 
        !r.passed && ['Database Connection', 'Table Structure'].includes(r.name)
      );
      
      if (criticalFailures.length > 0) {
        console.log('\n🚨 CRITICAL FAILURES DETECTED:');
        criticalFailures.forEach(failure => {
          console.log(`   - ${failure.name}: ${failure.message}`);
        });
        console.log('\n💡 Migration may not be applied correctly. Check Supabase SQL Editor.');
      }
    }
    
    return testSuite.passed;
    
  } catch (error) {
    console.error('\n❌ Test runner failed:', error);
    console.log('\n🔧 Troubleshooting:');
    console.log('1. Ensure you are connected to the internet');
    console.log('2. Verify Supabase connection settings');
    console.log('3. Check if migration was applied successfully');
    return false;
  }
}

/**
 * Quick health check
 */
async function quickHealthCheck() {
  console.log('\n🏥 QUICK HEALTH CHECK');
  console.log('====================\n');
  
  try {
    const connectionTest = await DatabaseSchemaTests.testConnection();
    const serviceTest = await DatabaseSchemaTests.testServiceLayer();
    
    if (connectionTest.passed && serviceTest.passed) {
      console.log('✅ Database is healthy and ready!');
      return true;
    } else {
      console.log('❌ Database health check failed');
      if (!connectionTest.passed) {
        console.log(`   Connection: ${connectionTest.message}`);
      }
      if (!serviceTest.passed) {
        console.log(`   Service: ${serviceTest.message}`);
      }
      return false;
    }
    
  } catch (error) {
    console.error('❌ Health check error:', error);
    return false;
  }
}

// Command line interface
if (typeof window === 'undefined') {
  // Node.js environment
  const args = process.argv.slice(2);
  
  if (args.includes('--quick') || args.includes('-q')) {
    quickHealthCheck()
      .then(success => process.exit(success ? 0 : 1))
      .catch(() => process.exit(1));
  } else {
    runDatabaseTests()
      .then(success => process.exit(success ? 0 : 1))
      .catch(() => process.exit(1));
  }
} else {
  // Browser environment - expose to window for manual testing
  (window as any).__databaseTests = {
    runFullSuite: runDatabaseTests,
    quickCheck: quickHealthCheck,
    individual: DatabaseSchemaTests,
  };
  
  console.log('🛠️  Database testing tools available at window.__databaseTests');
  console.log('   - runFullSuite(): Run all tests');
  console.log('   - quickCheck(): Quick health check');
  console.log('   - individual: Access individual test methods');
}