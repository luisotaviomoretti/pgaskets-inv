import { test, expect } from '@playwright/test';
import { login, logout, TEST_CREDENTIALS, waitForLoadingToComplete } from './test-utils';

test.describe('Authentication Flow', () => {
  test('should show error for invalid credentials', async ({ page }) => {
    await page.goto('/login');
    
    // Fill in invalid credentials
    await page.fill('input[type="email"]', 'invalid@example.com');
    await page.fill('input[type="password"]', 'wrongpassword');
    
    // Click sign in button
    await page.click('button[type="submit"]');
    
    // Should show error message
    await expect(page.getByText(/invalid/i)).toBeVisible({ timeout: 5000 });
  });

  test('should successfully log in with valid credentials', async ({ page }) => {
    await login(page);
    
    // Wait for loading to complete
    await waitForLoadingToComplete(page);
    
    // Should be on dashboard
    await expect(page).toHaveURL(/.*\/app/, { timeout: 10000 });
    
    // Should show dashboard content (use first() to handle multiple matches)
    await expect(page.getByRole('heading', { name: 'Inventory System' })).toBeVisible({ timeout: 10000 });
  });

  test('should persist session after page refresh', async ({ page }) => {
    // Login first
    await login(page);
    await waitForLoadingToComplete(page);
    
    // Refresh the page
    await page.reload();
    await waitForLoadingToComplete(page);
    
    // Should still be logged in (not redirected to login)
    await expect(page).toHaveURL(/.*\/app/);
    await expect(page.getByRole('heading', { name: 'Inventory System' })).toBeVisible({ timeout: 10000 });
  });

  test('should logout successfully', async ({ page }) => {
    // Login first
    await login(page);
    await waitForLoadingToComplete(page);
    
    // Logout
    await logout(page);
    
    // Should redirect to login page
    await expect(page).toHaveURL(/.*\/login/, { timeout: 5000 });
    
    // Trying to access protected route should redirect to login
    await page.goto('/app');
    await expect(page).toHaveURL(/.*\/login/);
  });

  test('should measure authentication performance', async ({ page }) => {
    const startTime = Date.now();
    
    // Perform login
    await login(page);
    await waitForLoadingToComplete(page);
    
    const loginTime = Date.now() - startTime;
    
    console.log(`🔐 Authentication time: ${loginTime}ms`);
    
    // Login should complete within 10 seconds (increased timeout for reliability)
    expect(loginTime).toBeLessThan(10000);
  });
});