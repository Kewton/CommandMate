/**
 * E2E: the maximized file overlay must cover the desktop sidebar (Issue #2294)
 *
 * The bug was never a z-index value. `Z_INDEX.MAXIMIZED_EDITOR` (55) has always
 * been above `Z_INDEX.SIDEBAR` (30), but the overlay was rendered *inline*
 * inside AppShell's `main[role="main"]`, which carries
 * `view-transition-name: cm-content` (globals.css, Issue #1122). Any value
 * other than `none` opens a stacking context, so the overlay was ordered
 * against main's children only, and main itself — `position: static`,
 * `z-index: auto` — lost to the sidebar beside it. The left ~224px of the
 * maximized view, toolbar included, sat under the sidebar and could not be
 * clicked.
 *
 * `document.elementFromPoint` is the assertion that proves the fix, and it can
 * only live here: jsdom has no layout and no paint order, so the unit tests can
 * assert the portal target (`closest('main') === null`) but never the stacking.
 *
 * PC-only surface → self-skip outside chromium, mirroring the split specs.
 */

import { test, expect } from '@playwright/test';
import { E2E_WORKTREE_A, setupSplitTest } from './fixtures/terminal-split-helpers';

test.use({ viewport: { width: 1440, height: 900 } });

/** Plain-text file: renders through the CodeViewer path, no dynamic editor. */
const FILE_NAME = 'notes-2294.txt';
const FILE_BODY = 'maximize me\nline two\nline three\n';

/** Mirror of FILE_PANEL_COLLAPSED_STORAGE_KEY (src/hooks/useFilePanelState.ts). */
const FILE_PANEL_COLLAPSED_KEY = 'commandmate.worktree.filePanelCollapsed';

/** Probe one viewport point and report which layer owns it. */
async function hitTest(page: import('@playwright/test').Page, x: number, y: number) {
  return page.evaluate(
    ({ px, py }) => {
      const el = document.elementFromPoint(px, py);
      return {
        found: el !== null,
        inOverlay: !!el?.closest('[data-testid="maximized-file-overlay"]'),
        inSidebar: !!el?.closest('[data-testid="sidebar-container"]'),
      };
    },
    { px: x, py: y },
  );
}

/**
 * Open the mocked file from the Files activity tree.
 *
 * The active activity is persisted per worktree, so it is read from
 * `activity-pane`'s `data-active` rather than assumed: a bare visibility check
 * on the pane slot can be true while a *different* activity is showing, and
 * clicking the Files button then would toggle Files off instead of on.
 */
async function openMockedFile(page: import('@playwright/test').Page) {
  const pane = page.getByTestId('activity-pane');
  await expect(pane).toBeVisible();
  if ((await pane.getAttribute('data-active')) !== 'files') {
    await page.getByTestId('activity-bar-button-files').click();
  }
  await expect(pane).toHaveAttribute('data-active', 'files');

  await page.getByTestId(`tree-item-${FILE_NAME}`).click();
  await expect(page.getByTestId(`file-tab-${FILE_NAME}`)).toBeVisible();
  await expect(page.getByTestId('file-content-code')).toBeVisible();
}

test.describe('Maximized file overlay vs. desktop sidebar (Issue #2294)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'PC-only file panel (chromium only)');

    await setupSplitTest(page, [E2E_WORKTREE_A]);

    // The file panel must start expanded; a previous spec could have persisted
    // the collapsed flag into this origin's localStorage.
    await page.addInitScript(key => {
      try {
        localStorage.removeItem(key);
      } catch {
        /* storage unavailable - non-fatal */
      }
    }, FILE_PANEL_COLLAPSED_KEY);

    // Registered AFTER the catch-all in setupSplitTest so these win (Playwright
    // runs the most recently added matching handler first).
    await page.route(
      url => url.pathname.endsWith(`/api/worktrees/${E2E_WORKTREE_A}/tree`),
      route =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            path: '',
            parentPath: null,
            items: [{ name: FILE_NAME, type: 'file', size: FILE_BODY.length, extension: 'txt' }],
          }),
        }),
    );

    await page.route(
      url => url.pathname.endsWith(`/api/worktrees/${E2E_WORKTREE_A}/files/${FILE_NAME}`),
      route =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            path: FILE_NAME,
            content: FILE_BODY,
            extension: 'txt',
            worktreePath: `/tmp/${E2E_WORKTREE_A}`,
          }),
        }),
    );
  });

  test('covers the sidebar area once the file is maximized', async ({ page }) => {
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);

    // The sidebar is the element the overlay used to lose to.
    const sidebar = page.getByTestId('sidebar-container');
    await expect(sidebar).toBeVisible();
    const box = await sidebar.boundingBox();
    expect(box).not.toBeNull();

    // A point well inside the sidebar, below its header rows.
    const probeX = Math.round(box!.x + box!.width / 2);
    const probeY = Math.round(box!.y + Math.min(box!.height - 20, 450));
    // And a point on the maximized toolbar's left edge, which was hidden too.
    const toolbarProbeX = Math.round(box!.x + 30);
    const toolbarProbeY = 20;

    // Positive control: before maximizing, both points belong to the sidebar.
    // Without this the assertions below could pass over an empty region.
    const beforeBody = await hitTest(page, probeX, probeY);
    expect(beforeBody.inSidebar).toBe(true);
    expect(beforeBody.inOverlay).toBe(false);
    const beforeToolbar = await hitTest(page, toolbarProbeX, toolbarProbeY);
    expect(beforeToolbar.inSidebar).toBe(true);

    // Open the file from the tree.
    await openMockedFile(page);

    // Maximize it.
    await page.locator('button[aria-label="Maximize"]').first().click();
    const overlay = page.getByTestId('maximized-file-overlay');
    await expect(overlay).toBeVisible();

    // The assertion this spec exists for, asserted FIRST so a regression is
    // reported as "the sidebar still owns those pixels" rather than as a DOM
    // detail: the sidebar strip now belongs to the overlay, so the left edge of
    // the maximized view is reachable.
    await expect
      .poll(async () => (await hitTest(page, probeX, probeY)).inOverlay)
      .toBe(true);
    expect((await hitTest(page, probeX, probeY)).inSidebar).toBe(false);

    const toolbarHit = await hitTest(page, toolbarProbeX, toolbarProbeY);
    expect(toolbarHit.inOverlay).toBe(true);
    expect(toolbarHit.inSidebar).toBe(false);

    // And the mechanism behind it: the overlay really is portalled out of main.
    await expect(overlay).toHaveJSProperty('parentElement.tagName', 'BODY');

    // Minimize gives the sidebar its pixels back.
    await page.locator('button[aria-label="Minimize"]').first().click();
    await expect(overlay).toHaveCount(0);
    await expect.poll(async () => (await hitTest(page, probeX, probeY)).inSidebar).toBe(true);
  });

  test('ESC leaves the maximized overlay', async ({ page }) => {
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);

    await openMockedFile(page);

    await page.locator('button[aria-label="Maximize"]').first().click();
    await expect(page.getByTestId('maximized-file-overlay')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByTestId('maximized-file-overlay')).toHaveCount(0);
    await expect(page.getByTestId('file-content-code')).toBeVisible();
  });
});
