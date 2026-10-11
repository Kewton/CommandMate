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
import {
  E2E_WORKTREE_A,
  setupSplitTest,
  type VerificationFixture,
} from './fixtures/terminal-split-helpers';

/** A task whose title fills the chip's 36 characters, so the chip is wide. */
const LONG_TITLE_FIXTURE: VerificationFixture = {
  tasks: [
    {
      id: 'e2e-task-3590',
      worktreeId: E2E_WORKTREE_A,
      cliToolId: 'claude',
      instanceId: null,
      title: 'Issue #3590: a long execution contract title for the chip',
      goal: 'Make the chip wide.',
      contractPath: '.commandmate/tasks/e2e-3590.yaml',
      contract: {
        version: 1,
        title: 'Issue #3590',
        goal: 'Make the chip wide.',
        scope: { allow: ['src/**'], deny: [] },
        verify: { gates: ['unit'] },
        autoYes: { mode: 'safe', allowPromptTypes: [], denyPatterns: [] },
        success: { requireWorkEvidence: true, requireScopeClean: true },
      },
      status: 'running',
      lastVerificationRunId: null,
      createdAt: '2026-10-11T00:00:00.000Z',
      updatedAt: '2026-10-11T00:00:00.000Z',
      startedAt: '2026-10-11T00:00:30.000Z',
      finishedAt: null,
    },
  ],
};

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

/** Non-editable file, so the panel renders the plain code viewer (see file-maximize-portal-2294). */
const FILE_NAME = 'notes-3590.log';
const FILE_BODY = 'narrow terminal\n';

/** Mirrors of FILE_PANEL_COLLAPSED_STORAGE_KEY and PC_DISPLAY_SIZE_STORAGE_KEY. */
const FILE_PANEL_COLLAPSED_KEY = 'commandmate.worktree.filePanelCollapsed';
const PC_DISPLAY_SIZE_KEY = 'mcbd-pc-display-size';

async function mockOneFile(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable - non-fatal */
    }
  }, FILE_PANEL_COLLAPSED_KEY);
  // Registered after setupSplitTest's catch-all, so these win.
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

async function openMockedFile(page: Page): Promise<void> {
  const pane = page.getByTestId('activity-pane');
  await expect(pane).toBeVisible();
  if ((await pane.getAttribute('data-active')) !== 'files') {
    await page.getByTestId('activity-bar-button-files').click();
  }
  await expect(pane).toHaveAttribute('data-active', 'files');
  await page.getByTestId(`tree-item-${FILE_NAME}`).click();
  await expect(page.getByTestId(`file-tab-${FILE_NAME}`)).toBeVisible();
}

