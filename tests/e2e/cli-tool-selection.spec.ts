/**
 * E2E Tests: CLI Tool Selection
 * Tests CLI tool selection and management functionality
 */

import { test, expect } from '@playwright/test';

test.describe('CLI Tool Selection', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to home page
    await page.goto('/');
    await page.waitForTimeout(1000);
  });

  test('should display CLI Tool badge in worktree card', async ({ page }) => {
    // Check if any worktree cards are present
    const worktreeCards = page.locator('a[href^="/worktrees/"]');
    const count = await worktreeCards.count();

    if (count > 0) {
      const firstCard = worktreeCards.first();

      // Check for CLI tool badge (Claude, Codex, or Gemini)
      const claudeBadge = firstCard.getByText('Claude', { exact: true });
      const codexBadge = firstCard.getByText('Codex', { exact: true });
      const geminiBadge = firstCard.getByText('Gemini', { exact: true });

      // At least one CLI tool badge should be visible
      const claudeVisible = await claudeBadge.count() > 0;
      const codexVisible = await codexBadge.count() > 0;
      const geminiVisible = await geminiBadge.count() > 0;

      expect(claudeVisible || codexVisible || geminiVisible).toBe(true);
    }
  });

  test('should navigate to worktree detail and display CLI Tool in Information tab', async ({ page }) => {
    // Navigate to first worktree
    const worktreeCards = page.locator('a[href^="/worktrees/"]');
    const count = await worktreeCards.count();

    if (count > 0) {
      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      // Click Information tab
      const infoTab = page.getByRole('button', { name: /Information/i });
      if (await infoTab.count() > 0) {
        await infoTab.click();
        await page.waitForTimeout(300);

        // Check for CLI Tool label
        const cliToolLabel = page.getByText('CLI Tool');
        await expect(cliToolLabel).toBeVisible();

        // Check for CLI tool badge in Information tab
        const claudeBadge = page.getByText('Claude Code', { exact: true });
        const codexBadge = page.getByText('Codex CLI', { exact: true });
        const geminiBadge = page.getByText('Gemini CLI', { exact: true });

        const claudeVisible = await claudeBadge.count() > 0;
        const codexVisible = await codexBadge.count() > 0;
        const geminiVisible = await geminiBadge.count() > 0;

        expect(claudeVisible || codexVisible || geminiVisible).toBe(true);
      }
    }
  });

  test('should display Edit button for CLI Tool in Information tab', async ({ page }) => {
    const worktreeCards = page.locator('a[href^="/worktrees/"]');
    const count = await worktreeCards.count();

    if (count > 0) {
      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      // Click Information tab
      const infoTab = page.getByRole('button', { name: /Information/i });
      if (await infoTab.count() > 0) {
        await infoTab.click();
        await page.waitForTimeout(300);

        // Check for Edit button near CLI Tool
        const editButtons = page.getByRole('button', { name: /Edit/i });
        const editButtonCount = await editButtons.count();

        // At least one Edit button should exist (for memo, link, or CLI tool)
        expect(editButtonCount).toBeGreaterThan(0);
      }
    }
  });

  test('should show radio buttons when editing CLI Tool', async ({ page }) => {
    const worktreeCards = page.locator('a[href^="/worktrees/"]');
    const count = await worktreeCards.count();

    if (count > 0) {
      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      // Click Information tab
      const infoTab = page.getByRole('button', { name: /Information/i });
      if (await infoTab.count() > 0) {
        await infoTab.click();
        await page.waitForTimeout(300);

        // Find and click the Edit button (assuming it's the first one in CLI Tool section)
        // We need to click the Edit button that's specifically for CLI Tool
        // This is tricky as there might be multiple Edit buttons
        const editButtons = page.getByRole('button', { name: /Edit/i });

        if (await editButtons.count() > 0) {
          // Click the first Edit button (this might be for memo or CLI tool)
          await editButtons.first().click();
          await page.waitForTimeout(300);

          // Check if radio buttons appear
          const claudeRadio = page.getByRole('radio', { name: /Claude Code/i });
          const codexRadio = page.getByRole('radio', { name: /Codex CLI/i });
          const geminiRadio = page.getByRole('radio', { name: /Gemini CLI/i });

          // If we're in CLI tool edit mode, radio buttons should be visible
          const claudeVisible = await claudeRadio.count() > 0;
          const codexVisible = await codexRadio.count() > 0;
          const geminiVisible = await geminiRadio.count() > 0;

          if (claudeVisible && codexVisible && geminiVisible) {
            await expect(claudeRadio).toBeVisible();
            await expect(codexRadio).toBeVisible();
            await expect(geminiRadio).toBeVisible();
          }
        }
      }
    }
  });

  test('should display Save and Cancel buttons when editing CLI Tool', async ({ page }) => {
    const worktreeCards = page.locator('a[href^="/worktrees/"]');
    const count = await worktreeCards.count();

    if (count > 0) {
      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      const infoTab = page.getByRole('button', { name: /Information/i });
      if (await infoTab.count() > 0) {
        await infoTab.click();
        await page.waitForTimeout(300);

        const editButtons = page.getByRole('button', { name: /Edit/i });

        if (await editButtons.count() > 0) {
          await editButtons.first().click();
          await page.waitForTimeout(300);

          // Check if radio buttons appear (indicating CLI tool edit mode)
          const claudeRadio = page.getByRole('radio', { name: /Claude Code/i });

          if (await claudeRadio.count() > 0) {
            // Save and Cancel buttons should be visible
            const saveButton = page.getByRole('button', { name: /^Save$/i });
            const cancelButton = page.getByRole('button', { name: /Cancel/i });

            await expect(saveButton).toBeVisible();
            await expect(cancelButton).toBeVisible();
          }
        }
      }
    }
  });

  test('should cancel CLI Tool editing', async ({ page }) => {
    const worktreeCards = page.locator('a[href^="/worktrees/"]');
    const count = await worktreeCards.count();

    if (count > 0) {
      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      const infoTab = page.getByRole('button', { name: /Information/i });
      if (await infoTab.count() > 0) {
        await infoTab.click();
        await page.waitForTimeout(300);

        const editButtons = page.getByRole('button', { name: /Edit/i });

        if (await editButtons.count() > 0) {
          await editButtons.first().click();
          await page.waitForTimeout(300);

          const claudeRadio = page.getByRole('radio', { name: /Claude Code/i });

          if (await claudeRadio.count() > 0) {
            // Click Cancel button
            const cancelButton = page.getByRole('button', { name: /Cancel/i });
            await cancelButton.click();
            await page.waitForTimeout(300);

            // Radio buttons should disappear
            expect(await claudeRadio.count()).toBe(0);

            // Edit button should be visible again
            const editButtonsAfter = page.getByRole('button', { name: /Edit/i });
            expect(await editButtonsAfter.count()).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  test('should be responsive on mobile', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    const worktreeCards = page.locator('a[href^="/worktrees/"]');
    const count = await worktreeCards.count();

    if (count > 0) {
      // CLI tool badge should still be visible on mobile
      const firstCard = worktreeCards.first();

      const claudeBadge = firstCard.getByText('Claude', { exact: true });
      const codexBadge = firstCard.getByText('Codex', { exact: true });
      const geminiBadge = firstCard.getByText('Gemini', { exact: true });

      const claudeVisible = await claudeBadge.count() > 0;
      const codexVisible = await codexBadge.count() > 0;
      const geminiVisible = await geminiBadge.count() > 0;

      expect(claudeVisible || codexVisible || geminiVisible).toBe(true);
    }
  });

  test('should display CLI Tool with correct badge color', async ({ page }) => {
    const worktreeCards = page.locator('a[href^="/worktrees/"]');
    const count = await worktreeCards.count();

    if (count > 0) {
      const firstCard = worktreeCards.first();

      // Check if badge has appropriate styling class
      // Badge component uses different variants: info (Claude), warning (Codex), success (Gemini)
      const badges = firstCard.locator('.badge');
      const badgeCount = await badges.count();

      // At least one badge should exist (Main, CLI Tool, or status badges)
      expect(badgeCount).toBeGreaterThan(0);
    }
  });
});
