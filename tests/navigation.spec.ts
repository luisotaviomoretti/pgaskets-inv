import { test, expect } from '@playwright/test';

test.describe('Basic Navigation', () => {
  test('should redirect to login when not authenticated', async ({ page }) => {
    await page.goto('/');
    
    // Should redirect to login page
    await expect(page).toHaveURL(/.*\/login/);
    
    // Check for login form presence
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByText(/Sign in to access the system/i)).toBeVisible();
  });

  test('should show login form elements', async ({ page }) => {
    await page.goto('/login');
    
    // Check for login form elements
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
  });

  test('should handle app route when not authenticated', async ({ page }) => {
    await page.goto('/app');
    
    // Should redirect to login
    await expect(page).toHaveURL(/.*\/login/);
  });
});