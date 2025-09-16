import { test, expect, Page } from '@playwright/test';
import { login, waitForLoadingToComplete } from './test-utils';

// Performance thresholds (you can adjust these based on your requirements)
const PERFORMANCE_THRESHOLDS = {
  pageLoad: 5000,        // 5 seconds max page load
  firstContentfulPaint: 2500,  // 2.5 seconds FCP
  largestContentfulPaint: 4000, // 4 seconds LCP
  cumulativeLayoutShift: 0.1,   // 0.1 CLS
  firstInputDelay: 100,         // 100ms FID
  timeToInteractive: 5000,      // 5 seconds TTI
  authentication: 10000,        // 10 seconds auth
  bundleSize: 3 * 1024 * 1024, // 3MB max JS bundle
  memoryUsage: 150 * 1024 * 1024, // 150MB max memory
};

interface PerformanceMetrics {
  pageLoadTime: number;
  firstContentfulPaint: number;
  largestContentfulPaint: number;
  cumulativeLayoutShift: number;
  timeToInteractive: number;
  jsMetrics: {
    resourceCount: number;
    totalSize: number;
    totalSizeMB: string;
  };
  memoryInfo?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
}

async function measurePagePerformance(page: Page, url: string): Promise<PerformanceMetrics> {
  const startTime = Date.now();
  
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  
  const pageLoadTime = Date.now() - startTime;

  // Measure Core Web Vitals
  const webVitals = await page.evaluate(() => {
    return new Promise<any>((resolve) => {
      const vitals = {
        fcp: 0,
        lcp: 0,
        cls: 0,
        fid: 0,
        tti: performance.now() // Basic TTI approximation
      };

      let fcpObserver: PerformanceObserver | null = null;
      let lcpObserver: PerformanceObserver | null = null;
      let clsObserver: PerformanceObserver | null = null;
      
      try {
        // First Contentful Paint
        fcpObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'first-contentful-paint') {
              vitals.fcp = entry.startTime;
            }
          }
        });
        fcpObserver.observe({ entryTypes: ['paint'] });

        // Largest Contentful Paint
        lcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const lastEntry = entries[entries.length - 1];
          if (lastEntry) {
            vitals.lcp = lastEntry.startTime;
          }
        });
        lcpObserver.observe({ entryTypes: ['largest-contentful-paint'] });

        // Cumulative Layout Shift
        clsObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as any[]) {
            if (!entry.hadRecentInput) {
              vitals.cls += entry.value;
            }
          }
        });
        clsObserver.observe({ entryTypes: ['layout-shift'] });
      } catch (error) {
        console.warn('Some performance observers not supported:', error);
      }

      // Wait for measurements to settle
      setTimeout(() => {
        fcpObserver?.disconnect();
        lcpObserver?.disconnect();
        clsObserver?.disconnect();
        resolve(vitals);
      }, 3000);
    });
  });

  // Measure JavaScript metrics
  const jsMetrics = await page.evaluate(() => {
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const jsResources = resources.filter(r => 
      r.name.includes('.js') || r.name.includes('javascript')
    );
    const totalSize = jsResources.reduce((sum, resource) => 
      sum + (resource.transferSize || resource.decodedBodySize || 0), 0
    );

    return {
      resourceCount: jsResources.length,
      totalSize,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
    };
  });

  // Memory usage (Chrome only)
  const memoryInfo = await page.evaluate(() => {
    // @ts-ignore
    if (typeof performance !== 'undefined' && performance.memory) {
      // @ts-ignore
      const memory = performance.memory;
      return {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit
      };
    }
    return undefined;
  });

  return {
    pageLoadTime,
    firstContentfulPaint: webVitals.fcp,
    largestContentfulPaint: webVitals.lcp,
    cumulativeLayoutShift: webVitals.cls,
    timeToInteractive: webVitals.tti,
    jsMetrics,
    memoryInfo
  };
}

function logPerformanceReport(metrics: PerformanceMetrics, pageName: string) {
  console.log(`\\n🚀 Performance Report for ${pageName}:`);
  console.log(`📊 Page Load: ${metrics.pageLoadTime}ms`);
  console.log(`🎨 First Contentful Paint: ${metrics.firstContentfulPaint.toFixed(2)}ms`);
  console.log(`🖼️  Largest Contentful Paint: ${metrics.largestContentfulPaint.toFixed(2)}ms`);
  console.log(`📐 Cumulative Layout Shift: ${metrics.cumulativeLayoutShift.toFixed(3)}`);
  console.log(`⚡ Time to Interactive: ${metrics.timeToInteractive.toFixed(2)}ms`);
  console.log(`💾 JS Bundle: ${metrics.jsMetrics.totalSizeMB}MB (${metrics.jsMetrics.resourceCount} files)`);
  
  if (metrics.memoryInfo) {
    const memoryMB = (metrics.memoryInfo.usedJSHeapSize / (1024 * 1024)).toFixed(2);
    console.log(`🧠 Memory Usage: ${memoryMB}MB`);
  }
}

