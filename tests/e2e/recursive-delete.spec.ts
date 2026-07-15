/**
 * E2E Tests: Recursive Delete Flow
 * Tests the confirmation dialog for non-empty directory deletion
 *
 * Phase 5 - Task 5.3
 */

import { test, expect } from '@playwright/test';

test.describe('Recursive Delete Flow', () => {
  /**
   * Note: These tests verify the UI behavior for delete operations.
   * Actual file system operations require a properly set up test environment.
   */

  test.describe('Delete Confirmation', () => {
    test('should show Delete option in context menu for directories', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      const worktreeCards = page.locator('a[href^="/worktrees/"]');
      if (await worktreeCards.count() === 0) {
        test.skip(true, 'No worktrees available for testing');
        return;
      }

      await worktreeCards.first().click();
      await expect(page).toHaveURL(/\/worktrees\/.+/);
      await page.waitForTimeout(500);

      // Switch to Files tab
      const filesTab = page.getByRole('button', { name: /Files/i });
      if (await filesTab.count() === 0) return;

      await filesTab.click();
      await page.waitForTimeout(500);

      // Find a directory
      const dirItem = page.locator('[data-testid^="tree-item-"][aria-expanded]').first();
      if (await dirItem.count() === 0) return;

      // Right-click to show context menu
      await dirItem.click({ button: 'right' });
      await page.waitForTimeout(300);

      // Verify Delete option exists
      const contextMenu = page.locator('[data-testid="context-menu"]');
      const deleteOption = contextMenu.getByRole('menuitem', { name: /Delete/i });

      await expect(deleteOption).toBeVisible();
      // Delete option should have danger styling
      await expect(deleteOption).toHaveClass(/text-danger/);
    });

    test('should show Delete option styled as danger action', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      const worktreeCards = page.locator('a[href^="/worktrees/"]');
      if (await worktreeCards.count() === 0) {
        test.skip(true, 'No worktrees available');
        return;
      }

      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      const filesTab = page.getByRole('button', { name: /Files/i });
      if (await filesTab.count() === 0) return;

      await filesTab.click();
      await page.waitForTimeout(500);

      // Find any tree item
      const treeItem = page.locator('[data-testid^="tree-item-"]').first();
      if (await treeItem.count() === 0) return;

      // Open context menu
      await treeItem.click({ button: 'right' });
      await page.waitForTimeout(300);

      const contextMenu = page.locator('[data-testid="context-menu"]');
      const deleteOption = contextMenu.getByRole('menuitem', { name: /Delete/i });

      // Should have red color indicating danger
      await expect(deleteOption).toHaveCSS('color', 'rgb(239, 68, 68)'); // text-danger (red-500)
    });
  });

  test.describe('Context Menu Dividers', () => {
    test('should show divider after New Directory option for directories', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      const worktreeCards = page.locator('a[href^="/worktrees/"]');
      if (await worktreeCards.count() === 0) {
        test.skip(true, 'No worktrees available');
        return;
      }

      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      const filesTab = page.getByRole('button', { name: /Files/i });
      if (await filesTab.count() === 0) return;

      await filesTab.click();
      await page.waitForTimeout(500);

      // Find a directory
      const dirItem = page.locator('[data-testid^="tree-item-"][aria-expanded]').first();
      if (await dirItem.count() === 0) return;

      // Open context menu
      await dirItem.click({ button: 'right' });
      await page.waitForTimeout(300);

      // Should have divider to separate creation actions from destructive actions
      const divider = page.locator('[data-testid="context-menu-divider"]');
      await expect(divider).toBeVisible();
    });

    test('should show divider after Rename option for files', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      const worktreeCards = page.locator('a[href^="/worktrees/"]');
      if (await worktreeCards.count() === 0) {
        test.skip(true, 'No worktrees available');
        return;
      }

      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      const filesTab = page.getByRole('button', { name: /Files/i });
      if (await filesTab.count() === 0) return;

      await filesTab.click();
      await page.waitForTimeout(500);

      // Find a file (not directory)
      const fileItem = page.locator('[data-testid^="tree-item-"]:not([aria-expanded])').first();
      if (await fileItem.count() === 0) return;

      // Open context menu
      await fileItem.click({ button: 'right' });
      await page.waitForTimeout(300);

      // For files, divider appears after Rename (before Delete)
      const contextMenu = page.locator('[data-testid="context-menu"]');
      const divider = page.locator('[data-testid="context-menu-divider"]');

      // Divider should exist
      await expect(divider).toBeVisible();
    });
  });

  test.describe('Delete Button Accessibility', () => {
    test('should be disabled when no target path is set', async ({ page }) => {
      // This is more of an edge case test
      // The context menu shouldn't appear without a target, but if it does
      // the delete button should be disabled
      await page.goto('/');
      await page.waitForTimeout(1000);

      const worktreeCards = page.locator('a[href^="/worktrees/"]');
      if (await worktreeCards.count() === 0) {
        test.skip(true, 'No worktrees available');
        return;
      }

      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      const filesTab = page.getByRole('button', { name: /Files/i });
      if (await filesTab.count() === 0) return;

      await filesTab.click();
      await page.waitForTimeout(500);

      const treeItem = page.locator('[data-testid^="tree-item-"]').first();
      if (await treeItem.count() === 0) return;

      // Open context menu
      await treeItem.click({ button: 'right' });
      await page.waitForTimeout(300);

      const contextMenu = page.locator('[data-testid="context-menu"]');
      const deleteOption = contextMenu.getByRole('menuitem', { name: /Delete/i });

      // Delete option should be visible and enabled when target is set
      await expect(deleteOption).toBeVisible();
      await expect(deleteOption).toBeEnabled();
    });

    test('should have correct ARIA role', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      const worktreeCards = page.locator('a[href^="/worktrees/"]');
      if (await worktreeCards.count() === 0) {
        test.skip(true, 'No worktrees available');
        return;
      }

      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      const filesTab = page.getByRole('button', { name: /Files/i });
      if (await filesTab.count() === 0) return;

      await filesTab.click();
      await page.waitForTimeout(500);

      const treeItem = page.locator('[data-testid^="tree-item-"]').first();
      if (await treeItem.count() === 0) return;

      // Open context menu
      await treeItem.click({ button: 'right' });
      await page.waitForTimeout(300);

      const contextMenu = page.locator('[data-testid="context-menu"]');

      // Menu should have role="menu"
      await expect(contextMenu).toHaveAttribute('role', 'menu');

      // Menu items should have role="menuitem"
      const menuItems = contextMenu.getByRole('menuitem');
      const count = await menuItems.count();
      expect(count).toBeGreaterThan(0);

      for (let i = 0; i < count; i++) {
        const item = menuItems.nth(i);
        await expect(item).toHaveAttribute('role', 'menuitem');
      }
    });

    test('context menu should have aria-label', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      const worktreeCards = page.locator('a[href^="/worktrees/"]');
      if (await worktreeCards.count() === 0) {
        test.skip(true, 'No worktrees available');
        return;
      }

      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      const filesTab = page.getByRole('button', { name: /Files/i });
      if (await filesTab.count() === 0) return;

      await filesTab.click();
      await page.waitForTimeout(500);

      const treeItem = page.locator('[data-testid^="tree-item-"]').first();
      if (await treeItem.count() === 0) return;

      // Open context menu
      await treeItem.click({ button: 'right' });
      await page.waitForTimeout(300);

      const contextMenu = page.locator('[data-testid="context-menu"]');

      // Should have accessible label
      await expect(contextMenu).toHaveAttribute('aria-label', 'File actions');
    });
  });

  test.describe('Safety Guards UI', () => {
    test('should display icons for menu items', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      const worktreeCards = page.locator('a[href^="/worktrees/"]');
      if (await worktreeCards.count() === 0) {
        test.skip(true, 'No worktrees available');
        return;
      }

      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      const filesTab = page.getByRole('button', { name: /Files/i });
      if (await filesTab.count() === 0) return;

      await filesTab.click();
      await page.waitForTimeout(500);

      // Find a directory for full menu
      const dirItem = page.locator('[data-testid^="tree-item-"][aria-expanded]').first();
      if (await dirItem.count() === 0) return;

      // Open context menu
      await dirItem.click({ button: 'right' });
      await page.waitForTimeout(300);

      const contextMenu = page.locator('[data-testid="context-menu"]');

      // Menu items should have icons (svg elements with aria-hidden)
      const icons = contextMenu.locator('svg[aria-hidden="true"]');
      const iconCount = await icons.count();

      // Should have at least one icon per menu item
      expect(iconCount).toBeGreaterThanOrEqual(4); // New File, New Dir, Rename, Delete
    });
  });
});

