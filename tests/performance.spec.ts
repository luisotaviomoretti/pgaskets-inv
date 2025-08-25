import { test, expect } from '@playwright/test';

test.describe('Performance Tests', () => {
  test('should measure page load times', async ({ page }) => {
    // Start timing
    const startTime = Date.now();
    
    await page.goto('/');
    
    // Wait for page to be fully loaded
    await page.waitForLoadState('networkidle');
    
    const loadTime = Date.now() - startTime;
    
    // Assert that page loads within reasonable time (3 seconds)
    expect(loadTime).toBeLessThan(3000);
    
    console.log(`Page load time: ${loadTime}ms`);
  });

  test('should measure Core Web Vitals', async ({ page }) => {
    await page.goto('/login');
    
    // Measure First Contentful Paint (FCP)
    const fcp = await page.evaluate(() => {
      return new Promise((resolve) => {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'first-contentful-paint') {
              resolve(entry.startTime);
            }
          }
        }).observe({ entryTypes: ['paint'] });
      });
    });
    
    console.log(`First Contentful Paint: ${fcp}ms`);
    expect(fcp).toBeLessThan(2000); // FCP should be under 2 seconds
  });

  test('should measure JavaScript bundle size impact', async ({ page }) => {
    // Navigate to page and measure resource loading
    const startTime = Date.now();
    
    await page.goto('/login');
    
    // Get all network requests
    const resources = await page.evaluate(() => {
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      return resources.map(resource => ({
        name: resource.name,
        transferSize: resource.transferSize,
        decodedBodySize: resource.decodedBodySize,
        duration: resource.duration
      }));
    });
    
    // Find JavaScript resources
    const jsResources = resources.filter(r => r.name.includes('.js'));
    const totalJSSize = jsResources.reduce((sum, resource) => sum + resource.transferSize, 0);
    
    console.log(`Total JS bundle size: ${totalJSSize} bytes`);
    console.log(`JS resources count: ${jsResources.length}`);
    
    // Assert reasonable bundle size (under 2MB)
    expect(totalJSSize).toBeLessThan(2 * 1024 * 1024);
  });

  test('should measure Time to Interactive (TTI)', async ({ page }) => {
    const startTime = Date.now();
    
    await page.goto('/login');
    
    // Wait for page to be interactive (can interact with form elements)
    await page.waitForSelector('input[type="email"]', { state: 'attached' });
    await page.waitForFunction(() => document.readyState === 'complete');
    
    // Try to interact with the form to ensure it's truly interactive
    await page.fill('input[type="email"]', 'test@example.com');
    
    const tti = Date.now() - startTime;
    
    console.log(`Time to Interactive: ${tti}ms`);
    expect(tti).toBeLessThan(5000); // TTI should be under 5 seconds
  });

  test('should measure memory usage', async ({ page, browser }) => {
    await page.goto('/login');
    
    // Navigate through different routes to check memory usage
    const routes = ['/login', '/', '/app'];
    
    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      
      // Get memory info (Chrome specific)
      const memoryInfo = await page.evaluate(() => {
        // @ts-ignore - performance.memory is Chrome-specific
        return performance.memory ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
        } : null;
      });
      
      if (memoryInfo) {
        console.log(`Memory usage for ${route}:`, memoryInfo);
        
        // Assert reasonable memory usage (under 100MB)
        expect(memoryInfo.usedJSHeapSize).toBeLessThan(100 * 1024 * 1024);
      }
    }
  });
});