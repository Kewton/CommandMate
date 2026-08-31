/**
 * E2E: execution contract + verification results on the worktree screen
 * (Issue #1816)
 *
 * Backend decoupled with the existing `page.route` worktree mock, extended with
 * one task row and one verification run. What this proves that the component
 * tests cannot: the Activity Bar really reaches the pane, the header chip
 * really renders inside the detail shell, and the three sections resolve their
 * wording through the real dictionary in a real browser.
 *
 * PC-only surface → self-skip outside chromium, mirroring the split specs.
 */

import { test, expect } from '@playwright/test';
import {
  E2E_WORKTREE_A,
  setupSplitTest,
  type VerificationFixture,
} from './fixtures/terminal-split-helpers';

test.use({ viewport: { width: 1920, height: 1080 } });

const RUN = {
  id: 9,
  worktreeId: E2E_WORKTREE_A,
  instanceId: null,
  taskId: 'e2e-task-1',
  trigger: 'api',
  status: 'failed',
  baseRef: 'origin/develop',
  startedAt: '2026-08-18T00:01:00.000Z',
  finishedAt: '2026-08-18T00:02:00.000Z',
};

const FIXTURE: VerificationFixture = {
  tasks: [
    {
      id: 'e2e-task-1',
      worktreeId: E2E_WORKTREE_A,
      cliToolId: 'claude',
      instanceId: null,
      title: 'E2E contract',
      goal: 'Prove the Verification pane renders end to end.',
      contractPath: '.commandmate/tasks/e2e.yaml',
      contract: {
        version: 1,
        title: 'E2E contract',
        goal: 'Prove the Verification pane renders end to end.',
        scope: { allow: ['src/**'], deny: [] },
        verify: { gates: ['unit'] },
        autoYes: { mode: 'safe', allowPromptTypes: [], denyPatterns: [] },
        success: { requireWorkEvidence: true, requireScopeClean: true },
      },
      status: 'failed',
      lastVerificationRunId: 9,
      createdAt: '2026-08-18T00:00:00.000Z',
      updatedAt: '2026-08-18T00:00:00.000Z',
      startedAt: '2026-08-18T00:00:30.000Z',
      finishedAt: null,
    },
  ],
  runs: [RUN],
  runDetails: {
    9: {
      ...RUN,
      gates: [
        {
          id: 1,
          runId: 9,
          gateId: 'unit',
          command: 'npm run test:unit',
          status: 'failed',
          exitCode: 1,
          durationMs: 45_000,
          logTail: 'FAIL tests/unit/example.test.ts',
          startedAt: '2026-08-18T00:01:00.000Z',
          finishedAt: '2026-08-18T00:01:45.000Z',
          source: 'verify.yaml',
        },
      ],
    },
  },
};

test.describe('Verification pane (Issue #1816)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'PC-only Activity Bar pane (chromium only)');
  });

  test('shows the header chip, the contract, the run list and the gate table', async ({ page }) => {
    await setupSplitTest(page, [E2E_WORKTREE_A], FIXTURE);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);

    // Header chip: present because this worktree has a task row.
    const chip = page.getByTestId('verification-status-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('E2E contract');
    // The reason — not just the verdict — is reachable without opening anything.
    await expect(chip).toHaveAttribute('aria-label', /RESULT failed/);

    // Clicking the chip opens the Verification activity.
    await chip.click();
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'verification');

    await expect(page.getByTestId('verification-contract')).toContainText('src/**');
    await expect(page.getByTestId('verification-run-9')).toContainText('failed');
    await expect(page.getByTestId('verification-gate-unit')).toContainText('FAIL');
    await expect(page.getByTestId('verification-gate-log-unit')).toContainText(
      'FAIL tests/unit/example.test.ts',
    );
  });

  // Issue #2064: the chip used to be absent here, which hid the entry point
  // from exactly the branches that have never been verified. It now shows the
  // "not verified" verdict and still opens the pane.
  test('shows a not-verified chip and an empty pane for a worktree with no contract', async ({
    page,
  }) => {
    await setupSplitTest(page, [E2E_WORKTREE_A]);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);

    await expect(page.getByTestId('activity-bar-button-verification')).toBeVisible();
    const chip = page.getByTestId('verification-status-chip');
    await expect(chip).toBeVisible();
    // No task row, so no task-status badge — only the run verdict.
    await expect(page.getByTestId('verification-chip-task-status')).toHaveCount(0);
    await expect(page.getByTestId('verification-chip-run-status')).toBeVisible();

    // The chip is the entry point, not just an indicator.
    await chip.click();
    await expect(page.getByTestId('activity-pane')).toHaveAttribute('data-active', 'verification');
    await expect(page.getByTestId('verification-contract-empty')).toBeVisible();
    await expect(page.getByTestId('verification-runs-empty')).toBeVisible();
  });

  test('re-verify posts to /verify and re-reads the run list', async ({ page }) => {
    await setupSplitTest(page, [E2E_WORKTREE_A], FIXTURE);

    // Registered AFTER the catch-all so it takes precedence (Playwright runs
    // the most recently added matching handler first).
    let posted = 0;
    await page.route(
      (url) => url.pathname.endsWith(`/api/worktrees/${E2E_WORKTREE_A}/verify`),
      async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        posted += 1;
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({ runId: 10 }),
        });
      },
    );

    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
    await page.getByTestId('activity-bar-button-verification').click();
    await page.getByTestId('verification-rerun-button').click();

    await expect.poll(() => posted).toBe(1);
    // The 202 carries no verdict, so the list request is what closes the loop.
    await expect(page.getByTestId('verification-runs')).toBeVisible();
  });
});
