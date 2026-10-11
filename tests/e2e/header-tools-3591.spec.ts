/**
 * E2E: the vertical activity bar's column is gone; the worktree's tools sit at
 * the right of the header and their pane opens from the right (Issue #3591).
 *
 * What this proves that the component tests cannot: real widths. At 1440×900
 * every tool is one click away from the top (nine header tools plus the
 * Verification chip on the second row); on a narrow window the trailing tools
 * fold behind "…" (two clicks); with the sidebar closed the only column left
 * of the body is the app's icon rail. Keyboard paths are driven with real key
 * presses, so the focus that comes back after a close is the browser's.
 *
 * PC-only surface → self-skip outside chromium, mirroring the split specs.
 */

import { test, expect, type Page } from '@playwright/test';
import { E2E_WORKTREE_A, setupSplitTest } from './fixtures/terminal-split-helpers';

/** Mirror of FILE_PANEL_COLLAPSED_STORAGE_KEY. */
const FILE_PANEL_COLLAPSED_KEY = 'commandmate.worktree.filePanelCollapsed';
const FILE_NAME = 'notes-3591.log';
const FILE_BODY = 'narrow terminal\n';

/** One file in the tree, and its body (as in worktree-header-one-row-3590). */
async function mockOneFile(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable - non-fatal */
    }
  }, FILE_PANEL_COLLAPSED_KEY);
  await page.route(
    (url) => url.pathname.endsWith(`/api/worktrees/${E2E_WORKTREE_A}/tree`),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          path: '',
          parentPath: null,
          items: [{ name: FILE_NAME, type: 'file', size: FILE_BODY.length, extension: 'log' }],
        }),
      }),
  );
  await page.route(
    (url) => url.pathname.endsWith(`/api/worktrees/${E2E_WORKTREE_A}/files/${FILE_NAME}`),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          path: FILE_NAME,
          content: FILE_BODY,
          extension: 'log',
          worktreePath: `/tmp/${E2E_WORKTREE_A}`,
        }),
      }),
  );
}

/**
 * Narrow the second row until the chip folds behind its "…": open the file
 * (which puts the unpinned Files pane away) and drag the terminal / file
 * border all the way left, so the terminal stops at its 20% minimum.
 */
async function foldTheSecondRow(page: Page): Promise<void> {
  await page.getByTestId('header-tool-files').click();
  await page.getByTestId(`tree-item-${FILE_NAME}`).click();
  await expect(page.getByTestId(`file-tab-${FILE_NAME}`)).toBeVisible();
  await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
  const resizer = page
    .getByTestId('terminal-pane')
    .locator('xpath=following-sibling::*[@role="separator"][1]');
  let lastX = -1;
  await expect
    .poll(async () => {
      const x = Math.round((await resizer.boundingBox())!.x);
      const settled = x === lastX;
      lastX = x;
      return settled;
    })
    .toBe(true);
  const r = (await resizer.boundingBox())!;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(0, r.y + r.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId('split-action-bar-items-overflow')).toBeVisible();
}

const TOOL_IDS = ['files', 'git', 'notes', 'schedules', 'agent', 'timer', 'todo', 'skills', 'env'];

async function setSidebar(page: Page, open: boolean) {
  await page.addInitScript(value => {
    try {
      localStorage.setItem('mcbd-sidebar-open', String(value));
    } catch {
      /* non-fatal */
    }
  }, open);
}

async function openScreen(page: Page) {
  await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
  await expect(page.getByTestId('terminal-split-container')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('header-tool-bar')).toBeVisible();
}

