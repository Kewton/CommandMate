/**
 * E2E Tests: Locale Switcher
 *
 * Tests the language switching user flow including Cookie persistence,
 * fallback for unsupported locales, and mobile viewport behavior.
 */

import { test, expect } from '@playwright/test';

test.describe('Locale Switcher', () => {
  test('should default to English', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // LocaleSwitcher select should exist with value "en"
    const select = page.locator('select[aria-label="Language"]');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('en');

    // English text should be visible
    await expect(page.getByText('Send')).toBeVisible();
    await expect(page.getByText('Cancel')).toBeVisible();
  });

  test('should switch to Japanese via Cookie', async ({ page, context }) => {
    await context.addCookies([{
      name: 'locale',
      value: 'ja',
      domain: 'localhost',
      path: '/',
    }]);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Japanese text should be visible
    await expect(page.getByText('送信')).toBeVisible();
    await expect(page.getByText('キャンセル')).toBeVisible();

    // LocaleSwitcher should show "ja"
    const select = page.locator('select[aria-label="Language"]');
    await expect(select).toHaveValue('ja');
  });

  test('should persist locale across page reload via Cookie', async ({ page, context }) => {
    await context.addCookies([{
      name: 'locale',
      value: 'ja',
      domain: 'localhost',
      path: '/',
    }]);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Japanese text visible on first load
    await expect(page.getByText('送信')).toBeVisible();

    // Reload and verify persistence
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('送信')).toBeVisible();
    await expect(page.getByText('キャンセル')).toBeVisible();

    // Verify cookie attributes
    const cookies = await context.cookies();
    const localeCookie = cookies.find(c => c.name === 'locale');
    expect(localeCookie).toBeDefined();
    expect(localeCookie!.path).toBe('/');
    expect(localeCookie!.sameSite).toBe('Lax');
  });

  test('should fallback to English for unsupported locale Cookie', async ({ page, context }) => {
    await context.addCookies([{
      name: 'locale',
      value: 'fr',
      domain: 'localhost',
      path: '/',
    }]);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Should fallback to English
    await expect(page.getByText('Send')).toBeVisible();
    await expect(page.getByText('Cancel')).toBeVisible();

    const select = page.locator('select[aria-label="Language"]');
    await expect(select).toHaveValue('en');
  });
});

test.describe('Locale Switcher - Mobile', () => {
  test.use({ ...test.info().project.use });

  test('should display Japanese text on mobile viewport', async ({ page, context }) => {
    await context.addCookies([{
      name: 'locale',
      value: 'ja',
      domain: 'localhost',
      path: '/',
    }]);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Japanese text should be visible on mobile
    await expect(page.getByText('送信')).toBeVisible();
    await expect(page.getByText('キャンセル')).toBeVisible();
  });
});
