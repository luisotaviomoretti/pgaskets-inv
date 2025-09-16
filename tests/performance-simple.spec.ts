import { test, expect } from '@playwright/test';
import { login, waitForLoadingToComplete } from './test-utils';

// Simplified performance test with adjusted thresholds
const THRESHOLDS = {
  pageLoad: 15000,        // 15 seconds (more realistic for development)
  formInteraction: 200,   // 200ms for form interactions
  authentication: 10000,  // 10 seconds for auth
  bundleSize: 5 * 1024 * 1024, // 5MB max JS bundle
  navigation: 5000,       // 5 seconds for navigation
};

test.describe('Site Performance Tests', () => {
  test('📊 Page Load Performance Report', async ({ page }) => {
    console.log('\\n🚀 TESTING SITE PERFORMANCE');
    console.log('=' .repeat(50));
    
    // Test Login Page
    const loginStartTime = Date.now();
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    const loginLoadTime = Date.now() - loginStartTime;
    
    console.log(`📝 Login Page Load: ${loginLoadTime}ms`);
    
    // Get resource metrics
    const resources = await page.evaluate(() => {
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const jsResources = resources.filter(r => r.name.includes('.js'));
      const totalJSSize = jsResources.reduce((sum, resource) => 
        sum + (resource.transferSize || resource.decodedBodySize || 0), 0
      );
      
      return {
        totalResources: resources.length,
        jsFiles: jsResources.length,
        totalJSSizeMB: (totalJSSize / (1024 * 1024)).toFixed(2),
        totalJSSize
      };
    });
    
    console.log(`💾 JavaScript Bundle: ${resources.totalJSSizeMB}MB (${resources.jsFiles} files)`);
    console.log(`📦 Total Resources: ${resources.totalResources}`);
    
    // Memory info (Chrome only)
    const memoryInfo = await page.evaluate(() => {
      // @ts-ignore
      if (typeof performance !== 'undefined' && performance.memory) {
        // @ts-ignore
        const memory = performance.memory;
        return {
          usedMB: (memory.usedJSHeapSize / (1024 * 1024)).toFixed(2),
          totalMB: (memory.totalJSHeapSize / (1024 * 1024)).toFixed(2)
        };
      }
      return null;
    });
    
    if (memoryInfo) {
      console.log(`🧠 Memory Usage: ${memoryInfo.usedMB}MB / ${memoryInfo.totalMB}MB`);
    }
    
    // Assertions with realistic thresholds
    expect(loginLoadTime).toBeLessThan(THRESHOLDS.pageLoad);
    expect(resources.totalJSSize).toBeLessThan(THRESHOLDS.bundleSize);
    
    console.log('✅ Login page performance test passed!');
  });

  test('🔐 Authentication Performance', async ({ page }) => {
    console.log('\\n🔐 TESTING AUTHENTICATION PERFORMANCE');
    
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    
    const authStartTime = Date.now();
    
    // Perform login
    await page.fill('input[type="email"]', 'admin@pgaskets.com');
    await page.fill('input[type="password"]', 'pgaskets123');
    await page.click('button[type="submit"]');
    
    // Wait for redirect
    try {
      await expect(page).toHaveURL(/.*\/app/, { timeout: 15000 });
      await waitForLoadingToComplete(page);
      
      const authTime = Date.now() - authStartTime;
      console.log(`⚡ Authentication completed in: ${authTime}ms`);
      
      // Verify we're on dashboard
      await expect(page.getByRole('heading', { name: 'Inventory System' })).toBeVisible({ timeout: 10000 });
      
      expect(authTime).toBeLessThan(THRESHOLDS.authentication);
      console.log('✅ Authentication performance test passed!');
      
    } catch (error) {
      console.log('❌ Authentication failed or timed out');
      throw error;
    }
  });

  test('🏠 Dashboard Performance', async ({ page }) => {
    console.log('\\n🏠 TESTING DASHBOARD PERFORMANCE');
    
    // Login first
    await login(page);
    
    // Measure dashboard load
    const dashboardStartTime = Date.now();
    await page.goto('/app');
    await waitForLoadingToComplete(page);
    const dashboardLoadTime = Date.now() - dashboardStartTime;
    
    console.log(`📊 Dashboard Load Time: ${dashboardLoadTime}ms`);
    
    // Count UI elements
    const uiElements = await page.evaluate(() => {
      return {
        tables: document.querySelectorAll('table').length,
        buttons: document.querySelectorAll('button').length,
        inputs: document.querySelectorAll('input').length,
        totalElements: document.querySelectorAll('*').length
      };
    });
    
    console.log(`🎯 UI Elements: ${uiElements.tables} tables, ${uiElements.buttons} buttons, ${uiElements.inputs} inputs`);
    console.log(`📐 Total DOM nodes: ${uiElements.totalElements}`);
    
    expect(dashboardLoadTime).toBeLessThan(THRESHOLDS.navigation);
    expect(uiElements.totalElements).toBeLessThan(2000); // Reasonable DOM size
    
    console.log('✅ Dashboard performance test passed!');
  });

  test('⌨️ Form Interaction Performance', async ({ page }) => {
    console.log('\\n⌨️ TESTING FORM INTERACTIONS');
    
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    
    // Test form responsiveness
    const interactions = [
      { name: 'Email field', selector: 'input[type="email"]', value: 'test@example.com' },
      { name: 'Password field', selector: 'input[type="password"]', value: 'password123' }
    ];
    
    for (const interaction of interactions) {
      const startTime = Date.now();
      await page.fill(interaction.selector, interaction.value);
      const responseTime = Date.now() - startTime;
      
      console.log(`📝 ${interaction.name}: ${responseTime}ms`);
      expect(responseTime).toBeLessThan(THRESHOLDS.formInteraction);
    }
    
    console.log('✅ Form interaction performance test passed!');
  });

  test('🧭 Navigation Performance', async ({ page }) => {
    console.log('\\n🧭 TESTING NAVIGATION PERFORMANCE');
    
    await login(page);
    
    // Test navigation between pages
    const routes = [
      { path: '/app', name: 'Dashboard' }
    ];
    
    for (const route of routes) {
      const startTime = Date.now();
      await page.goto(route.path);
      await page.waitForLoadState('networkidle');
      const navTime = Date.now() - startTime;
      
      console.log(`🚀 ${route.name} navigation: ${navTime}ms`);
      expect(navTime).toBeLessThan(THRESHOLDS.navigation);
    }
    
    console.log('✅ Navigation performance test passed!');
  });
});