/** Every corner of `locator` is painted by it (nothing clips or covers it). */
async function expectFullyPainted(locator: Locator): Promise<void> {
  const ok = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    // Past the 8px rounded corners, which hit testing honours.
    const inset = 10;
    const points = [
      [r.left + inset, r.top + inset],
      [r.right - inset, r.top + inset],
      [r.left + inset, r.bottom - inset],
      [r.right - inset, r.bottom - inset],
    ];
    const misses = points
      .map(([x, y]) => ({ x, y, top: document.elementFromPoint(x, y) }))
      .filter(({ top }) => top === null || !(el === top || el.contains(top)))
      .map(({ x, y, top }) => `${Math.round(x)},${Math.round(y)}: ${top?.outerHTML.slice(0, 120) ?? 'null'}`);
    if (r.right > window.innerWidth || r.bottom > window.innerHeight) misses.push('outside viewport');
    return misses;
  });
  expect(ok).toEqual([]);
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

  test('keeps the chip and its reason reachable and uncut with the terminal at its minimum', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupSplitTest(page, [E2E_WORKTREE_A]);
    await mockOneFile(page);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
    await openMockedFile(page);

    // Drag the terminal / file panel border all the way left: the terminal
    // stops at FilePanelSplit's 20% minimum.
    const terminalPane = page.getByTestId('terminal-pane');
    const resizer = terminalPane.locator('xpath=following-sibling::*[@role="separator"][1]');
    const r = await box(resizer);
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(0, r.y + r.height / 2, { steps: 10 });
    await page.mouse.up();
    const bar = page.getByTestId('split-action-bar');
    const barWidth = (await box(bar)).width;
    expect(barWidth).toBeLessThan(400);

    // Positive control: at this width the chip no longer fits on the bar.
    const overflow = page.getByTestId('split-action-bar-items-overflow');
    await expect(overflow).toBeVisible();
    await expect(bar.getByTestId('verification-status-chip')).toHaveCount(0);
    await expectReachable(page, overflow, 1440);

    await overflow.click();
    const chip = page.getByTestId('verification-status-chip');
    await expect(chip).toBeVisible();
    // Off the button, so its own hover tooltip is not what covers the panel.
    await page.mouse.move(1000, 600);
    await expectFullyPainted(page.getByTestId('split-action-bar-items-panel'));
    await page.getByTestId('verification-chip-reason-toggle').click();
    await page.mouse.move(1000, 600);
    const reason = page.getByTestId('verification-chip-reason-popover');
    await expect(reason).toBeVisible();
    await expectFullyPainted(reason);
    // The panel stays open while its chip's reason is shown.
    await expect(page.getByTestId('split-action-bar-items-panel')).toBeVisible();
  });

  test('keeps the chip inside the second row at the xsmall display size', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(
      ({ key, value }) => {
        try {
          localStorage.setItem(key, value);
        } catch {
          /* storage unavailable - non-fatal */
        }
      },
      { key: PC_DISPLAY_SIZE_KEY, value: JSON.stringify('xsmall') },
    );
    await setupSplitTest(page, [E2E_WORKTREE_A]);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
    await expect(page.locator('html')).toHaveAttribute('data-pc-size', 'xsmall');

    const bar = await box(page.getByTestId('split-action-bar'));
    const chipRoot = page.getByTestId('verification-status-chip').locator('xpath=../..');
    const chip = await box(chipRoot);
    // h-9 alone would be 28.1px here; the chip is 34px of fixed px.
    expect(bar.height).toBeGreaterThanOrEqual(chip.height);
    expect(chip.y).toBeGreaterThanOrEqual(bar.y);
    expect(chip.y + chip.height).toBeLessThanOrEqual(bar.y + bar.height);
  });

  test('keeps the "…" panel inside the viewport, and moves focus in and back', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupSplitTest(page, [E2E_WORKTREE_A], LONG_TITLE_FIXTURE);
    await mockOneFile(page);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
    await openMockedFile(page);

    // Sidebar closed and the Files pane put away: the terminal starts near the
    // left edge. Then the file side widened until the terminal is at its 20%.
    await page.getByTestId('sidebar-panel-toggle').click();
    await expect(page.getByTestId('sidebar-rail-toggle')).toBeVisible();
    await page.getByTestId('activity-bar-button-files').click();
    await expect(page.getByTestId('activity-pane-slot')).toBeHidden();
    const resizer = page
      .getByTestId('terminal-pane')
      .locator('xpath=following-sibling::*[@role="separator"][1]');
    const r = await box(resizer);
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(0, r.y + r.height / 2, { steps: 10 });
    await page.mouse.up();

    const overflow = page.getByTestId('split-action-bar-items-overflow');
    await expect(overflow).toBeVisible();
    const overflowBox = await box(overflow);

    // Keyboard: Enter opens and focuses the first control (the chip).
    await overflow.focus();
    await page.keyboard.press('Enter');
    const panel = page.getByTestId('split-action-bar-items-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('verification-status-chip')).toBeFocused();

    const panelBox = await box(panel);
    // Positive control: the panel is wider than the room left of "…", so a
    // right-aligned panel would have started off-screen.
    expect(panelBox.width).toBeGreaterThan(overflowBox.x + overflowBox.width);
    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(1440);

    // Escape closes and gives focus back to "…".
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(overflow).toBeFocused();
  });

  test('keeps the reason under the chip when a maximize label appears beside it', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupSplitTest(page, [E2E_WORKTREE_A]);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
    await page.getByTestId('split-layout-2').click();
    await expect(page.getByTestId('split-layout-2')).toHaveAttribute('aria-pressed', 'true');

    const chipRoot = page.getByTestId('verification-status-chip').locator('xpath=../..');
    await page.getByTestId('verification-chip-reason-toggle').click();
    const reason = page.getByTestId('verification-chip-reason-popover');
    await expect(reason).toBeVisible();
    const chipBefore = await box(chipRoot);
    const reasonBefore = await box(reason);

    // Mod+Shift+Enter from inside split 1 (focus moved without a press, so the
    // reason stays open) maximizes it; the bar gains a label left of the chip.
    await page
      .getByTestId('terminal-split-pane-0')
      .locator('textarea')
      .first()
      .evaluate((el: HTMLTextAreaElement) => el.focus());
    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    await expect(page.getByTestId('split-count-label')).toBeVisible();
    await expect(reason).toBeVisible();

    const chipAfter = await box(chipRoot);
    expect(chipAfter.x).toBeGreaterThan(chipBefore.x);
    await expect
      .poll(async () => Math.round((await box(reason)).x - reasonBefore.x))
      .toBe(Math.round(chipAfter.x - chipBefore.x));
    const reasonAfter = await box(reason);
    expect(Math.abs(reasonAfter.y - (chipAfter.y + chipAfter.height + 4))).toBeLessThanOrEqual(1);
  });
});
