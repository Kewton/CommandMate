/**
 * E2E: with one split, the agent's name in the second row stays readable
 * (Issue #3615).
 *
 * At 1024x768 with the sidebar open, the lone split's agent selector
 * (`split-bar-session-0`, moved to the second row by #3592) shrank to "C":
 * truncating it never counted as "does not fit", so the bar never reached its
 * "…" step. Measured here in a real browser, by the label's box width (not by
 * its text, which is whole in the DOM however it is clipped):
 *
 * - 1024 (positive): the name is drawn at least as wide as its readable
 *   width (or whole, if shorter) on the bar — or the selector is behind "…"
 *   and drawn whole there, one click away;
 * - 1280 / 1440 (negative): as before — on the bar, whole, no "…".
 *
 * PC-only surface → self-skip outside chromium, mirroring the split specs.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { E2E_WORKTREE_A, setupSplitTest } from './fixtures/terminal-split-helpers';

/** Mirror of TerminalSplitPane's BAR_SESSION_LABEL_MIN_WIDTH (about 7 characters). */
const READABLE_PX = 48;

async function openOneSplit(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 768 });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('mcbd-sidebar-open', 'true');
    } catch {
      /* non-fatal */
    }
  });
  await setupSplitTest(page, [E2E_WORKTREE_A]);
  await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
  await expect(page.getByTestId('terminal-split-container')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('split-layout-1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('sidebar-container')).toBeVisible();
  await expect(page.getByTestId('cli-selector-0')).toHaveCount(1);
}

/** The name's drawn width, and the width it needs to be whole. */
async function labelWidths(selector: Locator): Promise<{ drawn: number; whole: number }> {
  const label = selector.locator('span.truncate');
  const b = await label.boundingBox();
  expect(b).not.toBeNull();
  const whole = await label.evaluate((el) => el.scrollWidth);
  return { drawn: b!.width, whole };
}

test.describe('The lone split\'s agent name stays readable (Issue #3615)', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'PC-only split surface (chromium only)');
  });

  test('1024x768, sidebar open: the name is readable on the bar, or behind "…" and reachable', async ({
    page,
  }) => {
    await openOneSplit(page, 1024);
    const left = page.getByTestId('split-action-bar-left');
    const onBar = left.getByTestId('cli-selector-0');

    if ((await onBar.count()) > 0) {
      const { drawn, whole } = await labelWidths(onBar);
      expect(drawn).toBeGreaterThanOrEqual(Math.min(whole, READABLE_PX) - 0.5);
      return;
    }

    const overflow = page.getByTestId('split-action-bar-items-overflow');
    await expect(overflow).toBeVisible();
    await overflow.click();
    const panel = page.getByTestId('split-action-bar-items-panel');
    const inPanel = panel.getByTestId('cli-selector-0');
    await expect(inPanel).toBeVisible();
    const { drawn, whole } = await labelWidths(inPanel);
    expect(drawn).toBeGreaterThanOrEqual(whole - 0.5);
    // On screen and painted on top.
    const b = (await inPanel.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(1024);
    const hit = await inPanel.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top !== null && (el === top || el.contains(top));
    });
    expect(hit).toBe(true);
  });

  for (const width of [1280, 1440]) {
    test(`${width}x768, sidebar open: the selector stays on the bar, whole (negative)`, async ({ page }) => {
      await openOneSplit(page, width);
      await expect(page.getByTestId('split-action-bar-items-overflow')).toHaveCount(0);
      const onBar = page.getByTestId('split-action-bar-left').getByTestId('cli-selector-0');
      await expect(onBar).toBeVisible();
      const { drawn, whole } = await labelWidths(onBar);
      expect(whole).toBeGreaterThan(0);
      expect(drawn).toBeGreaterThanOrEqual(whole - 0.5);
    });
  }
});
