/**
 * Unit tests for CodexTool first-launch dialog handling (Issue #890)
 *
 * Verifies:
 *  A) update-skip ('2') and trust ('1') number selections are sent WITHOUT a
 *     trailing Enter (sendEnter=false), so no stray Enter lands on the next
 *     screen (empty submit / accidental "Update now" confirm).
 *  B) waitForReady / waitForPrompt treat a residual update/trust dialog as
 *     "not ready" -- the dialog's "› 1." option line must not be mistaken for
 *     the input prompt -- so the first message is never typed into a dialog.
 *
 * Separate file so vi.mock does not affect codex.test.ts (SF precedent:
 * codex-pasted-text.test.ts).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock tmux module
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

vi.mock('@/lib/pasted-text-helper', () => ({
  detectAndResendIfPastedText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/cli-tools/validation', () => ({
  validateSessionName: vi.fn(),
}));

// BaseCLITool.isInstalled() uses promisify(exec); resolve it so isInstalled() === true
vi.mock('child_process', () => ({ exec: vi.fn() }));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: () => vi.fn().mockResolvedValue(undefined),
  };
});

import { CodexTool } from '@/lib/cli-tools/codex';
import { hasSession, createSession, sendKeys, sendSpecialKey, capturePane, reconcileSessionGeometry } from '@/lib/tmux/tmux';

const WORKTREE_ID = 'test-worktree';
const SESSION = 'mcbd-codex-test-worktree';

// First-launch screens (each option dialog confirms on the number key alone -- no Enter).
// The selected option marker "›" renders at column 0 (same column as the genuine
// prompt), so CODEX_PROMPT_PATTERN alone is fooled -- the dialog guard must reject it.
const UPDATE_DIALOG = [
  '✨ Update available! 0.139.0 -> 0.140.0',
  '› 1. Update now (runs `npm install -g @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  'Press enter to continue',
].join('\n');

const TRUST_DIALOG = [
  'Do you trust the contents of this directory?',
  '› 1. Yes, continue',
  '  2. No, quit',
].join('\n');

const PROMPT = '› ';

// Issue #890 regression: after the update is skipped, codex keeps a NON-interactive
// "✨ Update available!" banner box rendered ABOVE the genuine prompt. This realistic
// frame (banner + prompt coexisting) must be treated as READY -- otherwise matching
// "Update available" would hang waitForReady (~30s) / waitForPrompt (15s).
const READY_WITH_BANNER = [
  '╭──────────────────────────────────────────────────╮',
  '│ ✨ Update available! 0.139.0 -> 0.140.0          │',
  '│ Run npm install -g @openai/codex to update.      │',
  '╰──────────────────────────────────────────────────╯',
  '',
  '› Summarize recent commits',
].join('\n');

// Issue #892: capturePane(50) returns scrollback, so the just-dismissed update
// dialog stays in the SAME capture ABOVE the now-live genuine prompt. This is the
// real-device frame the Issue #890 whole-window check missed -- it stayed "not
// ready" forever (hang) AND kept re-matching "Update"+"Skip", re-sending "2" every
// poll ("222..."). Position-based detection must treat this as READY.
const UPDATE_RESIDUAL_PLUS_PROMPT = [
  '✨ Update available! 0.139.0 -> 0.140.0',
  '› 1. Update now (runs `npm install -g @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  'Press enter to continue',
  '› ',
].join('\n');

describe('CodexTool first-launch dialog handling (Issue #890)', () => {
  let tool: CodexTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new CodexTool();
    vi.mocked(createSession).mockResolvedValue();
    vi.mocked(sendKeys).mockResolvedValue();
    vi.mocked(sendSpecialKey).mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reconciles geometry when reusing an existing Codex session', async () => {
    vi.mocked(hasSession).mockResolvedValue(true);

    await tool.startSession(WORKTREE_ID, '/test/path', 'codex-2');

    expect(createSession).not.toHaveBeenCalled();
    expect(reconcileSessionGeometry).toHaveBeenCalledWith(
      'mcbd-codex-test-worktree-2',
      undefined,
    );
  });

  describe('waitForReady (A: no stray Enter on number selections)', () => {
    it('untrusted dir: sends update-skip "2" and trust "1" WITHOUT trailing Enter, then reaches the prompt', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(capturePane)
        .mockResolvedValueOnce(UPDATE_DIALOG)
        .mockResolvedValueOnce(TRUST_DIALOG)
        .mockResolvedValue(PROMPT);

      vi.useFakeTimers();
      try {
        const promise = tool.startSession(WORKTREE_ID, '/test/path');
        await vi.runAllTimersAsync();
        await promise;
      } finally {
        vi.useRealTimers();
      }

      // The launch command keeps its Enter; the number selections must not.
      expect(sendKeys).toHaveBeenCalledWith(SESSION, 'codex', true);
      expect(sendKeys).toHaveBeenCalledWith(SESSION, '2', false);
      expect(sendKeys).toHaveBeenCalledWith(SESSION, '1', false);

      // Regression guard: number selections must NEVER be sent with a trailing Enter.
      expect(sendKeys).not.toHaveBeenCalledWith(SESSION, '2', true);
      expect(sendKeys).not.toHaveBeenCalledWith(SESSION, '1', true);
    });

    it('already-trusted dir: skips update without Enter and never sends a trust selection', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(capturePane)
        .mockResolvedValueOnce(UPDATE_DIALOG)
        .mockResolvedValue(PROMPT);

      vi.useFakeTimers();
      try {
        const promise = tool.startSession(WORKTREE_ID, '/test/path');
        await vi.runAllTimersAsync();
        await promise;
      } finally {
        vi.useRealTimers();
      }

      expect(sendKeys).toHaveBeenCalledWith(SESSION, '2', false);
      // No trust dialog appeared, so '1' must never be sent.
      expect(sendKeys).not.toHaveBeenCalledWith(SESSION, '1', false);
      expect(sendKeys).not.toHaveBeenCalledWith(SESSION, '1', true);
    });
  });

  describe('waitForPrompt (B: dialog option line is not mistaken for the prompt)', () => {
    it('keeps polling while a dialog is active and only sends the message once a genuine prompt is ready', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane)
        .mockResolvedValueOnce(UPDATE_DIALOG) // residual dialog -> not ready, keep polling
        .mockResolvedValueOnce(TRUST_DIALOG)  // residual dialog -> not ready, keep polling
        .mockResolvedValue(PROMPT);           // genuine prompt -> ready

      vi.useFakeTimers();
      try {
        const promise = tool.sendMessage(WORKTREE_ID, 'hello world');
        await vi.runAllTimersAsync();
        await promise;
      } finally {
        vi.useRealTimers();
      }

      // With the legacy guardless check, the "› 1." option line would be treated as
      // ready and capturePane would be called only once. The hardened check polls past
      // both dialog frames.
      expect(vi.mocked(capturePane).mock.calls.length).toBeGreaterThanOrEqual(3);

      // Message is delivered without Enter; Enter is sent separately as C-m.
      expect(sendKeys).toHaveBeenCalledWith(SESSION, 'hello world', false);
      expect(sendSpecialKey).toHaveBeenCalledWith(SESSION, 'C-m');
    });
  });

  describe('persistent post-skip "Update available" banner (Issue #890 regression)', () => {
    it('waitForReady: reaches the prompt immediately when the banner coexists with the prompt (no timeout polling)', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(capturePane).mockResolvedValue(READY_WITH_BANNER);

      vi.useFakeTimers();
      try {
        const promise = tool.startSession(WORKTREE_ID, '/test/path');
        await vi.runAllTimersAsync();
        await promise;
      } finally {
        vi.useRealTimers();
      }

      // The banner is non-interactive, so it must be treated as ready on the first
      // poll. With the regressed pattern (matching "Update available") this would
      // never be ready and capturePane would be called ~CODEX_INIT_MAX_ATTEMPTS times.
      expect(vi.mocked(capturePane).mock.calls.length).toBeLessThanOrEqual(2);
      // A ready banner frame is not a dialog: no skip/trust number keys are sent.
      expect(sendKeys).not.toHaveBeenCalledWith(SESSION, '2', false);
      expect(sendKeys).not.toHaveBeenCalledWith(SESSION, '1', false);
    });

    it('waitForPrompt: sends the message immediately when the banner coexists with the prompt (no timeout polling)', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue(READY_WITH_BANNER);

      vi.useFakeTimers();
      try {
        const promise = tool.sendMessage(WORKTREE_ID, 'hello world');
        await vi.runAllTimersAsync();
        await promise;
      } finally {
        vi.useRealTimers();
      }

      // Ready on the first poll -> no 15s timeout wait (regressed pattern would poll
      // ~30 times until the waitForPrompt timeout before sending anyway).
      expect(vi.mocked(capturePane).mock.calls.length).toBeLessThanOrEqual(2);
      expect(sendKeys).toHaveBeenCalledWith(SESSION, 'hello world', false);
      expect(sendSpecialKey).toHaveBeenCalledWith(SESSION, 'C-m');
    });
  });

  // Issue #892: scrollback retention of a dismissed dialog in the SAME capture.
  describe('residual dialog + genuine prompt coexist in one capture (Issue #892)', () => {
    it('waitForReady: sends update "2" exactly ONCE and never re-sends on the residual dialog ("222..." guard)', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(capturePane)
        .mockResolvedValueOnce(UPDATE_DIALOG)                // active dialog -> send "2"
        .mockResolvedValueOnce(UPDATE_DIALOG)                // transient: dialog still bottom, must NOT re-send
        .mockResolvedValue(UPDATE_RESIDUAL_PLUS_PROMPT);     // dialog now residual above the live prompt -> ready

      vi.useFakeTimers();
      try {
        const promise = tool.startSession(WORKTREE_ID, '/test/path');
        await vi.runAllTimersAsync();
        await promise;
      } finally {
        vi.useRealTimers();
      }

      // The core "222..." regression: "2" must be sent exactly once even though the
      // dialog text re-appears in later captures (transient + residual scrollback).
      const skipCalls = vi.mocked(sendKeys).mock.calls.filter(
        (c) => c[0] === SESSION && c[1] === '2'
      );
      expect(skipCalls).toHaveLength(1);
    });

    it('waitForReady: treats the residual-dialog-above-prompt frame as ready without sending any number key', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(capturePane).mockResolvedValue(UPDATE_RESIDUAL_PLUS_PROMPT);

      vi.useFakeTimers();
      try {
        const promise = tool.startSession(WORKTREE_ID, '/test/path');
        await vi.runAllTimersAsync();
        await promise;
      } finally {
        vi.useRealTimers();
      }

      // Genuine prompt is below the stale dialog -> ready on the first poll, no keys.
      expect(vi.mocked(capturePane).mock.calls.length).toBeLessThanOrEqual(2);
      expect(sendKeys).not.toHaveBeenCalledWith(SESSION, '2', false);
      expect(sendKeys).not.toHaveBeenCalledWith(SESSION, '1', false);
    });

    it('waitForPrompt: sends the message immediately when a stale dialog sits above the live prompt', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue(UPDATE_RESIDUAL_PLUS_PROMPT);

      vi.useFakeTimers();
      try {
        const promise = tool.sendMessage(WORKTREE_ID, 'explain this branch');
        await vi.runAllTimersAsync();
        await promise;
      } finally {
        vi.useRealTimers();
      }

      // No "2" prefix is injected; the message is delivered cleanly.
      expect(sendKeys).not.toHaveBeenCalledWith(SESSION, '2', false);
      expect(sendKeys).toHaveBeenCalledWith(SESSION, 'explain this branch', false);
      expect(sendSpecialKey).toHaveBeenCalledWith(SESSION, 'C-m');
    });
  });

  // Issue #892: fall-through removal -- a failed readiness check must STOP the send.
  describe('waitForPrompt timeout does not send the message (Issue #892)', () => {
    it('throws (no message typed) when the prompt never becomes ready before the timeout', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      // Dialog stays active forever -> isCodexPromptReady never true -> timeout.
      vi.mocked(capturePane).mockResolvedValue(UPDATE_DIALOG);

      vi.useFakeTimers();
      try {
        const promise = tool.sendMessage(WORKTREE_ID, 'should never be typed');
        const assertion = expect(promise).rejects.toThrow(
          /Failed to send message to Codex/
        );
        await vi.runAllTimersAsync();
        await assertion;
      } finally {
        vi.useRealTimers();
      }

      // The whole point: on timeout the message is NOT typed and Enter is NOT sent.
      expect(sendKeys).not.toHaveBeenCalledWith(SESSION, 'should never be typed', false);
      expect(sendSpecialKey).not.toHaveBeenCalledWith(SESSION, 'C-m');
    });
  });
});
