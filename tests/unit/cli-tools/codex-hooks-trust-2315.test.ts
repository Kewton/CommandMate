/**
 * Issue #2315 (R2): the launch handler establishes trust instead of declining
 * it, and something still owns the screens after the launch is over.
 *
 * The reported session was found on screen 3 of codex's hook review with
 * `sessionStatus: waiting`, `isSelectionListActive: true (CODEX_HOOKS_REVIEW)`
 * and `promptKind: null` — a screen Auto-Yes is designed not to touch, on a pane
 * `waitForReady` had long since stopped watching. Two things had to change:
 *
 *  - the answer. `3` (Continue without trusting) is not remembered by codex, so
 *    it bought one launch and the dialog came back on the next — and the hooks
 *    CommandMate writes the file for never ran. `2` (Trust all and continue)
 *    is recorded as a `trusted_hash`, which is what makes the screen stop
 *    coming back. Withheld from a worktree shipping its own `.codex/hooks.json`
 *    (`shouldTrustCodexHooks`) and from `CM_CODEX_HOOK_TRUST=never`.
 *  - the owner. `waitForReady` runs once, at launch. The Issue #1829 sessions
 *    were found in a shape where the dialog came back AFTER the prompt had come
 *    up, and nothing was left watching; every subsequent send then timed out in
 *    `waitForPrompt` and threw. It now clears the screens itself.
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

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/validation', () => ({ validateSessionName: vi.fn() }));

vi.mock('child_process', () => ({ exec: vi.fn() }));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return { ...actual, promisify: () => vi.fn().mockResolvedValue(undefined) };
});

import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { CodexTool } from '@/lib/cli-tools/codex';
import {
  capturePane,
  getSessionWorkingDirectory,
  hasSession,
  sendKeys,
  sendSpecialKey,
} from '@/lib/tmux/tmux';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { CODEX_HOOK_TRUST_ENV_VAR } from '@/lib/hooks/sources/codex/hooks-config';
import {
  CODEX_HOOKS_DETAIL_PANE,
  CODEX_HOOKS_LIST_PANE,
  CODEX_HOOKS_REVIEW_PANE,
  CODEX_HOOKS_STUCK_PANE,
  CODEX_READY_PANE,
} from '../../fixtures/codex-hooks-review-0148';

const WORKTREE_ID = 'wt-2315';

let plain: string;
let withRepoHooks: string;
let savedTrust: string | undefined;

/** Keys sent alone — every dialog answer, and never the launch line (#890). */
function keysSent(): string[] {
  return vi
    .mocked(sendKeys)
    .mock.calls.filter(([, , enter]) => enter === false)
    .map(([, sent]) => String(sent));
}

function escapes(): number {
  return vi.mocked(sendSpecialKey).mock.calls.filter(([, key]) => key === 'Escape').length;
}

async function startSession(worktreePath: string): Promise<void> {
  vi.useFakeTimers();
  try {
    const promise = new CodexTool().startSession(WORKTREE_ID, worktreePath);
    await vi.runAllTimersAsync();
    await promise;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  savedTrust = process.env[CODEX_HOOK_TRUST_ENV_VAR];
  delete process.env[CODEX_HOOK_TRUST_ENV_VAR];
  plain = mkdtempSync(join(tmpdir(), 'codex-2315-plain-'));
  withRepoHooks = mkdtempSync(join(tmpdir(), 'codex-2315-repo-'));
  mkdirSync(join(withRepoHooks, '.codex'), { recursive: true });
  writeFileSync(join(withRepoHooks, '.codex', 'hooks.json'), '{"hooks":{}}');
  vi.mocked(hasSession).mockResolvedValue(false);
  vi.mocked(capturePane).mockResolvedValue(CODEX_READY_PANE);
  vi.mocked(getSessionWorkingDirectory).mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  if (savedTrust === undefined) delete process.env[CODEX_HOOK_TRUST_ENV_VAR];
  else process.env[CODEX_HOOK_TRUST_ENV_VAR] = savedTrust;
  removeTempDir(plain);
  removeTempDir(withRepoHooks);
});

