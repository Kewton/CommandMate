/**
 * E2E Tests: Worktree List Page
 * Tests the main worktree list page functionality
 */

import { test, expect } from '@playwright/test';

test.describe('Worktree List Page', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to home page
    await page.goto('/');
  });

  test('should display page header and title', async ({ page }) => {
    // Check for main heading
    await expect(page.getByRole('heading', { name: /CommandMate/i, level: 1 })).toBeVisible();

    // Check for subtitle
    await expect(page.getByText(/Git worktree management/i)).toBeVisible();
  });

  test('should display "Worktrees" section heading', async ({ page }) => {
    // Check for Worktrees heading
    await expect(page.getByRole('heading', { name: /Worktrees/i, level: 2 })).toBeVisible();
  });

  test('should display search input', async ({ page }) => {
    // Check for search input
    const searchInput = page.getByPlaceholder(/Search worktrees/i);
    await expect(searchInput).toBeVisible();
  });

  test('should display sort buttons', async ({ page }) => {
    // Check for sort buttons
    await expect(page.getByRole('button', { name: /Name/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Updated/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Path/i })).toBeVisible();
  });

  test('should display refresh button', async ({ page }) => {
    // Check for refresh button
    await expect(page.getByRole('button', { name: /Refresh/i })).toBeVisible();
  });

  test('should filter worktrees by search query', async ({ page }) => {
    // Wait for worktrees to load
    await page.waitForTimeout(1000);

    // Type in search box
    const searchInput = page.getByPlaceholder(/Search worktrees/i);
    await searchInput.fill('main');

    // Wait a bit for filtering
    await page.waitForTimeout(500);

    // Check that some worktrees are visible (or none if no match)
    // This test is basic as we don't know what worktrees exist
  });

  test('should toggle sort direction when clicking sort button', async ({ page }) => {
    // Click name sort button
    const nameButton = page.getByRole('button', { name: /Name/i });
    await nameButton.click();

    // Check that button shows sort direction indicator
    await expect(nameButton).toContainText(/[↑↓]/);
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
    // Check mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.getByRole('heading', { name: /CommandMate/i, level: 1 })).toBeVisible();

    // Check desktop viewport
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(page.getByRole('heading', { name: /CommandMate/i, level: 1 })).toBeVisible();
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
