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

import { test, expect, type Locator } from '@playwright/test';
import { E2E_WORKTREE_A, setupSplitTest } from './fixtures/terminal-split-helpers';

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
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
});
