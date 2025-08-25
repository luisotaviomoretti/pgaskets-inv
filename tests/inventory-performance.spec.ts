import { test, expect } from '@playwright/test';

test.describe('Inventory Operations Performance', () => {
  // Helper function to login before each test
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', 'admin@pgaskets.com');
    await page.fill('input[type="password"]', 'pgaskets123');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/.*\/app/, { timeout: 10000 });
  });

  test('should measure dashboard load performance', async ({ page }) => {
    const startTime = Date.now();
    
    // Navigate to dashboard (should already be there from login)
    await page.waitForLoadState('networkidle');
    
    // Wait for KPIs to load
    await expect(page.getByText(/inventory value|turnover|days/i)).toBeVisible({ timeout: 10000 });
    
    const loadTime = Date.now() - startTime;
    
    console.log(`Dashboard load time: ${loadTime}ms`);
    expect(loadTime).toBeLessThan(3000);
  });

  test('should measure SKU listing performance', async ({ page }) => {
    const startTime = Date.now();
    
    // Navigate to wireframe page (main dashboard with SKU data)
    await page.click('a:has-text("Wireframe"), button:has-text("Wireframe"), [href*="wireframe"]');
    
    // Wait for SKU data to load
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/sku|stock|inventory/i)).toBeVisible({ timeout: 10000 });
    
    const loadTime = Date.now() - startTime;
    
    console.log(`SKU listing load time: ${loadTime}ms`);
    expect(loadTime).toBeLessThan(5000);
  });

  test('should measure movements page performance', async ({ page }) => {
    const startTime = Date.now();
    
    // Navigate to movements page
    await page.click('a:has-text("Movements"), button:has-text("Movements"), [href*="movements"]');
    
    // Wait for movements data to load
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/movement|transaction|receive|issue/i)).toBeVisible({ timeout: 10000 });
    
    const loadTime = Date.now() - startTime;
    
    console.log(`Movements page load time: ${loadTime}ms`);
    expect(loadTime).toBeLessThan(4000);
  });

  test('should measure receiving form performance', async ({ page }) => {
    const startTime = Date.now();
    
    // Navigate to receiving page
    await page.click('a:has-text("Receiving"), button:has-text("Receiving"), [href*="receiving"]');
    
    // Wait for receiving form to load
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/receive|vendor|quantity/i)).toBeVisible({ timeout: 10000 });
    
    const loadTime = Date.now() - startTime;
    
    console.log(`Receiving form load time: ${loadTime}ms`);
    expect(loadTime).toBeLessThan(3000);
  });

  test('should measure Excel export performance', async ({ page }) => {
    // Go to a page that has Excel export functionality
    await page.click('a:has-text("Wireframe"), button:has-text("Wireframe"), [href*="wireframe"]');
    await page.waitForLoadState('networkidle');
    
    const startTime = Date.now();
    
    // Look for Excel export button and trigger export
    const exportButton = page.locator('button:has-text("Export"), [data-testid="export"], button:has-text("Excel")');
    
    if (await exportButton.count() > 0) {
      // Start download monitoring
      const downloadPromise = page.waitForEvent('download');
      
      await exportButton.first().click();
      
      // Wait for download to complete
      const download = await downloadPromise;
      
      const exportTime = Date.now() - startTime;
      
      console.log(`Excel export time: ${exportTime}ms`);
      expect(exportTime).toBeLessThan(10000); // Export should complete within 10 seconds
      
      // Verify download
      expect(download.suggestedFilename()).toMatch(/\.xlsx?$/);
    } else {
      console.log('Export button not found, skipping export test');
    }
  });

  test('should measure form submission performance', async ({ page }) => {
    // Navigate to receiving page for form testing
    await page.click('a:has-text("Receiving"), button:has-text("Receiving"), [href*="receiving"]');
    await page.waitForLoadState('networkidle');
    
    // Fill out a receiving form if available
    const vendorSelect = page.locator('select:has-text("vendor"), [data-testid="vendor"], select[name*="vendor"]');
    const skuSelect = page.locator('select:has-text("sku"), [data-testid="sku"], select[name*="sku"]');
    const quantityInput = page.locator('input[type="number"], input[name*="quantity"]');
    
    if (await vendorSelect.count() > 0 && await skuSelect.count() > 0 && await quantityInput.count() > 0) {
      // Select first available options
      await vendorSelect.first().selectOption({ index: 1 });
      await skuSelect.first().selectOption({ index: 1 });
      await quantityInput.first().fill('10');
      
      const startTime = Date.now();
      
      // Submit form
      const submitButton = page.locator('button[type="submit"], button:has-text("Submit"), button:has-text("Receive")');
      await submitButton.first().click();
      
      // Wait for success message or redirect
      await expect(page.getByText(/success|received|completed/i).or(page.locator('[data-testid="success"]'))).toBeVisible({ timeout: 10000 });
      
      const submitTime = Date.now() - startTime;
      
      console.log(`Form submission time: ${submitTime}ms`);
      expect(submitTime).toBeLessThan(5000);
    } else {
      console.log('Form elements not found, skipping form submission test');
    }
  });

  test('should measure data filtering performance', async ({ page }) => {
    // Go to movements page which likely has filtering
    await page.click('a:has-text("Movements"), button:has-text("Movements"), [href*="movements"]');
    await page.waitForLoadState('networkidle');
    
    // Look for filter elements
    const filterInput = page.locator('input[placeholder*="filter"], input[placeholder*="search"], [data-testid="filter"]');
    const dateFilter = page.locator('input[type="date"], [data-testid="date-filter"]');
    
    if (await filterInput.count() > 0) {
      const startTime = Date.now();
      
      // Apply a filter
      await filterInput.first().fill('RECEIVE');
      
      // Wait for filtered results
      await page.waitForTimeout(1000); // Allow for debouncing
      await page.waitForLoadState('networkidle');
      
      const filterTime = Date.now() - startTime;
      
      console.log(`Data filtering time: ${filterTime}ms`);
      expect(filterTime).toBeLessThan(2000);
    } else if (await dateFilter.count() > 0) {
      const startTime = Date.now();
      
      // Apply date filter
      await dateFilter.first().fill('2024-01-01');
      
      await page.waitForTimeout(1000);
      await page.waitForLoadState('networkidle');
      
      const filterTime = Date.now() - startTime;
      
      console.log(`Date filtering time: ${filterTime}ms`);
      expect(filterTime).toBeLessThan(2000);
    } else {
      console.log('Filter elements not found, skipping filtering test');
    }
  });
});