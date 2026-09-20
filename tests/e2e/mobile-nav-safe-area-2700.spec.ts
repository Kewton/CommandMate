/**
 * E2E Tests: Mobile main safe area and bottom nav overlap (#2700)
 *
 * Verifies that <main>'s padding-bottom accounts for the 1px border-top
 * of the global mobile nav in addition to the 56px body and safe-area inset,
 * ensuring no 1px overlap between main content and bottom nav.
 */

import { test, expect } from '@playwright/test';

test.describe('[Issue #2700] Mobile nav safe area and border-top overlap', () => {
  test('inset = 34px でナビに重ならない', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/repositories');
    await expect(page.getByTestId('app-shell')).toBeVisible();

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 34 } });
    await page.reload({ waitUntil: 'domcontentloaded' });

    const applied = await page.evaluate(() => {
      const d = document.createElement('div');
      d.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
      document.body.appendChild(d);
      const v = getComputedStyle(d).paddingBottom;
      d.remove();
      return v;
    });
    expect(applied, 'safe-area inset override did not take effect').toBe('34px');

    const main = await page.waitForSelector('main').catch(() => null);
    expect(main, 'main was not rendered at mobile width').not.toBeNull();
    const nav = await page.waitForSelector('[data-testid="global-mobile-nav"]').catch(() => null);
    expect(nav, 'global-mobile-nav was not rendered at mobile width').not.toBeNull();

    const measurements = await page.evaluate(() => {
      const mainEl = document.querySelector('main');
      const navEl = document.querySelector('[data-testid="global-mobile-nav"]');
      if (!mainEl || !navEl) return null;

      const mainRect = mainEl.getBoundingClientRect();
      const navRect = navEl.getBoundingClientRect();
      const cs = getComputedStyle(mainEl);
      const paddingBottom = parseFloat(cs.paddingBottom);
      const contentBottom = mainRect.bottom - paddingBottom;

      return {
        paddingBottom,
        contentBottom,
        navTop: navRect.top,
        navHeight: navRect.height,
      };
    });

    expect(measurements, 'elements disappeared before evaluation').not.toBeNull();
    if (!measurements) return;

    // アサーション: parseFloat(cs.paddingBottom) が 91（±0.5）／contentBottom <= navRect.top（許容を足さない）／ナビ実高が 91（±0.5）＝contentBottom と一致
    expect(Math.abs(measurements.paddingBottom - 91)).toBeLessThanOrEqual(0.5);
    expect(measurements.contentBottom).toBeLessThanOrEqual(measurements.navTop);
    expect(Math.abs(measurements.navHeight - 91)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(measurements.contentBottom - measurements.navTop)).toBeLessThanOrEqual(0.5);
  });

  test('inset = 0 でもナビに重ならない', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/repositories');
    await expect(page.getByTestId('app-shell')).toBeVisible();

    const main = await page.waitForSelector('main').catch(() => null);
    expect(main, 'main was not rendered at mobile width').not.toBeNull();
    const nav = await page.waitForSelector('[data-testid="global-mobile-nav"]').catch(() => null);
    expect(nav, 'global-mobile-nav was not rendered at mobile width').not.toBeNull();

    const measurements = await page.evaluate(() => {
      const mainEl = document.querySelector('main');
      const navEl = document.querySelector('[data-testid="global-mobile-nav"]');
      if (!mainEl || !navEl) return null;

      const mainRect = mainEl.getBoundingClientRect();
      const navRect = navEl.getBoundingClientRect();
      const cs = getComputedStyle(mainEl);
      const paddingBottom = parseFloat(cs.paddingBottom);
      const contentBottom = mainRect.bottom - paddingBottom;

      return {
        paddingBottom,
        contentBottom,
        navTop: navRect.top,
        navHeight: navRect.height,
      };
    });

    expect(measurements, 'elements disappeared before evaluation').not.toBeNull();
    if (!measurements) return;

    // アサーション: parseFloat(cs.paddingBottom) が 57（±0.5）／contentBottom <= navRect.top（許容なし）／ナビ実高が 57（±0.5）
    expect(Math.abs(measurements.paddingBottom - 57)).toBeLessThanOrEqual(0.5);
    expect(measurements.contentBottom).toBeLessThanOrEqual(measurements.navTop);
    expect(Math.abs(measurements.navHeight - 57)).toBeLessThanOrEqual(0.5);
  });

  test('余白がナビの実高と一致する（式ではなく関係で固定する）', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/repositories');
    await expect(page.getByTestId('app-shell')).toBeVisible();

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 34 } });
    await page.reload({ waitUntil: 'domcontentloaded' });

    const applied = await page.evaluate(() => {
      const d = document.createElement('div');
      d.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
      document.body.appendChild(d);
      const v = getComputedStyle(d).paddingBottom;
      d.remove();
      return v;
    });
    expect(applied, 'safe-area inset override did not take effect').toBe('34px');

    const main = await page.waitForSelector('main').catch(() => null);
    expect(main, 'main was not rendered at mobile width').not.toBeNull();
    const nav = await page.waitForSelector('[data-testid="global-mobile-nav"]').catch(() => null);
    expect(nav, 'global-mobile-nav was not rendered at mobile width').not.toBeNull();

    const measurements = await page.evaluate(() => {
      const mainEl = document.querySelector('main');
      const navEl = document.querySelector('[data-testid="global-mobile-nav"]');
      if (!mainEl || !navEl) return null;

      const navRect = navEl.getBoundingClientRect();
      const cs = getComputedStyle(mainEl);
      const paddingBottom = parseFloat(cs.paddingBottom);

      return {
        paddingBottom,
        navHeight: navRect.height,
      };
    });

    expect(measurements, 'elements disappeared before evaluation').not.toBeNull();
    if (!measurements) return;

    // inset = 34px の状態で Math.abs(parseFloat(cs.paddingBottom) - navRect.height) <= 0.5
    expect(Math.abs(measurements.paddingBottom - measurements.navHeight)).toBeLessThanOrEqual(0.5);
  });
});