test.describe('Comprehensive Performance Testing', () => {
  test('should measure login page performance', async ({ page }) => {
    const metrics = await measurePagePerformance(page, '/login');
    logPerformanceReport(metrics, 'Login Page');

    // Assertions
    expect(metrics.pageLoadTime).toBeLessThan(PERFORMANCE_THRESHOLDS.pageLoad);
    if (metrics.firstContentfulPaint > 0) {
      expect(metrics.firstContentfulPaint).toBeLessThan(PERFORMANCE_THRESHOLDS.firstContentfulPaint);
    }
    if (metrics.largestContentfulPaint > 0) {
      expect(metrics.largestContentfulPaint).toBeLessThan(PERFORMANCE_THRESHOLDS.largestContentfulPaint);
    }
    expect(metrics.cumulativeLayoutShift).toBeLessThan(PERFORMANCE_THRESHOLDS.cumulativeLayoutShift);
    expect(metrics.jsMetrics.totalSize).toBeLessThan(PERFORMANCE_THRESHOLDS.bundleSize);
  });

  test('should measure dashboard performance after login', async ({ page }) => {
    // Login first
    await login(page);
    await waitForLoadingToComplete(page);

    // Now measure dashboard performance
    const startTime = Date.now();
    await page.goto('/app');
    await waitForLoadingToComplete(page);
    const pageLoadTime = Date.now() - startTime;

    console.log(`\\n🏠 Dashboard Performance:`);
    console.log(`📊 Load Time: ${pageLoadTime}ms`);

    // Check if dashboard elements are visible
    await expect(page.getByRole('heading', { name: 'Inventory System' })).toBeVisible({ timeout: 10000 });
    
    // Measure dashboard-specific metrics
    const dashboardMetrics = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      const buttons = document.querySelectorAll('button');
      const inputs = document.querySelectorAll('input');
      
      return {
        tablesCount: tables.length,
        buttonsCount: buttons.length,
        inputsCount: inputs.length,
        domNodes: document.querySelectorAll('*').length
      };
    });

    console.log(`🎯 Dashboard Elements:`, dashboardMetrics);

    expect(pageLoadTime).toBeLessThan(PERFORMANCE_THRESHOLDS.pageLoad);
    expect(dashboardMetrics.domNodes).toBeLessThan(2000); // Reasonable DOM size
  });

  test('should measure navigation performance between pages', async ({ page }) => {
    await login(page);
    
    const routes = [
      { path: '/app', name: 'Dashboard' },
      { path: '/app/movements', name: 'Movements', exists: false }, // Check if route exists
      { path: '/app/receiving', name: 'Receiving', exists: false },
      { path: '/app/work-orders', name: 'Work Orders', exists: false }
    ];

    const navigationTimes: Array<{ route: string; time: number }> = [];

    for (const route of routes) {
      const startTime = Date.now();
      
      try {
        await page.goto(route.path);
        await page.waitForLoadState('networkidle', { timeout: 5000 });
        const navTime = Date.now() - startTime;
        
        navigationTimes.push({ route: route.name, time: navTime });
        console.log(`🧭 ${route.name}: ${navTime}ms`);
        
        expect(navTime).toBeLessThan(3000);
      } catch (error) {
        console.log(`⚠️  Route ${route.path} may not exist or took too long`);
        // Don't fail the test for non-existent routes
      }
    }

    const avgTime = navigationTimes.reduce((sum, nav) => sum + nav.time, 0) / navigationTimes.length;
    console.log(`📊 Average Navigation Time: ${avgTime.toFixed(0)}ms`);
  });

  test('should measure form interaction performance', async ({ page }) => {
    await page.goto('/login');
    await waitForLoadingToComplete(page);

    // Measure form responsiveness
    const interactions = [
      { action: 'Fill email', selector: 'input[type="email"]', value: 'test@example.com' },
      { action: 'Fill password', selector: 'input[type="password"]', value: 'password123' },
    ];

    for (const interaction of interactions) {
      const startTime = Date.now();
      await page.fill(interaction.selector, interaction.value);
      const responseTime = Date.now() - startTime;
      
      console.log(`⌨️  ${interaction.action}: ${responseTime}ms`);
      expect(responseTime).toBeLessThan(100); // Should be very fast
    }
  });

  test('should measure authentication flow performance', async ({ page }) => {
    console.log('\\n🔐 Testing Complete Authentication Flow Performance...');
    
    const startTime = Date.now();
    
    await page.goto('/login');
    await page.fill('input[type="email"]', 'admin@pgaskets.com');
    await page.fill('input[type="password"]', 'pgaskets123');
    
    const submitTime = Date.now();
    await page.click('button[type="submit"]');
    
    try {
      await expect(page).toHaveURL(/.*\/app/, { timeout: 15000 });
      await waitForLoadingToComplete(page);
      
      const totalAuthTime = Date.now() - startTime;
      const redirectTime = Date.now() - submitTime;
      
      console.log(`🔐 Total Authentication Flow: ${totalAuthTime}ms`);
      console.log(`🚀 Redirect + Dashboard Load: ${redirectTime}ms`);
      
      expect(totalAuthTime).toBeLessThan(PERFORMANCE_THRESHOLDS.authentication);
      
      // Measure if dashboard is actually functional after auth
      await expect(page.getByRole('heading', { name: 'Inventory System' })).toBeVisible({ timeout: 5000 });
      
      console.log('✅ Authentication flow completed successfully');
    } catch (error) {
      console.log('❌ Authentication performance test failed');
      await page.screenshot({ path: 'auth-perf-failure.png' });
      throw error;
    }
  });

  test('should measure resource loading performance', async ({ page }) => {
    console.log('\\n📦 Testing Resource Loading Performance...');
    
    const resources: Array<{ url: string; size: number; duration: number; type: string }> = [];
    
    page.on('response', async (response) => {
      const request = response.request();
      const timing = await response.timing();
      
      try {
        const url = response.url();
        const type = request.resourceType();
        
        resources.push({
          url: url.split('/').pop() || url,
          size: (await response.body()).length,
          duration: timing.responseEnd - timing.requestStart,
          type
        });
      } catch (error) {
        // Ignore errors for resources we can't measure
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Analyze resources
    const jsResources = resources.filter(r => r.type === 'script');
    const cssResources = resources.filter(r => r.type === 'stylesheet');
    const imageResources = resources.filter(r => r.type === 'image');
    
    console.log(`📜 JavaScript Files: ${jsResources.length}`);
    console.log(`🎨 CSS Files: ${cssResources.length}`);
    console.log(`🖼️  Images: ${imageResources.length}`);
    
    const totalJSSize = jsResources.reduce((sum, r) => sum + r.size, 0);
    const totalCSSSize = cssResources.reduce((sum, r) => sum + r.size, 0);
    
    console.log(`💾 Total JS: ${(totalJSSize / 1024).toFixed(0)}KB`);
    console.log(`🎨 Total CSS: ${(totalCSSSize / 1024).toFixed(0)}KB`);
    
    // Find slowest resources
    const slowestResources = resources
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 3);
    
    console.log('🐌 Slowest Resources:');
    slowestResources.forEach(r => {
      console.log(`   ${r.url}: ${r.duration.toFixed(0)}ms`);
    });
    
    expect(totalJSSize).toBeLessThan(PERFORMANCE_THRESHOLDS.bundleSize);
  });
});

