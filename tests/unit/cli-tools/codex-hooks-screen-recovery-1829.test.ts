/**
 * Issue #1829: `waitForReady` backs out of codex's hooks screens instead of
 * timing out on them.
 *
 * `'3'` on the launch dialog is only the happy path. Once something has
 * confirmed option 1 — the Auto-Yes poller did exactly that on two live
 * sessions, and a human can too — the pane is two screens deep in a review UI
 * whose only exits are `t` (trust, which writes the operator's config) and
 * `esc`. Neither `isCodexHooksReviewDialog` nor `getCodexActiveDialog` matches
 * anything on those screens, so before this change `waitForReady` polled 30
 * times, logged, and returned as if all were well, leaving the session parked
 * there for good.
 *
 * Separate file so `vi.mock` does not affect codex.test.ts (the precedent set
 * by codex-startup-dialog.test.ts).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  capturePane: vi.fn(),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
  sendSpecialKeys: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/cli-tools/validation', () => ({ validateSessionName: vi.fn() }));

// BaseCLITool.isInstalled() uses promisify(exec); resolve it so isInstalled() === true
vi.mock('child_process', () => ({ exec: vi.fn() }));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return { ...actual, promisify: () => vi.fn().mockResolvedValue(undefined) };
});

import { CodexTool } from '@/lib/cli-tools/codex';
import { capturePane, hasSession, sendKeys, sendSpecialKey } from '@/lib/tmux/tmux';
import {
  CODEX_HOOKS_DETAIL_PANE,
  CODEX_HOOKS_LIST_PANE,
  CODEX_HOOKS_REVIEW_PANE,
  CODEX_READY_PANE,
} from '../../fixtures/codex-hooks-review-0148';

const WORKTREE_ID = 'wt-1829-recovery';

/** Run startSession to completion with the polling waits collapsed. */
async function startSession(): Promise<void> {
  vi.useFakeTimers();
  try {
    const promise = new CodexTool().startSession(WORKTREE_ID, '/tmp/wt-1829-recovery');
    await vi.runAllTimersAsync();
    await promise;
  } finally {
    vi.useRealTimers();
  }
}

function escapes(): number {
  return vi.mocked(sendSpecialKey).mock.calls.filter(([, key]) => key === 'Escape').length;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasSession).mockResolvedValue(false);
  vi.mocked(capturePane).mockResolvedValue(CODEX_READY_PANE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForReady backs out of the hooks screens', () => {
  it('escapes out of the review detail, then out of the list, and reaches the prompt', async () => {
    vi.mocked(capturePane)
      .mockResolvedValueOnce(CODEX_HOOKS_DETAIL_PANE) // screen 3: "esc to go back"
      .mockResolvedValueOnce(CODEX_HOOKS_LIST_PANE) // screen 2: "esc to close"
      .mockResolvedValue(CODEX_READY_PANE);

    await startSession();

    expect(escapes()).toBe(2);
    // `t` would trust the hooks, writing `[hooks.state…]` into the operator's
    // own ~/.codex/config.toml. Issue #1760 declined that on their behalf and
    // this recovery path must not quietly grant it.
    expect(vi.mocked(sendKeys).mock.calls.map(([, sent]) => sent)).not.toContain('t');
  });

  it('gives up rather than hammering esc at a screen that will not close', async () => {
    // 30 polls * 1 esc would be 30 keystrokes into whatever is really there.
    vi.mocked(capturePane).mockResolvedValue(CODEX_HOOKS_DETAIL_PANE);

    await startSession();

    expect(escapes()).toBeGreaterThan(0);
    expect(escapes()).toBeLessThanOrEqual(4);
  });

  it('sends no esc at all when the prompt is simply ready', async () => {
    await startSession();
    expect(escapes()).toBe(0);
  });

  it('still declines the launch dialog with a bare "3" on 0.148.0', async () => {
    // The Issue #1760 path, re-pinned against the 0.148.0 capture (the wording
    // that changed — "4 hooks are new or changed." — is not an anchor).
    vi.mocked(capturePane)
      .mockResolvedValueOnce(CODEX_HOOKS_REVIEW_PANE)
      .mockResolvedValue(CODEX_READY_PANE);

    await startSession();

    expect(vi.mocked(sendKeys).mock.calls.map(([, sent, enter]) => [sent, enter])).toContainEqual([
      '3',
      false,
    ]);
    expect(escapes()).toBe(0);
  });
});
