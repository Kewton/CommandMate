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
 *   - "Refresh" is the "Sync branches" button.
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
    // Trigger is labelled with the active sort key; default is Updated (desc)
    const sortTrigger = page.getByRole('button', { name: /Sort by/i });
    await expect(sortTrigger).toBeVisible();
    await expect(sortTrigger).toContainText('Updated');
    await expect(page.getByRole('button', { name: /^(Newest first|Oldest first)$/ })).toBeVisible();

    // Opening the dropdown lists the sidebar sort keys
    await sortTrigger.click();
    const listbox = page.getByRole('listbox', { name: 'Sort options' });
    await expect(listbox).toBeVisible();
    for (const label of ['Updated', 'Repository name', 'Branch name', 'Status']) {
      await expect(listbox.getByRole('option', { name: label })).toBeVisible();
    }
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
    // Default sidebar sort is Updated, descending — shown as words
    const directionButton = page.getByRole('button', { name: 'Newest first' });
    await expect(directionButton).toBeVisible();

    await directionButton.click();

    await expect(page.getByRole('button', { name: 'Oldest first' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Newest first' })).toHaveCount(0);
  });

  test('should navigate to header navigation link', async ({ page }) => {
    // Check GitHub link
    const githubLink = page.getByRole('link', { name: /GitHub/i });
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
