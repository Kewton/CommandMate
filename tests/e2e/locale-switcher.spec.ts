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
 *      form. They now use the link in `/`'s empty state
 *      (`common.repositories.add`), which is on this page and is translated
 *      (Issue #2643).
 *
 * [Issue #3510] The sidebar footer's language `<select>` is gone: the language
 * is the "Language" radio group of the shared settings menu, opened from the
 * footer's only button (`sidebar-settings-menu`). The sidebar is a closed
 * drawer on mobile — so only the desktop specs drive it.
 */

import { test, expect, type Page, type Locator } from '@playwright/test';

/** Opens the sidebar footer's settings menu and returns the language radio item. */
async function openLanguageItem(page: Page, label: 'English' | '日本語'): Promise<Locator> {
  await page.getByTestId('sidebar-settings-menu').click();
  const item = page.getByRole('menuitemradio', { name: label });
  await expect(item).toBeVisible();
  return item;
}

/** Asserts which language the menu shows as selected, then closes the menu. */
async function expectSelectedLanguage(page: Page, label: 'English' | '日本語'): Promise<void> {
  const item = await openLanguageItem(page, label);
  await expect(item).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
}

/** iPhone 13 logical viewport, used by the mobile describe below. */
const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.describe('Locale Switcher', () => {
  test('should default to English', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // The settings menu should show English as the selected language
    await expectSelectedLanguage(page, 'English');

    // English text should be visible
    await expect(page.getByTestId('home-add-repository')).toHaveText('Add Repository');
    await expect(page.getByTestId('home-add-repository')).toBeVisible();
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
    await expect(page.getByTestId('home-add-repository')).toHaveText('リポジトリを追加');

    // The settings menu should show 日本語 as the selected language
    await expectSelectedLanguage(page, '日本語');
  });

  test('should persist locale across page reload via Cookie', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Switch through the UI so the cookie under test is the one the app writes
    // (setLocaleCookie), not one the test planted. Choosing the item triggers a reload.
    await (await openLanguageItem(page, '日本語')).click();
    await expect(page.getByTestId('home-add-repository')).toHaveText('リポジトリを追加');

    // Reload and verify persistence
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('home-add-repository')).toHaveText('リポジトリを追加');
    await expectSelectedLanguage(page, '日本語');

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
    await expect(page.getByTestId('home-add-repository')).toHaveText('Add Repository');
    await expect(page.getByTestId('home-add-repository')).toBeVisible();

    await expectSelectedLanguage(page, 'English');
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
    await expect(page.getByTestId('home-add-repository')).toHaveText('リポジトリを追加');
  });
});
