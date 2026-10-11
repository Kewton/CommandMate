/**
 * E2E: with one split, the split's title bar is gone and its controls are on
 * the second row; with two or more, each split has a 30px title bar
 * (Issue #3592).
 *
 * What this proves that the component tests cannot:
 * - **the band is real layout**: at 1440x900 with the sidebar closed, the
 *   band above the terminal (header + second row, the tab row excluded) is
 *   80px or less;
 * - every control of the title bar is on screen in the second row and not
 *   covered — the selector, Terminal / Chat, the note entry, search, maximize,
 *   "…", History, Open Files;
 * - **1 → 2 → 1 rebuilds nothing**: the composer's draft survives and the
 *   terminal body is the same element throughout.
 *
 * Holds whether the side panel starts open or closed (#3589): nothing here
 * depends on the terminal's left edge.
 *
 * Screenshots in light and dark land in the test output
 * (`testInfo.outputPath`), for the PR.
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

/** Inside the viewport, inside `container` vertically, and painted on top at its centre. */
async function expectReachableIn(locator: Locator, container: Box): Promise<void> {
  const b = await box(locator);
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(1440.5);
  expect(b.y).toBeGreaterThanOrEqual(container.y - 0.5);
  expect(b.y + b.height).toBeLessThanOrEqual(container.y + container.height + 0.5);
  const hit = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top !== null && (el === top || el.contains(top));
  });
  expect(hit).toBe(true);
}

async function openOneSplit(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setupSplitTest(page, [E2E_WORKTREE_A]);
  await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
  await expect(page.getByTestId('split-layout-1')).toHaveAttribute('aria-pressed', 'true');
  // Sidebar closed.
  if (await page.getByTestId('sidebar-panel-toggle').isVisible()) {
    await page.getByTestId('sidebar-panel-toggle').click();
  }
  await expect(page.getByTestId('sidebar-rail-toggle')).toBeVisible();
}

test.describe('Split title bar on the second row (Issue #3592)', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'PC-only split surface (chromium only)');
  });

  test('one split: the band above the terminal is 80px or less, and every control is on the second row', async ({
    page,
  }, testInfo) => {
    await openOneSplit(page);

    const header = await box(page.getByTestId('desktop-header'));
    const body = await box(page.getByTestId('split-body-0'));
    expect(body.y - header.y).toBeLessThanOrEqual(80);
    await expect(page.getByTestId('split-header-0')).toHaveCount(0);

    const barLocator = page.getByTestId('split-action-bar');
    const bar = await box(barLocator);
    for (const id of [
      'cli-selector-0',
      'surface-mode-terminal-0',
      'surface-mode-chat-0',
      'split-session-note-edit-0',
      'terminal-search-button-0',
      'toggle-maximize-0',
      'split-more-menu-0',
      'toggle-history-pane',
      'toggle-file-panel',
    ]) {
      await expect(barLocator.getByTestId(id)).toBeVisible();
      await expectReachableIn(barLocator.getByTestId(id), bar);
    }

    // Order: selector right of the chip; search / maximize / "…" left of History.
    const chip = await box(page.getByTestId('verification-status-chip'));
    const selector = await box(page.getByTestId('cli-selector-0'));
    expect(selector.x).toBeGreaterThan(chip.x + chip.width);
    const more = await box(page.getByTestId('split-more-menu-0'));
    const history = await box(page.getByTestId('toggle-history-pane'));
    expect(more.x + more.width).toBeLessThanOrEqual(history.x);

    // Open Files: no file open → disabled, as before.
    await expect(page.getByTestId('toggle-file-panel')).toBeDisabled();

    // The surface toggle in the bar drives the split.
    await page.getByTestId('surface-mode-chat-0').click();
    await expect(page.getByTestId('surface-mode-chat-0')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('surface-mode-terminal-0').click();

    // The note editor opens from the bar, under it, without moving the terminal.
    await page.getByTestId('split-session-note-edit-0').click();
    await expect(page.getByTestId('split-session-note-input-0')).toBeFocused();
    expect((await box(page.getByTestId('split-body-0'))).y).toBe(body.y);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('split-session-note-input-0')).toHaveCount(0);

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({
        path: testInfo.outputPath(`split-header-in-bar-3592-one-${scheme}.png`),
        clip: { x: 0, y: 0, width: 1440, height: 200 },
      });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  });

  test('two splits: each has a 30px title bar; 1 → 2 → 1 keeps the draft and the terminal', async ({
    page,
  }, testInfo) => {
    await openOneSplit(page);

    const textarea = page.getByTestId('terminal-split-pane-0').getByTestId('message-input-textarea');
    await textarea.fill('half-typed instruction #3592');
    await page
      .getByTestId('split-body-0')
      .evaluate((el) => el.setAttribute('data-e2e-mark', 'kept'));

    await page.getByTestId('split-layout-2').click();
    await expect(page.getByTestId('split-layout-2')).toHaveAttribute('aria-pressed', 'true');
    for (const idx of [0, 1]) {
      const headerLocator = page
        .getByTestId(`terminal-split-pane-${idx}`)
        .getByTestId(`split-header-${idx}`);
      await expect(headerLocator).toBeVisible();
      expect((await box(headerLocator)).height).toBe(30);
      await expect(headerLocator.getByTestId(`cli-selector-${idx}`)).toBeVisible();
    }
    await expect(page.getByTestId('split-action-bar-session')).toHaveCount(0);
    // Which split gets what: each selector names its own session.
    const first = await page.getByTestId('cli-selector-0').textContent();
    const second = await page.getByTestId('cli-selector-1').textContent();
    expect(first).not.toBe(second);

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({
        path: testInfo.outputPath(`split-header-in-bar-3592-two-${scheme}.png`),
        clip: { x: 0, y: 0, width: 1440, height: 200 },
      });
    }
    await page.emulateMedia({ colorScheme: 'light' });

    await page.getByTestId('split-layout-1').click();
    await expect(page.getByTestId('split-layout-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('split-header-0')).toHaveCount(0);
    await expect(textarea).toHaveValue('half-typed instruction #3592');
    await expect(page.getByTestId('split-body-0')).toHaveAttribute('data-e2e-mark', 'kept');
  });
});
