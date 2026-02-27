/**
 * E2E Tests: Mobile CMATE Tab
 * Verifies CMATE sub-tab header visibility on mobile.
 */

import { test, expect } from '@playwright/test';

test.describe('Mobile CMATE Tab', () => {
  test('shows Notes/Logs/Agent sub-tabs when CMATE tab is selected', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const worktreeItem = page.locator('[data-testid^="worktree-item-"]').first();
    if (await worktreeItem.count() === 0) {
      test.skip();
      return;
    }

    await worktreeItem.click();
    await page.waitForLoadState('networkidle');

    const cmateTab = page.getByTestId('mobile-tab-memo');
    await expect(cmateTab).toBeVisible();
    await cmateTab.click();

    const notesSubTab = page.getByRole('button', { name: /Notes|メモ/i });
    const logsSubTab = page.getByRole('button', { name: /Schedules/i });
    const agentSubTab = page.getByRole('button', { name: /Agent/i });

    await expect(notesSubTab).toBeVisible();
    await expect(logsSubTab).toBeVisible();
    await expect(agentSubTab).toBeVisible();

    // Ensure the sub-tab header is actually interactive and not hidden behind overlays.
    await logsSubTab.click();
    await expect(logsSubTab).toBeVisible();
  });
});
