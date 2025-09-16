import { Page } from '@playwright/test';
import { config } from 'dotenv';

// Load test environment variables
config({ path: '.env.test' });

export const TEST_CREDENTIALS = {
  email: process.env.TEST_EMAIL || 'admin@pgaskets.com',
  password: process.env.TEST_PASSWORD || 'pgaskets123',
};

/**
 * Helper function to perform login with test credentials
 */
export async function login(page: Page, credentials = TEST_CREDENTIALS) {
  await page.goto('/login');
  
  // Wait for the login form to be visible
  await page.waitForSelector('input[type="email"]', { timeout: 10000 });
  await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  
  // Fill in credentials
  await page.fill('input[type="email"]', credentials.email);
  await page.fill('input[type="password"]', credentials.password);
  
  // Submit the form
  await page.click('button[type="submit"]');
  
  // Wait for redirect to dashboard
  await page.waitForURL(/.*\/app/, { timeout: 15000 });
  
  return page;
}

/**
 * Helper function to check if user is authenticated
 */
export async function isAuthenticated(page: Page): Promise<boolean> {
  try {
    await page.goto('/app');
    await page.waitForURL(/.*\/app/, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Helper function to logout
 */
export async function logout(page: Page) {
  // First, check if we need to open a user menu/dropdown
  const userMenuSelectors = [
    '[data-testid="user-menu"]',
    'button:has-text("admin@pgaskets.com")',
    '.user-menu',
    'button[aria-label="User menu"]',
    '.dropdown-toggle'
  ];
  
  // Try to click user menu first
  for (const selector of userMenuSelectors) {
    try {
      const element = page.locator(selector).first();
      if (await element.isVisible({ timeout: 1000 })) {
        await element.click();
        await page.waitForTimeout(500); // Wait for dropdown to open
        break;
      }
    } catch {
      // Continue to next selector
    }
  }
  
  // Now try to find and click logout button
  const logoutSelectors = [
    'button:has-text("Logout")',
    'button:has-text("Sign out")',
    '[data-testid="logout"]',
    'button[aria-label="Logout"]',
    '.logout-button',
    'a[href*="logout"]',
    'button:has-text("Sair")', // Portuguese
    'text=Logout',
    'text=Sign out'
  ];
  
  for (const selector of logoutSelectors) {
    try {
      const element = page.locator(selector).first();
      if (await element.isVisible({ timeout: 2000 })) {
        await element.click();
        await page.waitForURL(/.*\/login/, { timeout: 10000 });
        return;
      }
    } catch {
      // Continue to next selector
    }
  }
  
  // If no logout button found, try to clear session manually
  console.log('No logout button found, clearing session manually');
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto('/login');
  await page.waitForURL(/.*\/login/, { timeout: 5000 });
}

/**
 * Helper to wait for loading states to complete
 */
export async function waitForLoadingToComplete(page: Page, timeout = 10000) {
  try {
    // Wait for any loading spinners or skeletons to disappear
    await page.waitForSelector('[data-testid="loading"]', { state: 'detached', timeout: 1000 });
  } catch {
    // Ignore if no loading indicator found
  }
  
  try {
    await page.waitForSelector('.loading', { state: 'detached', timeout: 1000 });
  } catch {
    // Ignore if no loading class found
  }
  
  // Wait for network to be idle
  await page.waitForLoadState('networkidle', { timeout });
}