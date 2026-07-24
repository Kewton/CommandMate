/**
 * Unit tests for the shared submit-verified sender (Issues #1469, #1470, #1471).
 *
 * Covers, for every interactive tool:
 *   - body and Enter are sent as SEPARATE tmux commands (never a batched
 *     body+C-m send-keys),
 *   - single-line / multi-line / long (paste-length) messages all confirm submit
 *     (no `\n` gate),
 *   - a typed-but-unsent message is recovered by resending Enter,
 *   - an unconfirmable submit THROWS (never resolves as a silent success),
 *   - vibe-local's IME double-Enter is preserved,
 *   - verification does not depend on the version-specific `[Pasted text #N]`
 *     string (broadened placeholder + read-back).
 *
 * cli-patterns is intentionally NOT mocked so the real per-tool "generating"
 * detection and ANSI stripping are exercised.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
  clearInputLine: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

import {
  sendMessageWithSubmitVerification,
  isSubmitted,
  classifySubmit,
} from '@/lib/cli-tools/submit-verified-sender';
import { sendKeys, sendSpecialKeys, capturePane, clearInputLine } from '@/lib/tmux/tmux';
import { invalidateCache } from '@/lib/tmux/tmux-capture-cache';
import type { CLIToolType } from '@/lib/cli-tools/types';

const SESSION = 'mcbd-claude-test-wt';
/** Input line cleared -> the message left the box -> submitted. */
const EMPTY_PROMPT = '❯ ';

const INTERACTIVE_TOOLS: CLIToolType[] = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'copilot',
  'vibe-local',
  'antigravity',
];

const LONG_MESSAGE = 'x'.repeat(4000); // guaranteed to fold into a bracketed paste