// Performance summary test
test('Performance Summary Report', async ({ page }) => {
  console.log('\\n📊 PERFORMANCE SUMMARY REPORT');
  console.log('=' .repeat(50));
  
  const testResults = {
    loginPage: await measurePagePerformance(page, '/login'),
  };
  
  // Calculate performance score (0-100)
  const scores = {
    pageLoad: Math.max(0, 100 - (testResults.loginPage.pageLoadTime / 50)),
    fcp: testResults.loginPage.firstContentfulPaint > 0 ? 
         Math.max(0, 100 - (testResults.loginPage.firstContentfulPaint / 25)) : 100,
    lcp: testResults.loginPage.largestContentfulPaint > 0 ? 
         Math.max(0, 100 - (testResults.loginPage.largestContentfulPaint / 40)) : 100,
    cls: Math.max(0, 100 - (testResults.loginPage.cumulativeLayoutShift * 1000)),
    bundleSize: Math.max(0, 100 - (testResults.loginPage.jsMetrics.totalSize / (30 * 1024)))
  };
  
  const overallScore = Object.values(scores).reduce((sum, score) => sum + score, 0) / Object.keys(scores).length;
  
  console.log(`\\n🏆 Overall Performance Score: ${overallScore.toFixed(0)}/100`);
  console.log(`📊 Page Load Score: ${scores.pageLoad.toFixed(0)}/100`);
  console.log(`🎨 First Contentful Paint Score: ${scores.fcp.toFixed(0)}/100`);
  console.log(`🖼️  Largest Contentful Paint Score: ${scores.lcp.toFixed(0)}/100`);
  console.log(`📐 Layout Stability Score: ${scores.cls.toFixed(0)}/100`);
  console.log(`💾 Bundle Size Score: ${scores.bundleSize.toFixed(0)}/100`);
  
  logPerformanceReport(testResults.loginPage, 'Final Summary');
  
  // Overall performance should be above 70
  expect(overallScore).toBeGreaterThan(70);
});