describe('the launch answers the review dialog with trust', () => {
  it('sends "2" — the grant codex actually remembers — for an ordinary worktree', async () => {
    vi.mocked(capturePane)
      .mockResolvedValueOnce(CODEX_HOOKS_REVIEW_PANE)
      .mockResolvedValue(CODEX_READY_PANE);

    await startSession(plain);

    // Sent alone: the number selects AND confirms, and a trailing Enter would
    // land on the screen it just opened (Issue #890).
    expect(vi.mocked(sendKeys).mock.calls.map(([, sent, enter]) => [sent, enter])).toContainEqual([
      '2',
      false,
    ]);
    expect(keysSent()).not.toContain('3');
  });

  it('declines instead when the worktree ships its own .codex/hooks.json', async () => {
    // "Trust all" would cover the repository's hooks too, and a repository is
    // not a thing this server grants trust to on the operator's behalf.
    vi.mocked(capturePane)
      .mockResolvedValueOnce(CODEX_HOOKS_REVIEW_PANE)
      .mockResolvedValue(CODEX_READY_PANE);

    await startSession(withRepoHooks);

    expect(keysSent()).toEqual(['3']);
  });

  it('escapes rather than trusting the screens below it for such a worktree', async () => {
    vi.mocked(capturePane)
      .mockResolvedValueOnce(CODEX_HOOKS_LIST_PANE)
      .mockResolvedValueOnce(CODEX_HOOKS_DETAIL_PANE)
      .mockResolvedValue(CODEX_READY_PANE);

    await startSession(withRepoHooks);

    expect(escapes()).toBe(2);
    expect(keysSent()).not.toContain('t');
  });

  it('declines everywhere under CM_CODEX_HOOK_TRUST=never', async () => {
    process.env[CODEX_HOOK_TRUST_ENV_VAR] = 'never';
    vi.mocked(capturePane)
      .mockResolvedValueOnce(CODEX_HOOKS_REVIEW_PANE)
      .mockResolvedValue(CODEX_READY_PANE);

    await startSession(plain);

    expect(keysSent()).toEqual(['3']);
  });
});

describe('the screens are still owned after the launch is over', () => {
  /** A live session whose pane is the Issue #1829 stuck shape. */
  async function sendInto(pane: string, worktreePath: string | null): Promise<void> {
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(getSessionWorkingDirectory).mockResolvedValue(worktreePath);
    // Twice: the first capture belongs to #2070's liveness probe (the pane is
    // alive — a hooks screen is not a shell prompt), the second is the first
    // `waitForPrompt` poll. Recovered from then on.
    vi.mocked(capturePane)
      .mockResolvedValueOnce(pane)
      .mockResolvedValueOnce(pane)
      .mockResolvedValue(CODEX_READY_PANE);

    vi.useFakeTimers();
    try {
      const promise = new CodexTool().sendMessage(WORKTREE_ID, 'hello');
      await vi.runAllTimersAsync();
      await promise;
    } finally {
      vi.useRealTimers();
    }
  }

  it('clears a review screen that came back, then sends the message', async () => {
    // Before this, `waitForPrompt` polled for 15 s, threw, and left the pane
    // exactly where it was — session after session, with `kill-session` by hand
    // as the only way out.
    await sendInto(CODEX_HOOKS_STUCK_PANE, plain);

    expect(keysSent()).toContain('t');
    expect(vi.mocked(sendMessageWithSubmitVerification)).toHaveBeenCalledTimes(1);
  });

  it('asks the pane where it is, so the provenance check still applies', async () => {
    await sendInto(CODEX_HOOKS_STUCK_PANE, withRepoHooks);

    expect(keysSent()).not.toContain('t');
    expect(escapes()).toBe(1);
    expect(vi.mocked(sendMessageWithSubmitVerification)).toHaveBeenCalledTimes(1);
  });

  it('withholds trust when the pane will not say where it is', async () => {
    // No path, no provenance check, no grant. `esc` still gets the pane back.
    await sendInto(CODEX_HOOKS_STUCK_PANE, null);

    expect(keysSent()).not.toContain('t');
    expect(escapes()).toBe(1);
  });

  it('costs no extra tmux round trip when there is no hooks screen', async () => {
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(capturePane).mockResolvedValue(CODEX_READY_PANE);

    await new CodexTool().sendMessage(WORKTREE_ID, 'hello');

    // Resolved lazily: `waitForPrompt` asks for the working directory only when
    // a hooks screen actually shows up.
    expect(vi.mocked(getSessionWorkingDirectory)).not.toHaveBeenCalled();
    expect(vi.mocked(sendMessageWithSubmitVerification)).toHaveBeenCalledTimes(1);
  });
});