test.describe('Worktree tools in the header (Issue #3591)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'PC-only layout (chromium only)');
    await setupSplitTest(page, [E2E_WORKTREE_A]);
  });

  for (const sidebarOpen of [true, false]) {
    test(`1440×900: every tool is one click away from the top (sidebar ${sidebarOpen ? 'open' : 'closed'})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await setSidebar(page, sidebarOpen);
      await openScreen(page);

      const header = (await page.getByTestId('desktop-header').boundingBox())!;
      for (const id of TOOL_IDS) {
        const tool = page.getByTestId(`header-tool-${id}`);
        await expect(tool).toBeVisible();
        const b = (await tool.boundingBox())!;
        expect(b.y).toBeGreaterThanOrEqual(header.y);
        expect(b.y + b.height).toBeLessThanOrEqual(header.y + header.height + 0.5);
        expect(b.x + b.width).toBeLessThanOrEqual(header.x + header.width + 0.5);
      }
      await expect(page.getByTestId('header-tool-more')).toHaveCount(0);
      await expect(page.getByTestId('header-tool-verification')).toHaveCount(0);
      await expect(page.getByTestId('verification-status-chip')).toBeVisible();

      testInfo.annotations.push({
        type: 'header',
        description: `1440x900, sidebar ${sidebarOpen ? 'open' : 'closed'}: header ${Math.round(header.width)}px, 9 tools in a row`,
      });
    });
  }

  test('no vertical activity bar: with the sidebar closed the icon rail is the only column left of the body', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setSidebar(page, false);
    await openScreen(page);
    await expect(page.getByTestId('activity-bar')).toHaveCount(0);

    const rail = (await page.getByTestId('sidebar-rail').boundingBox())!;
    const header = (await page.getByTestId('desktop-header').boundingBox())!;
    const body = (await page.getByTestId('desktop-layout').boundingBox())!;
    expect(header.x).toBeLessThanOrEqual(rail.x + rail.width + 1);
    expect(body.x).toBeLessThanOrEqual(rail.x + rail.width + 1);
  });

  test('the pane opens from the right over the body, which keeps its width', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScreen(page);
    const before = (await page.getByTestId('terminal-split-container').boundingBox())!;

    await page.getByTestId('header-tool-notes').click();
    const slot = page.getByTestId('activity-pane-slot');
    await expect(slot).toBeVisible();
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'notes');

    const after = (await page.getByTestId('terminal-split-container').boundingBox())!;
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.width).toBeCloseTo(before.width, 0);
    const pane = (await slot.boundingBox())!;
    expect(pane.x).toBeGreaterThan(before.x + before.width / 2);
  });

  test('keyboard: ←/→ and Home/End move, Enter opens, Esc closes and focus comes back', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScreen(page);
    const files = page.getByTestId('header-tool-files');
    await files.focus();

    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('header-tool-git')).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByTestId('header-tool-env')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(files).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('header-tool-env')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('header-tool-git')).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'git');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
    await expect(page.getByTestId('header-tool-git')).toBeFocused();

    // Space toggles too, and × hands focus back as well.
    await page.keyboard.press(' ');
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'git');
    await page.getByTestId('activity-pane-close').click();
    await expect(page.getByTestId('header-tool-git')).toBeFocused();
  });

  test('the Verification chip opens its pane, and Esc hands focus back to the chip', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScreen(page);
    const chip = page.getByTestId('verification-status-chip');
    await chip.click();
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'verification');
    await chip.focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
    await expect(chip).toBeFocused();
  });

  test('narrow window: trailing tools fold behind "…", reachable by mouse and keyboard', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await setSidebar(page, true);
    await openScreen(page);

    const more = page.getByTestId('header-tool-more');
    await expect(more).toBeVisible();
    const visible: string[] = [];
    for (const id of TOOL_IDS) {
      if ((await page.getByTestId(`header-tool-${id}`).count()) > 0) visible.push(id);
    }
    // The visible ones are a prefix: the trailing ones fold first.
    expect(visible).toEqual(TOOL_IDS.slice(0, visible.length));
    expect(visible.length).toBeLessThan(TOOL_IDS.length);
    const folded = TOOL_IDS.slice(visible.length);
    const last = folded[folded.length - 1];

    // Mouse: two clicks.
    await more.click();
    await page.getByTestId(`header-tool-more-item-${last}`).click();
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', last);
    // The open tool is folded: "…" carries the mark.
    await expect(more).toHaveAttribute('data-active', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute('data-active', 'false');

    // Keyboard: Enter on "…" opens the list on its first tool; Tab moves through it.
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(`header-tool-more-item-${folded[0]}`)).toBeFocused();
    if (folded.length > 1) {
      await page.keyboard.press('Tab');
      await expect(page.getByTestId(`header-tool-more-item-${folded[1]}`)).toBeFocused();
    }
    await page.keyboard.press('Enter');
    const picked = folded.length > 1 ? folded[1] : folded[0];
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', picked);
    await expect(more).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
    await expect(more).toBeFocused();

    testInfo.annotations.push({
      type: 'header',
      description: `1024x768, sidebar open: ${visible.length} tools in the row, ${folded.length} behind "…"`,
    });
  });

  // ---- 2nd contract: the Codex consistency review's P2s -------------------

  test('the Verification chip toggles: a second press closes, from another pane it switches', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScreen(page);
    const chip = page.getByTestId('verification-status-chip');
    await chip.click();
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'verification');
    await chip.click();
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);

    // Negative control: with another pane open the chip switches to Verification.
    await page.getByTestId('header-tool-notes').click();
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'notes');
    await chip.click();
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'verification');
  });

  test('pressing the second row "…" keeps an open Verification pane open', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setSidebar(page, true);
    await mockOneFile(page);
    await openScreen(page);
    await foldTheSecondRow(page);

    // Verification opened from the chip folded behind the second row's "…".
    const overflow = page.getByTestId('split-action-bar-items-overflow');
    await overflow.click();
    await page.getByTestId('verification-status-chip').click();
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'verification');

    // Pressing "…" again (to reach the chip) is not an outside press.
    await overflow.click();
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'verification');
    await overflow.click();
    await expect(page.getByTestId('split-action-bar-items-panel')).toBeVisible();
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'verification');

    // And the chip in that panel closes it (the toggle).
    await page.getByTestId('verification-status-chip').click();
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
  });

  test('negative control: a press in the terminal still closes the Verification pane', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScreen(page);
    await page.getByTestId('verification-status-chip').click();
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'verification');
    const box = (await page.getByTestId('terminal-split-container').boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
    await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
  });

  test('Esc in the header "…" list closes only that list when the second row "…" is open too', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await setSidebar(page, true);
    await mockOneFile(page);
    await openScreen(page);
    await foldTheSecondRow(page);
    const overflow = page.getByTestId('split-action-bar-items-overflow');
    const more = page.getByTestId('header-tool-more');
    await expect(more).toBeVisible();

    await overflow.click();
    const panel = page.getByTestId('split-action-bar-items-panel');
    await expect(panel).toBeVisible();
    // From the keyboard: a press on the header "…" would close the other panel.
    await more.focus();
    await page.keyboard.press('Enter');
    const list = page.getByTestId('header-tool-more-list');
    await expect(list).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(more).toBeFocused();

    // Negative control: the next Esc (nobody else handles it) closes the second row's panel.
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  });
});
