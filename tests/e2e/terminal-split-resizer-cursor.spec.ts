/**
 * E2E: PaneResizer cursor non-residue with multiple parallel instances
 * (Issue #735 / #728 AC-27 Scenario 1)
 *
 * AC-27 #1: when several PaneResizer instances coexist (ActivityPane↔Right,
 * History↔Terminal, and the terminal-split gaps), dragging one must set the
 * drag cursor (`col-resize`) DURING the drag and reset it afterwards so no
 * drag cursor lingers on `document.body`. unit/jsdom cannot verify this
 * (pane widths are 0), so it is machine-verified here.
 *
 * PC-only UI → self-skip on the Mobile Safari project (S3-004); config left
 * untouched. Backend decoupled via API mocks; localStorage isolated per test.
 */

import { test, expect } from '@playwright/test';
import {
  E2E_WORKTREE_A,
  ensureFilesActivityVisible,
  setupSplitTest,
} from './fixtures/terminal-split-helpers';

// Desktop layout requires width >= 768px (useIsMobile breakpoint). The PC
// split UI does not render on the Mobile Safari (iPhone 13) project.
test.use({ viewport: { width: 1920, height: 1080 } });

test.describe('Terminal split — PaneResizer cursor non-residue (AC-27 #1)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    // PC-only split UI: skip on the Mobile Safari project (S3-004).
    test.skip(
      testInfo.project.name !== 'chromium',
      'PC-only split UI (chromium only)',
    );
    await setupSplitTest(page, [E2E_WORKTREE_A]);
  });

  test('drag cursor reverts after drag with multiple parallel resizers', async ({
    page,
  }) => {
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);

    // Split shell must render (worktree mocked, no live session needed).
    await expect(
      page.locator('[data-testid="terminal-split-container"]'),
    ).toBeVisible();

    // Ensure the ActivityPane (and its ActivityPane↔Right resizer) is shown.
    await ensureFilesActivityVisible(page);

    // Grow to 3 splits → 2 split-gap resizers (split-resizer-0 / -1).
    const addBtn = page.locator('[data-testid="add-terminal-split"]');
    await addBtn.click();
    await addBtn.click();
    await expect(
      page.locator('[data-testid^="terminal-split-pane-"]'),
    ).toHaveCount(3);
    await expect(page.locator('[data-testid^="split-resizer-"]')).toHaveCount(2);

    // Multiple PaneResizer instances must coexist (>= 4):
    // ActivityPane↔Right (1) + History↔Terminal (1) + split gaps (2) = 4.
    const separators = page.locator('[role="separator"]');
    expect(await separators.count()).toBeGreaterThanOrEqual(4);

    // Drag the first split-gap resizer via explicit mouse events so we can
    // observe the cursor DURING and AFTER the drag.
    const resizer = page.locator('[data-testid="split-resizer-0"]');
    const box = await resizer.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy, { steps: 8 });

    // During drag: body cursor is the horizontal resize cursor.
    const cursorDuring = await page.evaluate(
      () => document.body.style.cursor,
    );
    expect(cursorDuring).toBe('col-resize');

    await page.mouse.up();

    // After drag: the drag cursor must NOT linger. Implementation resets
    // `document.body.style.cursor` to '' (PaneResizer.tsx cleanup), so we
    // assert it is no longer 'col-resize' (empty string expected).
    await expect
      .poll(async () => page.evaluate(() => document.body.style.cursor))
      .not.toBe('col-resize');
  });
});