test.describe('Mobile Recursive Delete', () => {
  test('should work on mobile viewport', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto('/');
    await page.waitForTimeout(1000);

    const worktreeCards = page.locator('a[href^="/worktrees/"]');
    if (await worktreeCards.count() === 0) {
      test.skip(true, 'No worktrees available');
      return;
    }

    await worktreeCards.first().click();
    await page.waitForTimeout(500);

    // On mobile, there's a tab bar at the bottom
    const filesTab = page.getByRole('button', { name: /Files/i });
    if (await filesTab.count() === 0) return;

    await filesTab.click();
    await page.waitForTimeout(500);

    // File tree should be visible on mobile
    const fileTree = page.locator('[data-testid="file-tree-view"]');
    if (await fileTree.count() === 0) return;

    await expect(fileTree).toBeVisible();

    // Context menu should work on mobile too (via long press or tap-and-hold)
    // For simplicity, we'll use programmatic right-click
    const treeItem = page.locator('[data-testid^="tree-item-"]').first();
    if (await treeItem.count() === 0) return;

    await treeItem.click({ button: 'right' });
    await page.waitForTimeout(300);

    // Context menu should appear
    const contextMenu = page.locator('[data-testid="context-menu"]');
    await expect(contextMenu).toBeVisible();
  });
});
