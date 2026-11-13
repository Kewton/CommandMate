/**
 * E2E: the activity pane can sit on the left or the right of the body (Issue #4219).
 * Written without relying on the default: each test states the side it starts from.
 */

import { test, expect } from '@playwright/test';
import {
  E2E_WORKTREE_A,
  activeTestId,
  isBoxSettled,
  setupSplitTest,
} from './fixtures/terminal-split-helpers';

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

/**
 * Open the Files pane from its header icon and wait until the pane's own focus
 * move is done: `SearchBar` focuses its input ~100ms after mounting (desktop).
 * Without this wait, a focus / key press of the test lands before or after
 * that move depending on load, and the press goes to the search box (whose Esc
 * keeps the pane open, Issue #3589) or the bubble opened by focus closes.
 */
async function openFilesPane(page: import('@playwright/test').Page) {
  await page.getByTestId('header-tool-files').click();
  await expect(page.getByTestId('activity-pane-slot')).toBeVisible();
  await expect.poll(() => activeTestId(page)).toBe('search-input');
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
    await openFilesPane(page);
    const slot = page.getByTestId('activity-pane-slot');
    await expect(slot).toHaveAttribute('data-side', 'left');
    const pane = (await slot.boundingBox())!;
    expect(pane.x + pane.width).toBeLessThan(before.x + before.width / 2);
    const after = (await page.getByTestId('terminal-split-container').boundingBox())!;
    expect(after.width).toBeCloseTo(before.width, 0);
    await expect(slot).toBeVisible();
    // Esc from the icon that opened the pane (Issue #3650). The search box took
    // focus on mount (awaited above), so put it back on the icon first.
    await files.focus();
    await expect(files).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(slot).toHaveCount(0);
    await expect.poll(() => activeTestId(page)).toBe('header-tool-files');
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
    // The pinned column animates its width (transition-[width]): measure it and
    // grab its resizer only once the layout has settled.
    await expect.poll(() => isBoxSettled(slot)).toBe(true);
    const pane = (await slot.boundingBox())!;
    const body = (await page.getByTestId('right-pane-slot').boundingBox())!;
    expect(pane.x + pane.width).toBeLessThanOrEqual(body.x + 1);

    const sep = page.locator('[role="separator"][aria-orientation="horizontal"][aria-label^="Resize panes"]');
    const r = (await sep.boundingBox())!;
    const y = r.y + r.height / 2;
    await page.mouse.move(r.x + r.width / 2, y);
    await page.mouse.down();
    // PaneResizer attaches its document listeners in an effect after the
    // press (the same effect sets the body cursor), and each move is applied
    // to the width of the last render: moves sent before the listener is up,
    // or before the previous move's width has rendered, are lost under load.
    // So: wait for the drag to have started, then move in steps and wait for
    // each step's width to land and settle before the next one.
    await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('col-resize');
    for (let i = 1; i <= 5; i++) {
      const prev = (await slot.boundingBox())!.width;
      await page.mouse.move(r.x + r.width / 2 - 12 * i, y);
      await expect.poll(async () => (await slot.boundingBox())!.width).toBeLessThan(prev - 5);
      await expect.poll(() => isBoxSettled(slot)).toBe(true);
    }
    await page.mouse.up();
    await expect
      .poll(async () => (await slot.boundingBox())!.width)
      .toBeLessThan(pane.width - 20);
  });

  test('[#4256] the open tooltip follows the side button after it moves', async ({ page }) => {
    await openScreen(page, 'right');
    await openFilesPane(page);
    const slot = page.getByTestId('activity-pane-slot');
    const btn = page.getByTestId('activity-pane-side');
    // The bubble opens on focus: make sure focus is on the button and its
    // bubble is up before moving it (the "open tooltip" this test is about).
    await btn.focus();
    await expect(btn).toBeFocused();
    const labelBefore = (await btn.getAttribute('aria-label'))!;
    await expect(page.locator('[role="tooltip"][data-placement]', { hasText: labelBefore })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(slot).toHaveAttribute('data-side', 'left');
    await expect(btn).toBeFocused();
    await expect.poll(() => isBoxSettled(btn)).toBe(true);
    const box = (await btn.boundingBox())!;
    const label = (await btn.getAttribute('aria-label'))!;
    expect(label).not.toBe(labelBefore);
    const tip = page.locator('[role="tooltip"][data-placement]', { hasText: label });
    await expect(tip).toBeVisible();
    await expect
      .poll(async () => {
        const t = (await tip.boundingBox())!;
        return Math.abs(t.x + t.width / 2 - (box.x + box.width / 2));
      })
      .toBeLessThan(box.width + 80);
  });
});