describe('submit-verified-sender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendKeys).mockResolvedValue(undefined);
    vi.mocked(sendSpecialKeys).mockResolvedValue(undefined);
    vi.mocked(clearInputLine).mockResolvedValue(undefined);
    vi.mocked(invalidateCache).mockReturnValue(undefined);
  });

  // ---------------------------------------------------------------------------
  // isSubmitted() — pure, version-independent decision logic
  // ---------------------------------------------------------------------------
  describe('isSubmitted()', () => {
    it('treats an empty input line as submitted', () => {
      expect(isSubmitted(EMPTY_PROMPT, 'claude', 'hello')).toBe(true);
    });

    it('treats an actively generating pane as submitted (no prompt line needed)', () => {
      expect(isSubmitted('working… (esc to interrupt)', 'claude', 'hello')).toBe(true);
    });

    it('treats the message still on the input line as NOT submitted', () => {
      expect(isSubmitted('❯ hello world stuck here', 'claude', 'hello world stuck here')).toBe(false);
    });

    it('treats a folded paste placeholder on the input line as NOT submitted', () => {
      expect(isSubmitted('❯ [Pasted text #1 +40 lines]', 'claude', LONG_MESSAGE)).toBe(false);
    });

    it('is version-resilient: matches [Pasted text +N lines] without the #N', () => {
      // Issue #1469 condition 2: a CLI version drift dropping `#N` must still be caught.
      expect(isSubmitted('❯ [Pasted text +40 lines]', 'claude', LONG_MESSAGE)).toBe(false);
    });

    it('does not false-positive on the message echoed into history above an empty prompt', () => {
      // After submit the TUI echoes the user message into history, then shows an
      // empty prompt below it. The empty input line must win.
      const pane = '❯ hello world\n  (assistant is composing)\n❯ ';
      expect(isSubmitted(pane, 'claude', 'hello world')).toBe(true);
    });

    it('finds the input line even when a status-bar footer is rendered below it', () => {
      // antigravity renders "? for shortcuts …" beneath the input box.
      const pane = '❯ still pending message\n? for shortcuts   model';
      expect(isSubmitted(pane, 'antigravity', 'still pending message')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // classifySubmit() — TUI popup replacement detection (Issue #1501)
  // ---------------------------------------------------------------------------
  describe('classifySubmit() replacement detection', () => {
    it('submitted: empty input line', () => {
      expect(classifySubmit(EMPTY_PROMPT, 'claude', 'hello')).toBe('submitted');
    });

    it('submitted: actively generating', () => {
      expect(classifySubmit('working… (esc to interrupt)', 'claude', 'hello')).toBe('submitted');
    });

    it('pending: the typed body is still verbatim on the input line', () => {
      expect(classifySubmit('❯ hello world stuck here', 'claude', 'hello world stuck here')).toBe('pending');
    });

    it('pending: a prefix of the body is shown (line-wrap truncation)', () => {
      // Wrapping can leave only a prefix on the marker row; that is still the body.
      expect(classifySubmit('❯ hello world st', 'claude', 'hello world stuck here')).toBe('pending');
    });

    it('pending: a folded paste placeholder still holds the body', () => {
      expect(classifySubmit('❯ [Pasted text +40 lines]', 'claude', LONG_MESSAGE)).toBe('pending');
    });

    it('replaced (flavor A): body /status autocompleted to /statusline', () => {
      // The completion string CONTAINS the body as a prefix; the old substring
      // check misread this as "still typed". It must now be a replacement.
      expect(classifySubmit('❯ /statusline', 'antigravity', '/status')).toBe('replaced');
    });

    it('replaced (flavor B): body /review autocompleted to an unrelated command', () => {
      expect(classifySubmit('❯ /teamwork-preview', 'antigravity', '/review')).toBe('replaced');
    });

    it('replaced: honors the input line above a status-bar footer', () => {
      const pane = '❯ /statusline\n? for shortcuts   model';
      expect(classifySubmit(pane, 'antigravity', '/status')).toBe('replaced');
    });

    it('submitted: gemini idle placeholder is NOT a replacement (regression guard)', () => {
      // gemini repaints "> Type your message or @path" on the empty composer
      // AFTER a successful submit. It must never be read as a replaced command,
      // even when the sent body was itself a slash command.
      const pane = '> Type your message or @path/to/file';
      expect(classifySubmit(pane, 'gemini', '/foo')).toBe('submitted');
    });

    it('submitted: non-command steady-state text on the input line', () => {
      // A hint / non-`/` text that is neither our body nor a slash command keeps
      // the pre-#1501 permissive default (submitted), so normal sends never fail.
      expect(classifySubmit('❯ some hint text', 'claude', '/foo')).toBe('submitted');
    });
  });

  // ---------------------------------------------------------------------------
  // Body/Enter separation — the core regression guard
  // ---------------------------------------------------------------------------
  describe('body/Enter separation (Issue #1469/#1470 regression guard)', () => {
    it('types the body without Enter, then submits Enter as a separate command', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(capturePane).mockResolvedValue(EMPTY_PROMPT);
        const order: string[] = [];
        vi.mocked(sendKeys).mockImplementation(async () => { order.push('sendKeys'); });
        vi.mocked(sendSpecialKeys).mockImplementation(async () => { order.push('sendSpecialKeys'); });

        const p = sendMessageWithSubmitVerification({ sessionName: SESSION, message: 'hello', cliToolId: 'claude' });
        await vi.runAllTimersAsync();
        await p;

        // body typed with sendEnter=false
        expect(sendKeys).toHaveBeenCalledWith(SESSION, 'hello', false);
        // Enter sent separately (never a batched body+C-m send-keys)
        expect(sendSpecialKeys).toHaveBeenCalledWith(SESSION, ['Enter']);
        expect(sendKeys).not.toHaveBeenCalledWith(SESSION, 'hello', true);
        expect(sendKeys).not.toHaveBeenCalledWith(SESSION, '', true);
        // order: body first, Enter after
        expect(order.indexOf('sendKeys')).toBeLessThan(order.indexOf('sendSpecialKeys'));
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Per-tool submit confirmation for single / multi / long messages
  // ---------------------------------------------------------------------------
  describe.each(INTERACTIVE_TOOLS)('submit confirmation for %s', (cliToolId) => {
    const cases: Array<[string, string]> = [
      ['single-line', 'hello'],
      ['multi-line', 'line1\nline2\nline3'],
      ['long (paste-length)', LONG_MESSAGE],
    ];

    it.each(cases)('confirms submit for a %s message', async (_label, message) => {
      vi.useFakeTimers();
      try {
        // Empty input line after submit => confirmed on the first read-back.
        vi.mocked(capturePane).mockResolvedValue(EMPTY_PROMPT);

        const submitEnterCount = cliToolId === 'vibe-local' ? 2 : 1;
        const p = sendMessageWithSubmitVerification({ sessionName: SESSION, message, cliToolId, submitEnterCount });
        await vi.runAllTimersAsync();
        await expect(p).resolves.toBeUndefined();

        // Read-back happened and cache was invalidated.
        expect(capturePane).toHaveBeenCalled();
        expect(invalidateCache).toHaveBeenCalledWith(SESSION);
        // No `\n` gate: the body is always typed via a non-Enter send-keys.
        expect(sendKeys).toHaveBeenCalledWith(SESSION, message, false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Recovery: typed-but-unsent -> resend Enter -> confirmed
  // ---------------------------------------------------------------------------
  describe('recovery of a typed-but-unsent message', () => {
    it('resends Enter when the message is still on the input line, then confirms', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(capturePane)
          .mockResolvedValueOnce('❯ hello world still here') // 1st read-back: NOT submitted
          .mockResolvedValue(EMPTY_PROMPT);                   // after resend: submitted

        const p = sendMessageWithSubmitVerification({
          sessionName: SESSION,
          message: 'hello world still here',
          cliToolId: 'claude',
        });
        await vi.runAllTimersAsync();
        await expect(p).resolves.toBeUndefined();

        // Initial Enter + one recovery Enter = 2 sendSpecialKeys(['Enter']) calls.
        const enterCalls = vi.mocked(sendSpecialKeys).mock.calls.filter(
          (c) => c[0] === SESSION && Array.isArray(c[1]) && c[1][0] === 'Enter'
        );
        expect(enterCalls.length).toBeGreaterThanOrEqual(2);
        expect(invalidateCache).toHaveBeenCalledWith(SESSION);
      } finally {
        vi.useRealTimers();
      }
    });

    it('recovers a folded paste placeholder and confirms once generating (version-resilient)', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(capturePane)
          .mockResolvedValueOnce('❯ [Pasted text +40 lines]') // NOT submitted (no #N, drift)
          .mockResolvedValue('thinking… (esc to interrupt)');  // generating => submitted

        const p = sendMessageWithSubmitVerification({ sessionName: SESSION, message: LONG_MESSAGE, cliToolId: 'claude' });
        await vi.runAllTimersAsync();
        await expect(p).resolves.toBeUndefined();

        expect(invalidateCache).toHaveBeenCalledWith(SESSION);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // No silent success: unconfirmable submit throws
  // ---------------------------------------------------------------------------
  describe('unconfirmable submit', () => {
    it('throws (never resolves) when the message stays on the input line', async () => {
      vi.useFakeTimers();
      try {
        // Always shows the message on the input line -> never submitted.
        vi.mocked(capturePane).mockResolvedValue('❯ stuck forever message');

        const p = sendMessageWithSubmitVerification({
          sessionName: SESSION,
          message: 'stuck forever message',
          cliToolId: 'claude',
          verifyAttempts: 3,
        });
        const assertion = expect(p).rejects.toThrow(/could not be confirmed/i);
        await vi.runAllTimersAsync();
        await assertion;

        // Bounded: initial Enter + one resend per failed attempt.
        const enterCalls = vi.mocked(sendSpecialKeys).mock.calls.filter(
          (c) => c[0] === SESSION && Array.isArray(c[1]) && c[1][0] === 'Enter'
        );
        expect(enterCalls.length).toBe(1 + 3);
        // Cache is still invalidated on the failure path.
        expect(invalidateCache).toHaveBeenCalledWith(SESSION);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // TUI popup replacement: clear input + throw, never resend Enter (Issue #1501)
  // ---------------------------------------------------------------------------
  describe('TUI autocompletion replacement', () => {
    it('flavor A: does NOT resend Enter and throws when /status becomes /statusline', async () => {
      vi.useFakeTimers();
      try {
        // agy replaced the typed /status with the highlighted /statusline.
        vi.mocked(capturePane).mockResolvedValue('❯ /statusline');

        const p = sendMessageWithSubmitVerification({
          sessionName: SESSION,
          message: '/status',
          cliToolId: 'antigravity',
          verifyAttempts: 4,
        });
        const assertion = expect(p).rejects.toThrow(/replaced by a TUI autocompletion/i);
        await vi.runAllTimersAsync();
        await assertion;

        // Only the INITIAL submit Enter fired — no recovery resend (which would
        // have executed /statusline).
        const enterCalls = vi.mocked(sendSpecialKeys).mock.calls.filter(
          (c) => c[0] === SESSION && Array.isArray(c[1]) && c[1][0] === 'Enter'
        );
        expect(enterCalls.length).toBe(1);
        // The residual command was cleared from the input line.
        expect(clearInputLine).toHaveBeenCalledWith(SESSION);
        expect(invalidateCache).toHaveBeenCalledWith(SESSION);
      } finally {
        vi.useRealTimers();
      }
    });

    it('flavor B: does NOT false-succeed when /review becomes /teamwork-preview', async () => {
      vi.useFakeTimers();
      try {
        // The replacement does not contain the body; the old code returned
        // "submitted" here (false success, residual left behind).
        vi.mocked(capturePane).mockResolvedValue('❯ /teamwork-preview');

        const p = sendMessageWithSubmitVerification({
          sessionName: SESSION,
          message: '/review',
          cliToolId: 'antigravity',
          verifyAttempts: 4,
        });
        const assertion = expect(p).rejects.toThrow(/replaced by a TUI autocompletion/i);
        await vi.runAllTimersAsync();
        await assertion;

        const enterCalls = vi.mocked(sendSpecialKeys).mock.calls.filter(
          (c) => c[0] === SESSION && Array.isArray(c[1]) && c[1][0] === 'Enter'
        );
        expect(enterCalls.length).toBe(1);
        expect(clearInputLine).toHaveBeenCalledWith(SESSION);
        expect(invalidateCache).toHaveBeenCalledWith(SESSION);
      } finally {
        vi.useRealTimers();
      }
    });

    it('still throws (surfaces failure) even if clearing the input line fails', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(capturePane).mockResolvedValue('❯ /statusline');
        vi.mocked(clearInputLine).mockRejectedValue(new Error('tmux gone'));

        const p = sendMessageWithSubmitVerification({
          sessionName: SESSION,
          message: '/status',
          cliToolId: 'antigravity',
        });
        const assertion = expect(p).rejects.toThrow(/replaced by a TUI autocompletion/i);
        await vi.runAllTimersAsync();
        await assertion;

        expect(clearInputLine).toHaveBeenCalledWith(SESSION);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Tool-specific semantics preserved
  // ---------------------------------------------------------------------------
  describe('tool-specific semantics', () => {
    it('sends Enter twice for vibe-local IME submit (submitEnterCount: 2)', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(capturePane).mockResolvedValue('ctx:9% ❯ '); // empty vibe-local prompt

        const p = sendMessageWithSubmitVerification({
          sessionName: SESSION,
          message: 'hello',
          cliToolId: 'vibe-local',
          submitEnterCount: 2,
          interEnterWaitMs: 5,
        });
        await vi.runAllTimersAsync();
        await p;

        // The initial submit alone issues two Enter presses (before any recovery).
        const enterCalls = vi.mocked(sendSpecialKeys).mock.calls.filter(
          (c) => c[0] === SESSION && Array.isArray(c[1]) && c[1][0] === 'Enter'
        );
        expect(enterCalls.length).toBeGreaterThanOrEqual(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
