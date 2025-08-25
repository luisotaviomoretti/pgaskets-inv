import { test, expect } from '@playwright/test';

test.describe('Core Performance Metrics', () => {
  test('should measure key performance indicators', async ({ page }) => {
    console.log('🚀 Starting performance measurement...');
    
    const startTime = Date.now();
    
    // Navigate to application
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    const initialLoadTime = Date.now() - startTime;
    console.log(`📊 Initial page load: ${initialLoadTime}ms`);
    
    // Measure Core Web Vitals
    const webVitals = await page.evaluate(() => {
      return new Promise((resolve) => {
        const vitals = {
          fcp: 0,
          lcp: 0,
          cls: 0,
          fid: 0
        };
        
        // First Contentful Paint
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'first-contentful-paint') {
              vitals.fcp = entry.startTime;
            }
          }
        }).observe({ entryTypes: ['paint'] });
        
        // Largest Contentful Paint
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            vitals.lcp = entry.startTime;
          }
        }).observe({ entryTypes: ['largest-contentful-paint'] });
        
        // Layout Shift
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) {
              vitals.cls += entry.value;
            }
          }
        }).observe({ entryTypes: ['layout-shift'] });
        
        setTimeout(() => resolve(vitals), 3000);
      });
    });
    
    console.log('🎯 Core Web Vitals:', webVitals);
    
    // Measure JavaScript performance
    const jsMetrics = await page.evaluate(() => {
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const jsResources = resources.filter(r => r.name.includes('.js'));
      const totalJSSize = jsResources.reduce((sum, resource) => sum + resource.transferSize, 0);
      
      return {
        jsResourceCount: jsResources.length,
        totalJSSize,
        totalJSSizeMB: (totalJSSize / (1024 * 1024)).toFixed(2)
      };
    });
    
    console.log('💾 JavaScript Metrics:', jsMetrics);
    
    // Measure memory usage (Chrome only)
    const memoryInfo = await page.evaluate(() => {
      // @ts-ignore - performance.memory is Chrome-specific
      return performance.memory ? {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        usedJSHeapSizeMB: (performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2),
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
      } : null;
    });
    
    if (memoryInfo) {
      console.log('🧠 Memory Usage:', memoryInfo);
    }
    
    // Performance assertions
    expect(initialLoadTime).toBeLessThan(5000); // 5 second timeout
    if (webVitals.fcp > 0) {
      expect(webVitals.fcp).toBeLessThan(3000); // FCP under 3s
    }
    if (webVitals.lcp > 0) {
      expect(webVitals.lcp).toBeLessThan(4000); // LCP under 4s
    }
    if (webVitals.cls > 0) {
      expect(webVitals.cls).toBeLessThan(0.1); // CLS under 0.1
    }
    
    console.log('✅ Performance test completed successfully');
  });

  test('should measure authentication performance', async ({ page }) => {
    console.log('🔐 Testing authentication performance...');
    
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    
    const startTime = Date.now();
    
    // Perform login
    await page.fill('input[type="email"]', 'admin@pgaskets.com');
    await page.fill('input[type="password"]', 'pgaskets123');
    await page.click('button[type="submit"]');
    
    // Wait for successful redirect (with longer timeout for authentication)
    try {
      await expect(page).toHaveURL(/.*\/app/, { timeout: 15000 });
      const authTime = Date.now() - startTime;
      
      console.log(`⚡ Authentication completed in: ${authTime}ms`);
      expect(authTime).toBeLessThan(10000); // 10 second max for auth
    } catch (error) {
      console.log('❌ Authentication failed or timed out');
      // Take a screenshot for debugging
      await page.screenshot({ path: 'auth-failure-debug.png' });
      throw error;
    }
  });

  test('should measure navigation performance', async ({ page }) => {
    console.log('🧭 Testing navigation performance...');
    
    // Test navigation between routes
    const routes = ['/login', '/'];
    const navigationTimes: number[] = [];
    
    for (const route of routes) {
      const startTime = Date.now();
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      const navTime = Date.now() - startTime;
      
      navigationTimes.push(navTime);
      console.log(`📍 Navigation to ${route}: ${navTime}ms`);
      
      expect(navTime).toBeLessThan(3000);
    }
    
    const avgNavigationTime = navigationTimes.reduce((a, b) => a + b, 0) / navigationTimes.length;
    console.log(`📊 Average navigation time: ${avgNavigationTime.toFixed(0)}ms`);
  });
});