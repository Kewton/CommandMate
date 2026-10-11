/**
 * E2E Tests: Home page (branch list + app chrome)
 *
 * The file name is historical: this page listed worktrees in a main-content
 * table when the suite was written. Since Issue #600 / #1052 / #1072 the route
 * is a dashboard — the branch list lives in the sidebar. `/` は開く画面を決めて
 * 移動する。E2E サーバーは一覧が空なので空状態（初回ガイド）を表示する（Issue #2643）。
 *
 * [Issue #1180] Re-pointed at that UI. What changed and why the old assertions
 * could not simply be re-selected:
 *   - The "Git worktree management" subtitle no longer exists anywhere on the
 *     page. Issue #1072 removed the welcome banner and demoted the tautological
 *     "CommandMate" h1 to a functional "Overview" heading. The string survives
 *     only in layout metadata / manifest / CLI --help, none of which render.
 *   - The "Worktrees" h2 is gone; the sidebar header is a Repositories / Sessions / Review navigation list (Issue #2644).
 *   - Search is "Search branches..." in the sidebar, not "Search worktrees".
 *   - Sort is a dropdown (Updated / Repository name / Branch name / Status) with a worded direction toggle (Newest first / Oldest first, …), not Name / Updated / Path buttons with ↑↓ text.
 *     [Issue #3575] View and Sort are a menu behind the filter icon at the end of the search row.
 *   - "Refresh" is the "Sync branches" button.
 *   - [Issue #3512] The header is the screen name + status only; GitHub is a
 *     settings-menu item (sidebar footer / icon rail).
 *
 * These specs assert app chrome only, so they hold with zero worktrees — which
 * is what the server under test always has (playwright.config.ts pins
 * CM_ROOT_DIR at an empty, non-git scan root).
 */

import { test, expect } from '@playwright/test';

