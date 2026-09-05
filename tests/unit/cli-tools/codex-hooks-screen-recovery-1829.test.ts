/**
 * Issue #1829, reworked by Issue #2315: `waitForReady` gets the pane off
 * codex's hooks screens instead of timing out on them.
 *
 * #1829 established that something has to press a key here — before it, the
 * whole 30-attempt window elapsed, `waitForReady` returned as if all were well,
 * and the session was left parked in a review UI that reports as `running`
 * because none of its screens carries an option, a confirm footer or a thinking
 * indicator.
 *
 * #2315 changed *which* key and *how many*:
 *
 *  - the launch dialog is answered with `2` (Trust all and continue) rather than
 *    `3` (Continue without trusting), because codex remembers only a grant —
 *    a decline bought exactly one launch and the dialog came back on the next
 *    one, forever. `CM_CODEX_HOOK_TRUST=never` keeps the old answer, and so
 *    does a worktree that ships its own `.codex/hooks.json`;
 *  - the budget is per screen and resets on progress, in place of the four
 *    presses #1829 shared across a whole launch. A pane that legitimately walks
 *    screen 1 -> 2 -> 3 could exhaust a launch-wide budget on the way down and
 *    park on the last screen, which is one of the two ways the session in #2315
 *    got stuck.
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
  getSessionWorkingDirectory: vi.fn(),
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
import { CODEX_HOOK_TRUST_ENV_VAR } from '@/lib/hooks/sources/codex/hooks-config';
import {
  CODEX_HOOKS_DETAIL_PANE,
  CODEX_HOOKS_LIST_PANE,
  CODEX_HOOKS_REVIEW_PANE,
  CODEX_READY_PANE,
} from '../../fixtures/codex-hooks-review-0148';

const WORKTREE_ID = 'wt-1829-recovery';
/** A path with no `.codex/hooks.json` in it, so the default policy may trust. */
const WORKTREE_PATH = '/tmp/wt-1829-recovery';

/** `waitForReady`'s window; reaching it is what "parked" means. */
const INIT_MAX_ATTEMPTS = 30;

let savedTrust: string | undefined;

/** Run startSession to completion with the polling waits collapsed. */
async function startSession(): Promise<void> {
  vi.useFakeTimers();
  try {
    const promise = new CodexTool().startSession(WORKTREE_ID, WORKTREE_PATH);
    await vi.runAllTimersAsync();
    await promise;
  } finally {
    vi.useRealTimers();
  }
}

function escapes(): number {
  return vi.mocked(sendSpecialKey).mock.calls.filter(([, key]) => key === 'Escape').length;
}

/**
 * Every key `sendKeys` was asked to send, launch line excluded.
 *
 * The launch line is the only call that asks for a trailing Enter; every dialog
 * key is sent alone (Issue #890), so `sendEnter` separates the two exactly.
 */
function keysSent(): string[] {
  return vi
    .mocked(sendKeys)
    .mock.calls.filter(([, , enter]) => enter === false)
    .map(([, sent]) => String(sent));
}

function trustKeys(): number {
  return keysSent().filter((sent) => sent === 't').length;
}

beforeEach(() => {
  vi.clearAllMocks();
  savedTrust = process.env[CODEX_HOOK_TRUST_ENV_VAR];
  delete process.env[CODEX_HOOK_TRUST_ENV_VAR];
  vi.mocked(hasSession).mockResolvedValue(false);
  vi.mocked(capturePane).mockResolvedValue(CODEX_READY_PANE);
});

afterEach(() => {
  vi.useRealTimers();
  if (savedTrust === undefined) delete process.env[CODEX_HOOK_TRUST_ENV_VAR];
  else process.env[CODEX_HOOK_TRUST_ENV_VAR] = savedTrust;
});

