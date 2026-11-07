/**
 * E2E: the activity pane can sit on the left or the right of the body (Issue #4219).
 * Written without relying on the default: each test states the side it starts from.
 */

import { test, expect } from '@playwright/test';
import { E2E_WORKTREE_A, setupSplitTest } from './fixtures/terminal-split-helpers';

test.use({ viewport: { width: 1440, height: 900 } });

const SIDE_KEY = 'commandmate.worktree.activityPaneSide';

async function openScreen(page: import('@playwright/test').Page, side: 'left' | 'right') {
  await page.addInitScript(
    ([k, v]) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* non-fatal */
      }
    },
    [SIDE_KEY, side],
  );
  await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
  await expect(page.getByTestId('terminal-split-container')).toBeVisible({ timeout: 30_000 });
}

test.describe('Activity pane side (Issue #4219)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'PC-only layout (chromium only)');
    await setupSplitTest(page, [E2E_WORKTREE_A]);
  });

  test('unpinned on the left: over the body, body keeps its width, Esc returns focus', async ({ page }) => {
    await openScreen(page, 'left');
    const before = (await page.getByTestId('terminal-split-container').boundingBox())!;
    const files = page.getByTestId('header-tool-files');
    await files.click();
    const slot = page.getByTestId('activity-pane-slot');
    await expect(slot).toHaveAttribute('data-side', 'left');
    const pane = (await slot.boundingBox())!;
    expect(pane.x + pane.width).toBeLessThan(before.x + before.width / 2);
    const after = (await page.getByTestId('terminal-split-container').boundingBox())!;
    expect(after.width).toBeCloseTo(before.width, 0);
    await expect(slot).toBeVisible();
    await expect(files).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(slot).toHaveCount(0);
    await expect(files).toBeFocused();
  });

  test('the move button flips the side and it survives a reload', async ({ page }) => {
    await openScreen(page, 'right');
    await page.getByTestId('header-tool-files').click();
    const slot = page.getByTestId('activity-pane-slot');
    await expect(slot).toHaveAttribute('data-side', 'right');
    await page.getByTestId('activity-pane-side').click();
    await expect(slot).toHaveAttribute('data-side', 'left');
    expect(await page.evaluate((k) => localStorage.getItem(k), SIDE_KEY)).toBe('left');
    await page.getByTestId('activity-pane-side').click();
    await expect(slot).toHaveAttribute('data-side', 'right');
  });

  test('pinned on the left: a column left of the body; dragging left narrows it', async ({ page }) => {
    await openScreen(page, 'left');
    await page.getByTestId('header-tool-files').click();
    await page.getByTestId('activity-pane-pin').click();
    const slot = page.getByTestId('activity-pane-slot');
    await expect(slot).toHaveAttribute('data-pinned', 'true');
    const pane = (await slot.boundingBox())!;
    const body = (await page.getByTestId('right-pane-slot').boundingBox())!;
    expect(pane.x + pane.width).toBeLessThanOrEqual(body.x + 1);

    const sep = page.locator('[role="separator"][aria-orientation="horizontal"][aria-label^="Resize panes"]');
    const r = (await sep.boundingBox())!;
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x - 60, r.y + r.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(async () => (await slot.boundingBox())!.width)
      .toBeLessThan(pane.width - 20);
  });
});