test.describe('Home Page', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to home page
    await page.goto('/');
  });

  test('should display the first-run screen when no repository is registered', async ({ page }) => {
    // Header wordmark
    await expect(page.getByRole('heading', { name: /CommandMate/i, level: 1 })).toBeVisible();

    await expect(page.getByTestId('home-empty')).toBeVisible();
    await expect(page.getByTestId('home-add-repository')).toHaveAttribute('href', '/repositories');
  });

  test('should display the sidebar navigation', async ({ page }) => {
    const nav = page.getByTestId('sidebar-nav');
    await expect(nav.getByRole('link', { name: 'Repositories' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Sessions' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Review' })).toBeVisible();
  });

  test('should display search input', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/Search branches/i);
    await expect(searchInput).toBeVisible();
  });

  test('should display sort controls', async ({ page }) => {
    // [Issue #3575] The filter icon is labelled with the active view and sort;
    // default is Repository, Updated (desc)
    const optionsTrigger = page.getByTestId('sidebar-list-options');
    await expect(optionsTrigger).toBeVisible();
    await expect(optionsTrigger).toHaveAccessibleName('View and sort (Repository · Updated · Newest first)');

    // Opening the menu lists the views, the sidebar sort keys and the directions
    await optionsTrigger.click();
    const menu = page.getByTestId('sidebar-list-options-menu');
    await expect(menu).toBeVisible();
    for (const label of ['Repository', 'Branch', 'Session', 'Updated', 'Repository name', 'Branch name', 'Status', 'Newest first', 'Oldest first']) {
      await expect(menu.getByRole('menuitemradio', { name: label, exact: true })).toBeVisible();
    }
  });

  test('[Issue #3575] keeps the filter and the View / Sort icon on one row', async ({ page }) => {
    const toolbar = page.getByTestId('sidebar-list-toolbar');
    const search = toolbar.getByPlaceholder(/Search branches/i);
    const optionsTrigger = toolbar.getByTestId('sidebar-list-options');
    const [toolbarBox, searchBox, triggerBox] = await Promise.all([
      toolbar.boundingBox(),
      search.boundingBox(),
      optionsTrigger.boundingBox(),
    ]);
    expect(toolbarBox && searchBox && triggerBox).toBeTruthy();
    // Same row: vertical centres agree, and the icon sits after the field.
    expect(Math.abs(searchBox!.y + searchBox!.height / 2 - (triggerBox!.y + triggerBox!.height / 2))).toBeLessThanOrEqual(2);
    expect(triggerBox!.x).toBeGreaterThanOrEqual(searchBox!.x + searchBox!.width);
    // One row: well under the ~150px the three rows used to take.
    expect(toolbarBox!.height).toBeLessThanOrEqual(48);
  });

  test('[Issue #3575] changes View and Sort from the keyboard and returns focus on Escape', async ({ page }) => {
    const optionsTrigger = page.getByTestId('sidebar-list-options');
    await optionsTrigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByTestId('sidebar-list-options-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Repository', exact: true })).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitemradio', { name: 'Branch', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(optionsTrigger).toHaveAttribute('data-view-mode', 'flat');

    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitemradio', { name: 'Oldest first' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(optionsTrigger).toHaveAttribute('data-sort-direction', 'asc');
    await expect(page.getByTestId('sidebar-list-options-indicator')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(optionsTrigger).toBeFocused();
  });

  test('should display sync button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Sync branches/i })).toBeVisible();
  });

  test('should filter branches by search query', async ({ page }) => {
    const branchList = page.getByTestId('branch-list');

    // The E2E server scans an empty root, so the list starts in its empty state
    await expect(branchList).toContainText('No branches available');

    // A query that matches nothing switches the empty state wording, which is
    // what proves the query reached the filter rather than being swallowed.
    await page.getByPlaceholder(/Search branches/i).fill('no-such-branch-xyz');
    await expect(branchList).toContainText('No branches found');

    // Clearing restores the unfiltered empty state
    await page.getByPlaceholder(/Search branches/i).fill('');
    await expect(branchList).toContainText('No branches available');
  });

  test('should toggle sort direction when clicking sort direction button', async ({ page }) => {
    // Default sidebar sort is Updated, descending — shown as words.
    // [Issue #3575] The direction is a choice in the View / Sort menu.
    const optionsTrigger = page.getByTestId('sidebar-list-options');
    await optionsTrigger.click();
    const menu = page.getByTestId('sidebar-list-options-menu');
    await expect(menu.getByRole('menuitemradio', { name: 'Newest first' })).toHaveAttribute('aria-checked', 'true');

    await menu.getByRole('menuitemradio', { name: 'Oldest first' }).click();

    await expect(menu.getByRole('menuitemradio', { name: 'Oldest first' })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitemradio', { name: 'Newest first' })).toHaveAttribute('aria-checked', 'false');
    // The open menu hides the rest of the page from assistive tech, so read
    // the icon's hover title rather than its accessible name.
    await expect(optionsTrigger).toHaveAttribute('title', /Updated · Oldest first/);
  });

  test('should navigate to header navigation link', async ({ page }) => {
    // Issue #3512: GitHub left the header; it is an item of the shared settings
    // menu, opened from the sidebar footer (the desktop sidebar is open here).
    await page.getByTestId('sidebar-settings-menu').click();
    const githubLink = page.getByRole('menuitem', { name: /GitHub/i });
    await expect(githubLink).toBeVisible();
    await expect(githubLink).toHaveAttribute('href', /github/i);
    await expect(githubLink).toHaveAttribute('target', '_blank');
  });

  test('should display header with logo', async ({ page }) => {
    // Check for logo/icon in header
    const header = page.locator('header');
    await expect(header).toBeVisible();
  });

  test('should be responsive', async ({ page }) => {
    // The desktop header is hidden on mobile (GlobalMobileNav takes over), so
    // assert on the empty state's link, which is present in both layouts.
    const addRepository = page.getByTestId('home-add-repository');

    // Check mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(addRepository).toBeVisible();

    // Check desktop viewport
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(addRepository).toBeVisible();
  });

  // TODO: Footer未実装のためスキップ
  test.skip('should display footer', async ({ page }) => {
    // Scroll to bottom
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    // Check for footer
    const footer = page.locator('footer');
    await expect(footer).toBeVisible();
    await expect(footer).toContainText(/CommandMate/i);
  });
});
