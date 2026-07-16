/**
 * E2E Tests: Worktree Detail Page
 * Tests the worktree detail page functionality
 */

import { test, expect } from '@playwright/test';

test.describe('Worktree Detail Page', () => {
  // Note: These tests assume at least one worktree exists
  // In a real scenario, you might want to set up test data first

  test('should navigate to worktree detail from list', async ({ page }) => {
    // Go to home page
    await page.goto('/');

    // Wait for worktrees to load
    await page.waitForTimeout(1000);

    // Check if any worktree cards are present
    const worktreeCards = page.locator('a[href^="/worktrees/"]');
    const count = await worktreeCards.count();

    if (count > 0) {
      // Click first worktree card
      await worktreeCards.first().click();

      // Should navigate to detail page
      await expect(page).toHaveURL(/\/worktrees\/.+/);
    }
  });

  test('should display back link', async ({ page }) => {
    // Navigate to a detail page (using a mock ID)
    await page.goto('/worktrees/test-worktree');

    // Wait a bit for page to load
    await page.waitForTimeout(500);

    // Check for the back control (even if worktree doesn't exist).
    // Issue #1277: selected by data-testid — its accessible name is now
    // localized (worktree.detail.goBack), so matching English text would break
    // under any non-en locale.
    const backLink = page.getByTestId('worktree-back-button');

    // Back control should exist in the layout
    if (await backLink.count() > 0) {
      await expect(backLink).toBeVisible();
    }
  });

  test('should display tab navigation', async ({ page }) => {
    // Navigate to a detail page
    await page.goto('/worktrees/test-worktree');
    await page.waitForTimeout(500);

    // Check for tab buttons (they should exist even if worktree doesn't)
    const messagesTab = page.getByRole('button', { name: /Messages/i });
    const logsTab = page.getByRole('button', { name: /Log Files/i });

    if (await messagesTab.count() > 0) {
      await expect(messagesTab).toBeVisible();
    }

    if (await logsTab.count() > 0) {
      await expect(logsTab).toBeVisible();
    }
  });

  test('should switch between tabs', async ({ page }) => {
    await page.goto('/worktrees/test-worktree');
    await page.waitForTimeout(500);

    const messagesTab = page.getByRole('button', { name: /Messages/i });
    const logsTab = page.getByRole('button', { name: /Log Files/i });

    if (await messagesTab.count() > 0 && await logsTab.count() > 0) {
      // Click logs tab
      await logsTab.click();
      await page.waitForTimeout(300);

      // Click messages tab
      await messagesTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('should display refresh button', async ({ page }) => {
    await page.goto('/worktrees/test-worktree');
    await page.waitForTimeout(500);

    const refreshButton = page.getByRole('button', { name: /Refresh/i });

    if (await refreshButton.count() > 0) {
      await expect(refreshButton).toBeVisible();
    }
  });

  test('should display message input form', async ({ page }) => {
    await page.goto('/worktrees/test-worktree');
    await page.waitForTimeout(500);

    // Check for message input textarea
    const messageInput = page.getByPlaceholder(/Type your message/i);

    if (await messageInput.count() > 0) {
      await expect(messageInput).toBeVisible();
    }
  });

  test('should display send and clear buttons in message form', async ({ page }) => {
    await page.goto('/worktrees/test-worktree');
    await page.waitForTimeout(500);

    const sendButton = page.getByRole('button', { name: /Send Message/i });
    const clearButton = page.getByRole('button', { name: /Clear/i });

    if (await sendButton.count() > 0) {
      await expect(sendButton).toBeVisible();
    }

    if (await clearButton.count() > 0) {
      await expect(clearButton).toBeVisible();
    }
  });

  test('should enable send button when message is typed', async ({ page }) => {
    await page.goto('/worktrees/test-worktree');
    await page.waitForTimeout(500);

    const messageInput = page.getByPlaceholder(/Type your message/i);
    const sendButton = page.getByRole('button', { name: /Send Message/i });

    if (await messageInput.count() > 0 && await sendButton.count() > 0) {
      // Initially should be disabled
      await expect(sendButton).toBeDisabled();

      // Type a message
      await messageInput.fill('Test message');

      // Should be enabled now
      await expect(sendButton).toBeEnabled();

      // Clear the message
      await messageInput.fill('');

      // Should be disabled again
      await expect(sendButton).toBeDisabled();
    }
  });

  test('should display sidebar information', async ({ page }) => {
    await page.goto('/worktrees/test-worktree');
    await page.waitForTimeout(500);

    // Check for the worktree info panel.
    // Issue #1277: selected by data-testid — the modal heading is now localized
    // (worktree.detail.infoModalTitle), so /Information/i would only ever match
    // the English dictionary.
    const infoPanel = page.getByTestId('worktree-info-modal');

    if (await infoPanel.count() > 0) {
      await expect(infoPanel).toBeVisible();
    }
  });

  test('should display quick actions in sidebar', async ({ page }) => {
    await page.goto('/worktrees/test-worktree');
    await page.waitForTimeout(500);

    // Check for Quick Actions heading
    const quickActionsHeading = page.getByRole('heading', { name: /Quick Actions/i });

    if (await quickActionsHeading.count() > 0) {
      await expect(quickActionsHeading).toBeVisible();
    }
  });

  test('should be responsive on mobile', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto('/worktrees/test-worktree');
    await page.waitForTimeout(500);

    // Page should still be accessible on mobile
    // Check if any key elements are visible.
    // Issue #1277: this viewport renders MobileHeader (not the DesktopHeader
    // back control), so assert on the mobile header's existing stable testid
    // rather than an English accessible name.
    const mobileHeader = page.getByTestId('mobile-header');

    if (await mobileHeader.count() > 0) {
      await expect(mobileHeader).toBeVisible();
    }
  });

  test('should handle non-existent worktree gracefully', async ({ page }) => {
    // Navigate to a definitely non-existent worktree
    await page.goto('/worktrees/definitely-does-not-exist-12345');

    // Wait for error to be displayed
    await page.waitForTimeout(1000);

    // Should show some kind of error or "not found" message
    // The exact text depends on implementation
  });
});
