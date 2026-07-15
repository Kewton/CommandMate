/**
 * E2E Tests: Locale Switcher
 *
 * Tests the language switching user flow including Cookie persistence,
 * fallback for unsupported locales, and mobile viewport behavior.
 *
 * [Issue #1180] Two drift fixes here:
 *   1. The mobile describe called `test.use({ ...test.info().project.use })`.
 *      `test.info()` only exists inside a running test, but a `test.use()` in a
 *      describe body evaluates at collection time — so it threw
 *      "test.info() can only be called while test is running" and Playwright
 *      aborted the whole run before any spec executed, in every file. It also
 *      never did anything: spreading a project's own `use` back into itself is a
 *      tautology, so the describe never actually got a mobile viewport. Replaced
 *      with a literal viewport, matching the terminal-split specs.
 *   2. The English/Japanese assertions used `getByText('Send'/'Cancel')`, which
 *      have not rendered on `/` since the home page became a dashboard (#1052 /
 *      #1072) — `common.send` / `common.cancel` are the worktree detail message
 *      form. They are replaced with the home heading (`home.title`) and the live
 *      session subline (`home.running` / `home.waiting`), which are on this page
 *      and are translated.
 *
 * The `select[aria-label="Language"]` lives in the sidebar, which is a closed
 * drawer on mobile — so only the desktop specs assert on it.
 */

import { test, expect } from '@playwright/test';

/** iPhone 13 logical viewport, used by the mobile describe below. */
const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.describe('Locale Switcher', () => {
  test('should default to English', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // LocaleSwitcher select should exist with value "en"
    const select = page.locator('select[aria-label="Language"]');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('en');

    // English text should be visible
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    await expect(page.getByTestId('home-subline')).toContainText('running');
    await expect(page.getByTestId('home-subline')).toContainText('waiting');
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
    await expect(page.getByRole('heading', { name: '概要', level: 1 })).toBeVisible();
    await expect(page.getByTestId('home-subline')).toContainText('実行中');
    await expect(page.getByTestId('home-subline')).toContainText('待機中');

    // LocaleSwitcher should show "ja"
    const select = page.locator('select[aria-label="Language"]');
    await expect(select).toHaveValue('ja');
  });

  test('should persist locale across page reload via Cookie', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Switch through the UI so the cookie under test is the one the app writes
    // (setLocaleCookie), not one the test planted. selectOption triggers a reload.
    await page.locator('select[aria-label="Language"]').selectOption('ja');
    await expect(page.getByRole('heading', { name: '概要', level: 1 })).toBeVisible();

    // Reload and verify persistence
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: '概要', level: 1 })).toBeVisible();
    await expect(page.locator('select[aria-label="Language"]')).toHaveValue('ja');

    // Verify the security flags setLocaleCookie promises
    const cookies = await context.cookies();
    const localeCookie = cookies.find(c => c.name === 'locale');
    expect(localeCookie).toBeDefined();
    expect(localeCookie!.value).toBe('ja');
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
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();

    const select = page.locator('select[aria-label="Language"]');
    await expect(select).toHaveValue('en');
  });
});

test.describe('Locale Switcher - Mobile', () => {
  test.use({ viewport: MOBILE_VIEWPORT });

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
    await expect(page.getByRole('heading', { name: '概要', level: 1 })).toBeVisible();
    await expect(page.getByTestId('home-subline')).toContainText('実行中');
    await expect(page.getByTestId('home-subline')).toContainText('待機中');
  });
});
