/**
 * E2E Tests: File Tree Operations
 * Tests directory and file operations via context menu
 *
 * Phase 5 - Task 5.2
 */

import { test, expect } from '@playwright/test';

test.describe('File Tree Operations', () => {
  /**
   * Note: These tests assume at least one worktree exists with file access.
   * Some tests may need write permissions to the worktree.
   */

  test.describe('File Tree Navigation', () => {
    test('should display file tree when Files tab is selected', async ({ page }) => {
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
      if (await filesTab.count() > 0) {
        await filesTab.click();
        await page.waitForTimeout(500);

        // File tree should be visible
        const fileTree = page.locator('[data-testid="file-tree-view"]');
        await expect(fileTree).toBeVisible({ timeout: 5000 });
      }
    });

    test('should expand directory when clicked', async ({ page }) => {
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

      // Find a directory in the tree (look for folder icon)
      const folderItems = page.locator('[data-testid^="tree-item-"][aria-expanded]');
      if (await folderItems.count() > 0) {
        const folder = folderItems.first();
        const initialExpanded = await folder.getAttribute('aria-expanded');

        // Click to toggle
        await folder.click();
        await page.waitForTimeout(500);

        const newExpanded = await folder.getAttribute('aria-expanded');
        // State should have changed
        expect(newExpanded).not.toBe(initialExpanded);
      }
    });

    test('should show loading state while fetching directory contents', async ({ page }) => {
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
      if (await filesTab.count() > 0) {
        await filesTab.click();

        // Initially should show loading
        const loading = page.locator('[data-testid="file-tree-loading"]');
        // Loading might be too fast to catch, so we just check the tree eventually appears
        const fileTree = page.locator('[data-testid="file-tree-view"]');
        await expect(fileTree.or(loading)).toBeVisible({ timeout: 5000 });
      }
    });
  });

  test.describe('Context Menu Display', () => {
    test('should show context menu on right-click', async ({ page }) => {
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

      // Right-click to open context menu
      await treeItem.click({ button: 'right' });
      await page.waitForTimeout(300);

      // Context menu should appear
      const contextMenu = page.locator('[data-testid="context-menu"]');
      await expect(contextMenu).toBeVisible();
    });

    test('should show Rename and Delete options for files', async ({ page }) => {
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

      // Find a file (not directory) - look for items without aria-expanded
      const fileItems = page.locator('[data-testid^="tree-item-"]:not([aria-expanded])');
      if (await fileItems.count() === 0) return;

      // Right-click file
      await fileItems.first().click({ button: 'right' });
      await page.waitForTimeout(300);

      const contextMenu = page.locator('[data-testid="context-menu"]');
      if (await contextMenu.count() === 0) return;

      // Should have Rename and Delete options.
      // Issue #1277: menu labels are translated, so select by the locale-stable
      // data-testid rather than the (English-only) accessible name.
      const renameItem = contextMenu.getByTestId('context-menu-rename');
      const deleteItem = contextMenu.getByTestId('context-menu-delete');

      await expect(renameItem).toBeVisible();
      await expect(deleteItem).toBeVisible();

      // Should NOT have New File/New Directory (these are for directories only)
      const newFileItem = contextMenu.getByTestId('context-menu-new-file');
      await expect(newFileItem).not.toBeVisible();
    });

    test('should show New File, New Directory, Rename, Delete for directories', async ({ page }) => {
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

      // Find a directory (items with aria-expanded attribute)
      const dirItems = page.locator('[data-testid^="tree-item-"][aria-expanded]');
      if (await dirItems.count() === 0) return;

      // Right-click directory
      await dirItems.first().click({ button: 'right' });
      await page.waitForTimeout(300);

      const contextMenu = page.locator('[data-testid="context-menu"]');
      if (await contextMenu.count() === 0) return;

      // Should have all options for directories
      // Issue #1277: select by the locale-stable data-testid (labels are translated).
      const newFileItem = contextMenu.getByTestId('context-menu-new-file');
      const newDirItem = contextMenu.getByTestId('context-menu-new-directory');
      const renameItem = contextMenu.getByTestId('context-menu-rename');
      const deleteItem = contextMenu.getByTestId('context-menu-delete');

      await expect(newFileItem).toBeVisible();
      await expect(newDirItem).toBeVisible();
      await expect(renameItem).toBeVisible();
      await expect(deleteItem).toBeVisible();
    });

    test('should close context menu when clicking outside', async ({ page }) => {
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
      await expect(contextMenu).toBeVisible();

      // Click outside to close
      await page.mouse.click(10, 10);
      await page.waitForTimeout(300);

      // Context menu should be closed
      await expect(contextMenu).not.toBeVisible();
    });

    test('should close context menu on Escape key', async ({ page }) => {
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
      await expect(contextMenu).toBeVisible();

      // Press Escape to close
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      // Context menu should be closed
      await expect(contextMenu).not.toBeVisible();
    });
  });

  test.describe('Keyboard Navigation', () => {
    test('should allow keyboard navigation in file tree', async ({ page }) => {
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

      // Focus the tree item
      await treeItem.focus();

      // Should be focusable
      await expect(treeItem).toBeFocused();

      // Should respond to Enter key
      const isDir = await treeItem.getAttribute('aria-expanded') !== null;
      if (isDir) {
        const initialState = await treeItem.getAttribute('aria-expanded');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);

        // State should toggle
        const newState = await treeItem.getAttribute('aria-expanded');
        expect(newState).not.toBe(initialState);
      }
    });

    test('should navigate context menu with arrow keys', async ({ page }) => {
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

      const dirItem = page.locator('[data-testid^="tree-item-"][aria-expanded]').first();
      if (await dirItem.count() === 0) return;

      // Open context menu
      await dirItem.click({ button: 'right' });
      await page.waitForTimeout(300);

      const contextMenu = page.locator('[data-testid="context-menu"]');
      if (await contextMenu.count() === 0) return;

      // First menu item should be focused
      const firstItem = contextMenu.getByRole('menuitem').first();
      await expect(firstItem).toBeFocused();

      // Arrow down should move focus
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(100);

      const secondItem = contextMenu.getByRole('menuitem').nth(1);
      await expect(secondItem).toBeFocused();
    });
  });

  test.describe('File Icons', () => {
    test('should display folder icons for directories', async ({ page }) => {
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

      // Should have folder icon
      const folderIcon = dirItem.locator('[data-testid="folder-icon"]');
      await expect(folderIcon).toBeVisible();
    });

    test('should display file icons for files', async ({ page }) => {
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

      // Should have file icon
      const fileIcon = fileItem.locator('[data-testid="file-icon"]');
      await expect(fileIcon).toBeVisible();
    });

    test('should display chevron icon for directories', async ({ page }) => {
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

      // Should have chevron icon
      const chevronIcon = dirItem.locator('[data-testid="chevron-icon"]');
      await expect(chevronIcon).toBeVisible();
    });
  });
});
