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
 * Second contract: the note being typed survives 1 → 2 → 1, Mod+Shift+M typed
 * in the bar's note editor acts on the split, and with the terminal at its
 * 20% minimum the moved controls fold behind the bar's "…" and stay usable.
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

/** Non-editable file, so the panel renders the plain code viewer (as in the #3590 spec). */
const FILE_NAME = 'notes-3592.log';
const FILE_BODY = 'narrow terminal\n';
/** Mirror of FILE_PANEL_COLLAPSED_STORAGE_KEY. */
const FILE_PANEL_COLLAPSED_KEY = 'commandmate.worktree.filePanelCollapsed';

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

/**
 * Opens the mocked file from the Files pane. Issue #3589: the activity pane
 * starts closed and opens over the body, so it is opened from its entry —
 * Issue #3591: the Files tool in the header — unless it already shows Files. Opening the file puts the
 * (unpinned) pane away again, leaving the file panel beside the terminal.
 */
async function openMockedFile(page: Page): Promise<void> {
  await expect(page.getByTestId('terminal-split-container')).toBeVisible();
  const pane = page.getByTestId('activity-pane');
  const showing = (await pane.count()) > 0 ? await pane.getAttribute('data-active') : null;
  if (showing !== 'files') {
    await page.getByTestId('header-tool-files').click();
  }
  await expect(pane).toHaveAttribute('data-active', 'files');
  await page.getByTestId(`tree-item-${FILE_NAME}`).click();
  await expect(page.getByTestId(`file-tab-${FILE_NAME}`)).toBeVisible();
  await expect(page.getByTestId('activity-pane-slot')).toHaveCount(0);
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
      'toggle-maximize-split',
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

    // One maximize icon on the row: the bar's (second contract).
    await expect(barLocator.getByTestId('toggle-maximize-0')).toHaveCount(0);

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

  test('the note being typed survives 1 → 2 → 1, and Mod+Shift+M in it acts on the split', async ({
    page,
  }) => {
    await openOneSplit(page);

    await page.getByTestId('split-session-note-edit-0').click();
    const note = page.getByTestId('split-session-note-input-0');
    await expect(note).toBeFocused();
    await note.fill('review pending');

    // The bar's note editor belongs to split 1: the chord switches it to Chat.
    await note.press('ControlOrMeta+Shift+M');
    await expect(page.getByTestId('surface-mode-chat-0')).toHaveAttribute('aria-pressed', 'true');
    await expect(note).toHaveValue('review pending');

    await page.getByTestId('split-layout-2').click();
    await expect(
      page.getByTestId('split-header-0').getByTestId('split-session-note-input-0'),
    ).toHaveValue('review pending');

    await page.getByTestId('split-layout-1').click();
    await expect(
      page.getByTestId('split-action-bar-session').getByTestId('split-session-note-input-0'),
    ).toHaveValue('review pending');
    await page.keyboard.press('Escape');
    await page.getByTestId('surface-mode-terminal-0').click();
  });

  test('with the terminal at its 20% minimum, the moved controls are behind "…" and usable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupSplitTest(page, [E2E_WORKTREE_A]);
    await mockOneFile(page);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
    await openMockedFile(page);

    // Drag the terminal / file panel border all the way left: the terminal
    // stops at FilePanelSplit's 20% minimum.
    const resizer = page
      .getByTestId('terminal-pane')
      .locator('xpath=following-sibling::*[@role="separator"][1]');
    const r = await box(resizer);
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(0, r.y + r.height / 2, { steps: 10 });
    await page.mouse.up();
    const barLocator = page.getByTestId('split-action-bar');
    expect((await box(barLocator)).width).toBeLessThan(400);

    // Folded: nothing of the split's session controls is on the bar's left.
    const overflow = page.getByTestId('split-action-bar-items-overflow');
    await expect(overflow).toBeVisible();
    await expect(page.getByTestId('split-action-bar-left').getByTestId('cli-selector-0')).toHaveCount(0);
    await expectReachableIn(overflow, await box(barLocator));
    // The right end is unchanged: search, maximize, "…" and the panel toggles.
    for (const id of ['terminal-search-button-0', 'split-more-menu-0', 'toggle-history-pane']) {
      await expectReachableIn(barLocator.getByTestId(id), await box(barLocator));
    }

    await overflow.click();
    const panel = page.getByTestId('split-action-bar-items-panel');
    await expect(panel).toBeVisible();
    for (const id of ['cli-selector-0', 'surface-mode-chat-0', 'split-session-note-edit-0']) {
      await expect(panel.getByTestId(id)).toBeVisible();
      await expectReachableIn(panel.getByTestId(id), await box(panel));
    }
    await panel.getByTestId('surface-mode-chat-0').click();
    await expect(page.getByTestId('surface-mode-chat-0')).toHaveAttribute('aria-pressed', 'true');
    // The panel stays open for the next control.
    await expect(panel).toBeVisible();
    await panel.getByTestId('surface-mode-terminal-0').click();

    // Third contract: Escape in the selector's menu closes the menu only.
    await panel.getByTestId('cli-selector-0').click();
    const menuItem = page.getByTestId('split-session-note-menu-item-0');
    await expect(menuItem).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menuItem).toHaveCount(0);
    await expect(panel).toBeVisible();

    // The note editor opens under the panel's controls, on screen.
    await panel.getByTestId('split-session-note-edit-0').click();
    const noteEditor = page.getByTestId('split-session-note-editor-0');
    await expect(noteEditor).toBeVisible();
    const editorBox = await box(noteEditor);
    const anchorBox = await box(panel.getByTestId('split-bar-session-0'));
    expect(editorBox.y).toBeGreaterThanOrEqual(anchorBox.y + anchorBox.height);
    expect(editorBox.x).toBeGreaterThanOrEqual(0);
    expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(1440);
    await expect(page.getByTestId('split-session-note-input-0')).toBeFocused();

    // Escape directly in the panel (the editor gone) closes it.
    await page.keyboard.press('Escape');
    await expect(noteEditor).toHaveCount(0);
    await panel.getByTestId('cli-selector-0').focus();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  });
  test('an open reason hides while its chip waits behind a closed "…", and comes back under it', async ({
    page,
  }) => {
    await openOneSplit(page);
    const bar = page.getByTestId('split-action-bar');
    const chip = page.getByTestId('verification-status-chip');
    await expect(bar.getByTestId('split-action-bar-items-overflow')).toHaveCount(0);

    // Negative: where the chip fits, the reason sits under it, as before.
    await page.getByTestId('verification-chip-reason-toggle').click();
    const reason = page.getByTestId('verification-chip-reason-popover');
    await expect(reason).toBeVisible();
    const chipBox = await box(chip);
    const inlineBox = await box(reason);
    expect(inlineBox.y).toBeGreaterThanOrEqual(chipBox.y + chipBox.height);

    // Narrow the window (no press, so the reason stays open): the chip folds
    // behind a closed "…" and leaves the page. The reason is hidden — not
    // left at the viewport's top left corner.
    await page.setViewportSize({ width: 820, height: 900 });
    const overflow = page.getByTestId('split-action-bar-items-overflow');
    await expect(overflow).toBeVisible();
    await expect(overflow).toHaveAttribute('aria-expanded', 'false');
    await expect(reason).toHaveCount(1);
    await expect(reason).toBeHidden();

    // "…" brings the chip back, and the reason is placed under it again.
    await overflow.click();
    const panel = page.getByTestId('split-action-bar-items-panel');
    await expect(panel.getByTestId('verification-chip-reason-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(reason).toBeVisible();
    const panelChip = await box(panel.getByTestId('verification-status-chip'));
    const placed = await box(reason);
    expect(placed.y).toBeGreaterThanOrEqual(panelChip.y + panelChip.height);
    expect(placed.x).toBeGreaterThanOrEqual(8);
    expect(placed.x + placed.width).toBeLessThanOrEqual(820);
  });
});