describe('waitForReady clears the hooks screens', () => {
  it('trusts its way out of the review detail, then the list, and reaches the prompt', async () => {
    vi.mocked(capturePane)
      .mockResolvedValueOnce(CODEX_HOOKS_DETAIL_PANE) // screen 3: "Press t to trust"
      .mockResolvedValueOnce(CODEX_HOOKS_LIST_PANE) // screen 2: "Press t to trust all"
      .mockResolvedValue(CODEX_READY_PANE);

    await startSession();

    // `t` is the key both screens print in their OWN footer, which is what makes
    // it safe to send where a menu position would be a guess.
    expect(trustKeys()).toBe(2);
    expect(escapes()).toBe(0);
    // …and the loop left through the prompt, not through the end of the window.
    expect(vi.mocked(capturePane).mock.calls.length).toBeLessThan(INIT_MAX_ATTEMPTS);
  });

  it('walks all three screens on one budget each, without parking on the last', async () => {
    // THE regression this Issue turns on. #1829 spent four `esc` presses across
    // the whole launch; a pane that descends 1 -> 2 -> 3 and needs one key per
    // screen must not be able to run out of them. Collapse the per-screen
    // budget into a single launch-wide one and this test parks on screen 3.
    vi.mocked(capturePane)
      .mockResolvedValueOnce(CODEX_HOOKS_REVIEW_PANE)
      .mockResolvedValueOnce(CODEX_HOOKS_LIST_PANE)
      .mockResolvedValueOnce(CODEX_HOOKS_DETAIL_PANE)
      .mockResolvedValue(CODEX_READY_PANE);

    await startSession();

    expect(keysSent()).toEqual(['2', 't', 't']);
    expect(vi.mocked(capturePane).mock.calls.length).toBeLessThan(INIT_MAX_ATTEMPTS);
  });

  it('gives up rather than hammering one screen that will not respond', async () => {
    // 30 polls * 1 key would be 30 keystrokes into whatever is really there.
    vi.mocked(capturePane).mockResolvedValue(CODEX_HOOKS_DETAIL_PANE);

    await startSession();

    expect(trustKeys()).toBeGreaterThan(0);
    expect(trustKeys()).toBeLessThanOrEqual(3);
  });

  it('tries the review dialog’s other option before giving up on it', async () => {
    // A numbered option is a menu position codex may renumber. If `2` does not
    // move the screen, `1` descends into the list — whose footer NAMES the key
    // that closes it, turning a guess into something the screen said itself.
    vi.mocked(capturePane).mockResolvedValue(CODEX_HOOKS_REVIEW_PANE);

    await startSession();

    expect(keysSent()).toEqual(['2', '1', '1']);
  });

  it('sends nothing at all when the prompt is simply ready', async () => {
    await startSession();
    expect(escapes()).toBe(0);
    expect(keysSent()).toEqual([]);
  });
});

describe('CM_CODEX_HOOK_TRUST=never keeps the pre-#2315 answers', () => {
  beforeEach(() => {
    process.env[CODEX_HOOK_TRUST_ENV_VAR] = 'never';
  });

  it('declines the launch dialog and escapes the screens below it', async () => {
    vi.mocked(capturePane)
      .mockResolvedValueOnce(CODEX_HOOKS_REVIEW_PANE)
      .mockResolvedValueOnce(CODEX_HOOKS_LIST_PANE)
      .mockResolvedValueOnce(CODEX_HOOKS_DETAIL_PANE)
      .mockResolvedValue(CODEX_READY_PANE);

    await startSession();

    expect(keysSent()).toEqual(['3']);
    expect(escapes()).toBe(2);
    // Nothing writes `[hooks.state…]` into the operator's ~/.codex/config.toml
    // under this policy — that is the whole of what it buys.
    expect(trustKeys()).toBe(0);
    expect(vi.mocked(capturePane).mock.calls.length).toBeLessThan(INIT_MAX_ATTEMPTS);
  });

  it('still resets its budget per screen, so the descent does not park', async () => {
    vi.mocked(capturePane)
      .mockResolvedValueOnce(CODEX_HOOKS_LIST_PANE)
      .mockResolvedValueOnce(CODEX_HOOKS_DETAIL_PANE)
      .mockResolvedValueOnce(CODEX_HOOKS_LIST_PANE)
      .mockResolvedValue(CODEX_READY_PANE);

    await startSession();

    expect(escapes()).toBe(3);
    expect(vi.mocked(capturePane).mock.calls.length).toBeLessThan(INIT_MAX_ATTEMPTS);
  });
});
