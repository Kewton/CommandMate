/**
 * E2E: the phone's drawer opens and closes from every screen (Issue #3515).
 *
 * At 390x844 the drawer is opened from the bottom tab bar's "Branches" outside
 * `/worktrees/*` (#2642) and from the mobile header's ☰ on a worktree, and it
 * is closed by its own close button (×) at the top as well as by tapping the
 * overlay. While it is open the bottom tab bar steps aside, so the settings
 * button at the drawer's foot is not covered by it (#2642).
 *
 * The list screens run against the isolated E2E server (empty scan root); the
 * worktree screen mocks `/api/` the way the #2106 specs do.
 */

import { test, expect, type Page } from '@playwright/test';
import { mockOpencodeWorktreeApi, seedOpencodeActiveInstance } from './fixtures/opencode-mobile-helpers';

const VIEWPORT = { width: 390, height: 844 };

/** Worktree id scoped to this spec. */
const DRAWER_WORKTREE = 'e2e-drawer-3515';

const LIST_SCREENS = ['/repositories', '/sessions', '/review', '/more'] as const;

async function expectDrawerOpen(page: Page): Promise<void> {
  const container = page.getByTestId('sidebar-container');
  await expect(page.getByTestId('drawer-overlay')).toBeVisible();
  await expect(page.getByTestId('sidebar-drawer-close')).toBeInViewport();
  // The drawer's foot (settings menu) is on screen and nothing sits over it.
  const settings = container.getByTestId('sidebar-settings-menu');
  await expect(settings).toBeInViewport();
  await expect(page.getByTestId('global-mobile-nav')).toHaveCount(0);
  const box = await settings.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(VIEWPORT.height);
  // The PC key hint is not drawn in the drawer.
  await expect(container.locator('kbd')).toHaveCount(0);
}

async function expectDrawerClosed(page: Page): Promise<void> {
  await expect(page.getByTestId('drawer-overlay')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-drawer-close')).not.toBeInViewport();
}

test.describe('[Issue #3515] mobile drawer at 390x844', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
  });

  for (const path of LIST_SCREENS) {
    test(`${path}: Branches opens it, × and the overlay close it`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByTestId('app-shell')).toBeVisible();

      await page.getByTestId('mobile-nav-open-sidebar').click();
      await expectDrawerOpen(page);
      await page.getByTestId('sidebar-drawer-close').click();
      await expectDrawerClosed(page);
      await expect(page.getByTestId('global-mobile-nav')).toBeVisible();

      await page.getByTestId('mobile-nav-open-sidebar').click();
      await expectDrawerOpen(page);
      // Tap the overlay to the right of the drawer.
      await page.mouse.click(VIEWPORT.width - 10, VIEWPORT.height / 2);
      await expectDrawerClosed(page);
    });
  }

  test('[Issue #3575] the list toolbar is one row and its View / Sort menu stays on screen', async ({ page }) => {
    await page.goto('/repositories');
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.getByTestId('mobile-nav-open-sidebar').click();
    await expectDrawerOpen(page);

    const container = page.getByTestId('sidebar-container');
    const search = container.getByPlaceholder(/Search branches/i);
    const optionsTrigger = container.getByTestId('sidebar-list-options');
    const [searchBox, triggerBox] = await Promise.all([search.boundingBox(), optionsTrigger.boundingBox()]);
    expect(searchBox && triggerBox).toBeTruthy();
    expect(Math.abs(searchBox!.y + searchBox!.height / 2 - (triggerBox!.y + triggerBox!.height / 2))).toBeLessThanOrEqual(2);
    expect(triggerBox!.x + triggerBox!.width).toBeLessThanOrEqual(VIEWPORT.width);

    await optionsTrigger.click();
    const menu = page.getByTestId('sidebar-list-options-menu');
    await expect(menu).toBeVisible();
    const menuBox = await menu.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(menuBox!.x).toBeGreaterThanOrEqual(0);
    expect(menuBox!.y).toBeGreaterThanOrEqual(0);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(VIEWPORT.width);
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(VIEWPORT.height);

    await menu.getByRole('menuitemradio', { name: 'Session', exact: true }).click();
    await expect(optionsTrigger).toHaveAttribute('data-view-mode', 'sessions');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(optionsTrigger).toBeFocused();
    await expectDrawerOpen(page);
  });

  test('worktree screen: ☰ opens it, × and the overlay close it', async ({ page }) => {
    await mockOpencodeWorktreeApi(page, DRAWER_WORKTREE, 'claude');
    await seedOpencodeActiveInstance(page, DRAWER_WORKTREE, 'claude');
    await page.goto(`/worktrees/${DRAWER_WORKTREE}?pane=terminal`);
    await expect(page.getByTestId('app-shell')).toBeVisible();

    const menu = page.getByTestId('mobile-header-menu-button');
    await menu.click();
    await expectDrawerOpen(page);
    await page.getByTestId('sidebar-drawer-close').click();
    await expectDrawerClosed(page);

    await menu.click();
    await expectDrawerOpen(page);
    await page.mouse.click(VIEWPORT.width - 10, VIEWPORT.height / 2);
    await expectDrawerClosed(page);
  });
});
