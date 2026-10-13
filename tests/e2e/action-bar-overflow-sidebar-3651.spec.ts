/**
 * E2E: the second row's "…" panel stays in the body at 1024x768 with the
 * sidebar open (Issue #3651).
 *
 * What this proves that the component tests cannot: the real sidebar width and
 * the real panel width. The UAT capture (`T06-1024-overflow-open.png`) had the
 * panel wider than the room left of "…", drawn from x=8 over the sidebar.
 *
 * PC-only surface → self-skip outside chromium, mirroring the split specs.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { E2E_WORKTREE_A, setupSplitTest } from './fixtures/terminal-split-helpers';

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

/** Mirror of SIDEBAR_WIDTH_STORAGE_KEY (src/contexts/SidebarContext.tsx). */
const SIDEBAR_WIDTH_KEY = 'mcbd-sidebar-width';

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Inside `outer` (sub-pixel slack), and painted on top at its centre. */
async function expectInsideAndReachable(page: Page, locator: Locator, outer: Box): Promise<Box> {
  const b = await box(locator);
  expect(b.x).toBeGreaterThanOrEqual(outer.x - 0.5);
  expect(b.x + b.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
  expect(b.y).toBeGreaterThanOrEqual(outer.y - 0.5);
  expect(b.y + b.height).toBeLessThanOrEqual(outer.y + outer.height + 0.5);
  const hit = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top !== null && (el === top || el.contains(top));
  });
  expect(hit).toBe(true);
  return b;
}

test.describe('Second row "…" panel beside the sidebar (Issue #3651)', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'PC-only second row (chromium only)');
  });

  test('starts right of the sidebar at 1024x768 and stays inside the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await setupSplitTest(page, [E2E_WORKTREE_A]);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);

    const sidebar = page.getByTestId('sidebar-container');
    await expect(sidebar).toBeVisible();
    const overflow = page.getByTestId('split-action-bar-items-overflow');
    await expect(overflow).toBeVisible();

    await overflow.click();
    const panel = page.getByTestId('split-action-bar-items-panel');
    await expect(panel).toBeVisible();
    // Off the button, so its own hover tooltip does not sit over the panel.
    await page.mouse.move(900, 600);

    const sidebarBox = await box(sidebar);
    const overflowBox = await box(overflow);
    const panelBox = await box(panel);
    // Positive control: right-aligned with "…", the panel would start left of
    // the body (the case the viewport-only clamp drew from x=8).
    expect(overflowBox.x + overflowBox.width - panelBox.width).toBeLessThan(
      sidebarBox.x + sidebarBox.width
    );
    expect(panelBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(1024);

    // Nothing of the sidebar is under the panel's left edge.
    const leftTop = await panel.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + 10, r.top + r.height / 2);
      return top !== null && (el === top || el.contains(top));
    });
    expect(leftTop).toBe(true);
  });

  test('fits every folded control in the panel at 768px with a 480px sidebar', async ({ page }) => {
    await page.addInitScript((key) => {
      try {
        localStorage.setItem(key, '480');
      } catch {
        /* storage unavailable - non-fatal */
      }
    }, SIDEBAR_WIDTH_KEY);
    await page.setViewportSize({ width: 768, height: 768 });
    await setupSplitTest(page, [E2E_WORKTREE_A]);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);

    const sidebar = page.getByTestId('sidebar-container');
    await expect(sidebar).toBeVisible();
    await expect.poll(async () => Math.round((await box(sidebar)).width)).toBe(480);
    const overflow = page.getByTestId('split-action-bar-items-overflow');
    await expect(overflow).toBeVisible();

    await overflow.click();
    const panel = page.getByTestId('split-action-bar-items-panel');
    await expect(panel).toBeVisible();
    await page.mouse.move(700, 700);

    const sidebarBox = await box(sidebar);
    const panelBox = await box(panel);
    // In the body: right of the sidebar, inside the viewport, capped near 272px.
    expect(panelBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(768);
    expect(panelBox.width).toBeLessThanOrEqual(768 - 480 - 16 + 0.5);

    // Every folded control: inside the panel's box, on top, and apart.
    const ids = [
      'verification-status-chip',
      'verification-chip-reason-toggle',
      'cli-selector-0',
      'surface-mode-terminal-0',
      'surface-mode-chat-0',
    ];
    const boxes: Box[] = [];
    for (const id of ids) {
      boxes.push(await expectInsideAndReachable(page, panel.getByTestId(id), panelBox));
    }
    // The chip and the session controls do not overlap each other (ⓘ is the chip's own part).
    const apart = [boxes[0], boxes[2], boxes[3], boxes[4]];
    for (let i = 0; i < apart.length; i += 1) {
      for (let j = i + 1; j < apart.length; j += 1) {
        expect(overlaps(apart[i], apart[j])).toBe(false);
      }
    }
    // Nothing in the panel draws past its box (wrapped, not overrun).
    const overrun = await panel.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overrun).toBeLessThanOrEqual(0);
  });

  test('keeps the panel on one row where it fits (negative control)', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await setupSplitTest(page, [E2E_WORKTREE_A]);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
    const overflow = page.getByTestId('split-action-bar-items-overflow');
    await expect(overflow).toBeVisible();
    await overflow.click();
    const panel = page.getByTestId('split-action-bar-items-panel');
    await expect(panel).toBeVisible();
    await page.mouse.move(900, 600);

    const chip = await box(panel.getByTestId('verification-status-chip'));
    const selector = await box(panel.getByTestId('cli-selector-0'));
    // Same row: their vertical centres line up.
    expect(Math.abs(chip.y + chip.height / 2 - (selector.y + selector.height / 2))).toBeLessThan(4);
  });
});
