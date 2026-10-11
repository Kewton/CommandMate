/**
 * E2E: the worktree header is one 44px row, and the Verification chip sits on
 * the second row next to the split layout icons (Issue #3590).
 *
 * What this proves that the component tests cannot: the heights are real
 * layout (44px header, the 36px second row holding the chip's 32px ⓘ uncut),
 * and at a narrow width with the sidebar open nothing in either row overlaps
 * or leaves the viewport — End / Update / Info / History / Files / the chip
 * are all within reach (the #2481 contract on both rows).
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

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Fully inside the viewport horizontally, and painted on top at its centre. */
async function expectReachable(page: Page, locator: Locator, viewportWidth: number): Promise<void> {
  const b = await box(locator);
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(viewportWidth + 0.5);
  const hit = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top !== null && (el === top || el.contains(top));
  });
  expect(hit).toBe(true);
}

test.describe('Worktree header in one row (Issue #3590)', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'PC-only header (chromium only)');
  });

  test('is 44px at 1440x900, with the chip on the 36px second row', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupSplitTest(page, [E2E_WORKTREE_A]);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);

    const header = page.getByTestId('desktop-header');
    await expect(header).toBeVisible();
    expect(await header.evaluate((el) => el.getBoundingClientRect().height)).toBe(44);

    // One line: name, repository and the (different) checked-out branch share a row.
    const name = await box(page.getByTestId('desktop-worktree-name'));
    const repo = await box(page.getByTestId('desktop-repository-name'));
    const branch = await box(page.getByTestId('desktop-branch-name'));
    const headerBox = await box(header);
    for (const b of [name, repo, branch]) {
      expect(b.y).toBeGreaterThanOrEqual(headerBox.y);
      expect(b.y + b.height).toBeLessThanOrEqual(headerBox.y + headerBox.height);
    }
    expect(repo.x).toBeGreaterThan(name.x);
    expect(branch.x).toBeGreaterThan(repo.x);
    // The memo is not drawn; it is the name's tooltip.
    await expect(header).not.toContainText('E2E split test worktree');

    // The chip is on the second row, right after the layout icons.
    const bar = page.getByTestId('split-action-bar');
    const chip = page.getByTestId('verification-status-chip');
    await expect(chip).toBeVisible();
    await expect(bar.getByTestId('verification-status-chip')).toBeVisible();
    await expect(header.getByTestId('verification-status-chip')).toHaveCount(0);
    const barBox = await box(bar);
    expect(barBox.height).toBe(36);
    const picker = await box(page.getByTestId('split-layout-picker'));
    const chipBox = await box(chip);
    expect(chipBox.x).toBeGreaterThan(picker.x + picker.width);
    // The 32px ⓘ is not cut by the bar.
    const toggle = await box(page.getByTestId('verification-chip-reason-toggle'));
    expect(toggle.height).toBeGreaterThanOrEqual(32);
    expect(toggle.y).toBeGreaterThanOrEqual(barBox.y);
    expect(toggle.y + toggle.height).toBeLessThanOrEqual(barBox.y + barBox.height);

    // Same behaviour: ⓘ opens the reason, the chip opens the pane.
    await page.getByTestId('verification-chip-reason-toggle').click();
    await expect(page.getByTestId('verification-chip-reason-popover')).toBeVisible();
    await page.keyboard.press('Escape');
    await chip.click();
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'verification');
  });

  test('keeps both rows reachable and unoverlapped at 1280px with the sidebar open', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setupSplitTest(page, [E2E_WORKTREE_A]);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
    await expect(page.getByTestId('sidebar-container')).toBeVisible();
    await expect(page.getByTestId('desktop-header')).toBeVisible();
    await expect(page.getByTestId('verification-status-chip')).toBeVisible();

    for (const testId of [
      'desktop-info-button',
      'desktop-status-dropdown',
      'toggle-history-pane',
      'toggle-file-panel',
      'verification-status-chip',
      'verification-chip-reason-toggle',
    ]) {
      await expectReachable(page, page.getByTestId(testId), 1280);
    }

    const identity = await box(page.getByTestId('desktop-header-identity'));
    const controls = await box(page.getByTestId('desktop-header-controls'));
    expect(overlaps(identity, controls)).toBe(false);
    const left = await box(page.getByTestId('split-action-bar-left'));
    for (const testId of ['toggle-history-pane', 'toggle-file-panel']) {
      expect(overlaps(left, await box(page.getByTestId(testId)))).toBe(false);
    }
  });
});
