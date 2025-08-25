import { test, expect } from '@playwright/test';

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
    await page.goto('/login');
    
    // Fill in valid credentials (from CLAUDE.md)
    await page.fill('input[type="email"]', 'admin@pgaskets.com');
    await page.fill('input[type="password"]', 'pgaskets123');
    
    // Click sign in button
    await page.click('button[type="submit"]');
    
    // Should redirect to dashboard
    await expect(page).toHaveURL(/.*\/app/, { timeout: 10000 });
    
    // Should show dashboard content
    await expect(page.getByText(/dashboard|inventory|welcome/i)).toBeVisible({ timeout: 5000 });
  });

  test('should persist session after page refresh', async ({ page }) => {
    // Login first
    await page.goto('/login');
    await page.fill('input[type="email"]', 'admin@pgaskets.com');
    await page.fill('input[type="password"]', 'pgaskets123');
    await page.click('button[type="submit"]');
    
    // Wait for redirect to dashboard
    await expect(page).toHaveURL(/.*\/app/, { timeout: 10000 });
    
    // Refresh the page
    await page.reload();
    
    // Should still be logged in (not redirected to login)
    await expect(page).toHaveURL(/.*\/app/);
    await expect(page.getByText(/dashboard|inventory/i)).toBeVisible({ timeout: 5000 });
  });

  test('should logout successfully', async ({ page }) => {
    // Login first
    await page.goto('/login');
    await page.fill('input[type="email"]', 'admin@pgaskets.com');
    await page.fill('input[type="password"]', 'pgaskets123');
    await page.click('button[type="submit"]');
    
    // Wait for dashboard
    await expect(page).toHaveURL(/.*\/app/, { timeout: 10000 });
    
    // Find and click logout button
    await page.click('button:has-text("Logout"), [data-testid="logout"], button:has-text("Sign out")');
    
    // Should redirect to login page
    await expect(page).toHaveURL(/.*\/login/, { timeout: 5000 });
    
    // Trying to access protected route should redirect to login
    await page.goto('/app');
    await expect(page).toHaveURL(/.*\/login/);
  });

  test('should measure authentication performance', async ({ page }) => {
    await page.goto('/login');
    
    const startTime = Date.now();
    
    // Perform login
    await page.fill('input[type="email"]', 'admin@pgaskets.com');
    await page.fill('input[type="password"]', 'pgaskets123');
    await page.click('button[type="submit"]');
    
    // Wait for successful redirect
    await expect(page).toHaveURL(/.*\/app/, { timeout: 10000 });
    
    const loginTime = Date.now() - startTime;
    
    console.log(`Authentication time: ${loginTime}ms`);
    
    // Login should complete within 5 seconds
    expect(loginTime).toBeLessThan(5000);
  });
});