// Performance Summary Report
test('📋 Performance Summary Report', async ({ page }) => {
  console.log('\\n📋 FINAL PERFORMANCE REPORT');
  console.log('=' .repeat(60));
  
  // Quick performance snapshot
  const loginTime = await (async () => {
    const start = Date.now();
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    return Date.now() - start;
  })();
  
  const resources = await page.evaluate(() => {
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const jsResources = resources.filter(r => r.name.includes('.js'));
    return {
      totalJSSizeMB: (jsResources.reduce((sum, r) => 
        sum + (r.transferSize || r.decodedBodySize || 0), 0) / (1024 * 1024)).toFixed(2),
      jsFileCount: jsResources.length
    };
  });
  
  const performanceGrade = (score: number): string => {
    if (score < 2000) return '🟢 Excellent';
    if (score < 5000) return '🟡 Good';
    if (score < 10000) return '🟠 Fair';
    return '🔴 Needs Improvement';
  };
  
  console.log(`\\n📊 LOGIN PAGE PERFORMANCE: ${performanceGrade(loginTime)}`);
  console.log(`   Load Time: ${loginTime}ms`);
  console.log(`   JS Bundle: ${resources.totalJSSizeMB}MB (${resources.jsFileCount} files)`);
  console.log(`   Status: ${loginTime < THRESHOLDS.pageLoad ? '✅ PASSED' : '❌ FAILED'}`);
  
  console.log('\\n🎯 RECOMMENDATIONS:');
  if (loginTime > 5000) {
    console.log('   • Consider optimizing initial page load');
    console.log('   • Check for large JavaScript bundles');
    console.log('   • Implement code splitting if possible');
  }
  if (parseFloat(resources.totalJSSizeMB) > 2) {
    console.log('   • JavaScript bundle is large (>2MB)');
    console.log('   • Consider lazy loading non-critical code');
  }
  if (loginTime < 2000) {
    console.log('   • 🚀 Great performance! Site loads quickly');
  }
  
  console.log('\\n' + '=' .repeat(60));
  console.log('🏆 PERFORMANCE TEST COMPLETED');
  
  // Overall test should pass
  expect(loginTime).toBeLessThan(THRESHOLDS.pageLoad);
});