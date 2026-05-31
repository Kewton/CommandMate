/**
 * E2E: terminal split config is isolated per worktree
 * (Issue #735 / #728 AC-27 Scenario 2)
 *
 * AC-27 #2: the split count persists per-worktree in localStorage
 * (`commandmate:terminalSplits:{worktreeId}`). Setting splits in worktree A
 * must not affect worktree B, and switching back restores each worktree's own
 * config. Verifies the worktreeId-scoped persistence end-to-end via the split
 * pane DOM count — no tmux/CLI session required.
 *
 * PC-only UI → self-skip on Mobile Safari (S3-004). Backend decoupled via API
 * mocks; localStorage isolated per test so prior runs/retries cannot leak.
 */

import { test, expect } from '@playwright/test';
import {
  E2E_WORKTREE_A,
  E2E_WORKTREE_B,
  setupSplitTest,
} from './fixtures/terminal-split-helpers';

test.use({ viewport: { width: 1920, height: 1080 } });

test.describe('Terminal split — cross-worktree persistence (AC-27 #2)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    // PC-only split UI: skip on the Mobile Safari project (S3-004).
    test.skip(
      testInfo.project.name !== 'chromium',
      'PC-only split UI (chromium only)',
    );
    await setupSplitTest(page, [E2E_WORKTREE_A, E2E_WORKTREE_B]);
  });

  test('split config persists per worktree and does not leak across worktrees', async ({
    page,
  }) => {
    const panes = page.locator('[data-testid^="terminal-split-pane-"]');
    const addBtn = page.locator('[data-testid="add-terminal-split"]');

    // Worktree A: grow to 3 splits (default starts at 1).
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
    await expect(
      page.locator('[data-testid="terminal-split-container"]'),
    ).toBeVisible();
    await expect(panes).toHaveCount(1);
    await addBtn.click();
    await addBtn.click();
    await expect(panes).toHaveCount(3);

    // Switch to worktree B: starts at the default (1), unaffected by A.
    await page.goto(`/worktrees/${E2E_WORKTREE_B}`);
    await expect(
      page.locator('[data-testid="terminal-split-container"]'),
    ).toBeVisible();
    await expect(panes).toHaveCount(1);

    // Modify B → 2 splits.
    await addBtn.click();
    await expect(panes).toHaveCount(2);

    // Back to A: must restore A's 3 splits (not B's 2).
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
    await expect(
      page.locator('[data-testid="terminal-split-container"]'),
    ).toBeVisible();
    await expect(panes).toHaveCount(3);

    // Back to B: must restore B's 2 splits.
    await page.goto(`/worktrees/${E2E_WORKTREE_B}`);
    await expect(panes).toHaveCount(2);
  });
});
