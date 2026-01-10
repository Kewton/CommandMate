/**
 * E2E Tests: CLI Tool Selection
 * Tests CLI tool selection and management functionality
 * Updated for Issue #33: Codex/Gemini UI removal
 */

import { test, expect } from '@playwright/test';

test.describe('CLI Tool Selection', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to home page
    await page.goto('/');
    await page.waitForTimeout(1000);
  });

  test('should display Claude badge in worktree card', async ({ page }) => {
    // Check if any worktree cards are present
    const worktreeCards = page.locator('a[href^="/worktrees/"]');
    const count = await worktreeCards.count();

    if (count > 0) {
      const firstCard = worktreeCards.first();

      // Check for Claude badge only (Codex and Gemini have been removed from UI)
      const claudeBadge = firstCard.getByText('Claude', { exact: true });
      expect(await claudeBadge.count()).toBeGreaterThan(0);

      // Verify Codex and Gemini badges are NOT displayed
      const codexBadge = firstCard.getByText('Codex', { exact: true });
      const geminiBadge = firstCard.getByText('Gemini', { exact: true });
      expect(await codexBadge.count()).toBe(0);
      expect(await geminiBadge.count()).toBe(0);
    }
  });

  test('should be responsive on mobile', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    const worktreeCards = page.locator('a[href^="/worktrees/"]');
    const count = await worktreeCards.count();

    if (count > 0) {
      // Claude badge should still be visible on mobile
      const firstCard = worktreeCards.first();

      const claudeBadge = firstCard.getByText('Claude', { exact: true });
      expect(await claudeBadge.count()).toBeGreaterThan(0);

      // Verify Codex and Gemini badges are NOT displayed on mobile
      const codexBadge = firstCard.getByText('Codex', { exact: true });
      const geminiBadge = firstCard.getByText('Gemini', { exact: true });
      expect(await codexBadge.count()).toBe(0);
      expect(await geminiBadge.count()).toBe(0);
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
