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
  // Issue #1880: the pre-send composer clear runs the REAL clearComposer
  // (#1879) against these mocks, so the `C-e`+`C-u` primitive it drives has to
  // be here. Mocking composer-clear instead would test the wiring and nothing
  // about the behaviour that matters.
  clearComposerLine: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

/** Stable across createLogger() calls so the #1880 audit log can be asserted. */
const loggerSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ ...loggerSpies, withContext: () => loggerSpies }),
}));

import {
  sendMessageWithSubmitVerification,
  isSubmitted,
  classifySubmit,
} from '@/lib/cli-tools/submit-verified-sender';
import { sendKeys, sendSpecialKeys, capturePane, clearInputLine, clearComposerLine } from '@/lib/tmux/tmux';
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

// ---------------------------------------------------------------------------
// Claude composer frames for the pre-send clear (Issue #1880).
//
// Same shape as the live #1879 fixtures, ANSI attributes intact: the extractor
// reads the RAW capture on purpose, because after stripAnsi a dim suggestion is
// byte-for-byte identical to text the user actually typed.
// ---------------------------------------------------------------------------
const SEP = '─'.repeat(40);
const ESC = '\u001b';

function claudeFrame(...composerRows: string[]): string {
  return ['⏺ a reply', SEP, ...composerRows, SEP, '  ⏵⏵ auto mode on'].join('\n');
}

/** Composer verifiably empty — also reads as "submitted" on the post-Enter check. */
const CLEAN_FRAME = claudeFrame(`${ESC}[39m❯ `);
/** One row of real residual (#1878 case 1). */
const RESIDUAL_FRAME = claudeFrame(`${ESC}[39m❯ echo PREFILLED`);
/** Residual that is itself a slash command (#1878 case 3 — the body-loss case). */
const SLASH_RESIDUAL_FRAME = claudeFrame(`${ESC}[39m❯ ${ESC}[38;5;153m/cost${ESC}[39m`);
/** Two rows of residual: one `C-e`+`C-u` pass cannot clear this. */
const TWO_ROW_RESIDUAL_FRAME = claudeFrame(`${ESC}[39m❯ RESIDLINE1`, '  RESIDLINE2');
/** Claude's dim ghost on an EMPTY composer — must not trigger any key send. */
const GHOST_FRAME = claudeFrame(`${ESC}[39m❯ ${ESC}[2mTry "how do I log an error?"${ESC}[0m`);
/** No input box on screen at all (full-screen dialog / pager / starting up). */
const NO_COMPOSER_FRAME = '⏺ a full-screen overlay with no composer at all';

/** A codex pane tail with the given composer rows (Issue #1890). */
function codexFrame(...composerRows: string[]): string {
  return ['• a reply', '', ...composerRows, '', '  gpt-5.6-sol xhigh · /repo'].join('\n');
}
/** codex's idle placeholder on an EMPTY composer — must not trigger any key send. */
const CODEX_PLACEHOLDER_FRAME = codexFrame(
  `${ESC}[1m\u203A${ESC}[0m ${ESC}[2mAsk Codex to do anything${ESC}[0m`,
);
/** Real residual in a codex composer — #1880's ケース7, the reason #1890 exists. */
const CODEX_RESIDUAL_FRAME = codexFrame(`${ESC}[1m\u203A${ESC}[0m echo PREFILLED`);
/** A codex approval dialog: the composer is off screen and its keys have consequences. */
const CODEX_DIALOG_FRAME = [
  '  Would you like to make the following edits?',
  '',
  `${ESC}[1m${ESC}[38;5;6m\u203A 1. Yes, proceed (y)${ESC}[0m`,
  "  2. Yes, and don't ask again for these files",
  '',
  '  Press enter to confirm or esc to cancel',
].join('\n');

describe('submit-verified-sender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendKeys).mockResolvedValue(undefined);
    vi.mocked(sendSpecialKeys).mockResolvedValue(undefined);
    vi.mocked(clearInputLine).mockResolvedValue(undefined);
    vi.mocked(clearComposerLine).mockResolvedValue(undefined);
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
          // Issue #1880: the first capture is now the pre-send composer read.
          // A bare prompt line carries no input box, so nothing is cleared.
          .mockResolvedValueOnce(EMPTY_PROMPT)
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
  // Pre-send composer clear (Issue #1880)
  //
  // `sendKeys` types at the TUI's current cursor position, so residual text was
  // spliced into the body and the send still reported success. These run the
  // REAL clearComposer/extractComposerText against the tmux mocks, so what is
  // pinned is the behaviour (which frames cause key sends, which cause a throw),
  // not the fact that a function is called.
  // ---------------------------------------------------------------------------
  describe('pre-send composer clear (Issue #1880)', () => {
    /** Index of a mock's Nth call in the global invocation order. */
    const callOrder = (mock: { mock: { invocationCallOrder: number[] } }, n = 0): number =>
      mock.mock.invocationCallOrder[n];

    it('empties the composer BEFORE typing, and types the body unchanged (#1878 case 1)', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(capturePane)
          .mockResolvedValueOnce(RESIDUAL_FRAME) // pre-send read: residual present
          .mockResolvedValue(CLEAN_FRAME);       // after one pass, and post-Enter

        const p = sendMessageWithSubmitVerification({
          sessionName: SESSION,
          message: 'ZZTOP1234 とだけ返答してください',
          cliToolId: 'claude',
        });
        await vi.runAllTimersAsync();
        await expect(p).resolves.toBeUndefined();

        // The clear used C-e+C-u (clearComposerLine), never the bare C-u of
        // clearInputLine: with the cursor at column 0 — #1878 case 4, which no
        // frame can distinguish from case 1 — C-u alone deletes nothing.
        expect(clearComposerLine).toHaveBeenCalledWith(SESSION);
        expect(clearInputLine).not.toHaveBeenCalled();
        // Body typed verbatim, and only after the box was emptied.
        expect(sendKeys).toHaveBeenCalledWith(SESSION, 'ZZTOP1234 とだけ返答してください', false);
        expect(callOrder(vi.mocked(clearComposerLine))).toBeLessThan(callOrder(vi.mocked(sendKeys)));
        // Nothing concatenated: the residual never appears in what was typed.
        for (const call of vi.mocked(sendKeys).mock.calls) {
          expect(String(call[1])).not.toContain('echo PREFILLED');
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps a slash-command body intact when residual precedes it (#1878 case 2)', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(capturePane)
          .mockResolvedValueOnce(RESIDUAL_FRAME)
          .mockResolvedValue(CLEAN_FRAME);

        const p = sendMessageWithSubmitVerification({
          sessionName: SESSION,
          message: '/cost',
          cliToolId: 'claude',
        });
        await vi.runAllTimersAsync();
        await expect(p).resolves.toBeUndefined();

        // Pre-#1880 this was typed into `echo PREFILLED` and executed as the
        // plain string `echo PREFILLED/cost` — the command silently demoted.
        expect(sendKeys).toHaveBeenCalledWith(SESSION, '/cost', false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears a slash-command residual, the case that silently ate the body (#1878 case 3)', async () => {
      vi.useFakeTimers();
      try {
        // `/cost` residual + body => `/costZZTOP…` => Unknown command => the
        // message never reached the model, and the send still reported success.
        vi.mocked(capturePane)
          .mockResolvedValueOnce(SLASH_RESIDUAL_FRAME)
          .mockResolvedValue(CLEAN_FRAME);

        const p = sendMessageWithSubmitVerification({
          sessionName: SESSION,
          message: 'ZZTOP5678 とだけ返答してください',
          cliToolId: 'claude',
        });
        await vi.runAllTimersAsync();
        await expect(p).resolves.toBeUndefined();

        // The `/cost` is colored (38;5;153), not dim: real residual, not a
        // ghost — the SGR argument `2` in `38;5;153` must not read as faint.
        expect(clearComposerLine).toHaveBeenCalledWith(SESSION);
        expect(sendKeys).toHaveBeenCalledWith(SESSION, 'ZZTOP5678 とだけ返答してください', false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps clearing a multi-row residual until the box reads back empty', async () => {
      vi.useFakeTimers();
      try {
        // #1878 measured 2N-1 passes for N rows: one C-u would leave row 1.
        vi.mocked(capturePane)
          .mockResolvedValueOnce(TWO_ROW_RESIDUAL_FRAME)
          .mockResolvedValueOnce(RESIDUAL_FRAME)
          .mockResolvedValueOnce(RESIDUAL_FRAME)
          .mockResolvedValue(CLEAN_FRAME);

        const p = sendMessageWithSubmitVerification({
          sessionName: SESSION,
          message: 'hello',
          cliToolId: 'claude',
        });
        await vi.runAllTimersAsync();
        await expect(p).resolves.toBeUndefined();

        expect(vi.mocked(clearComposerLine).mock.calls.length).toBe(3);
        expect(sendKeys).toHaveBeenCalledWith(SESSION, 'hello', false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('logs the discarded text, the only record of what the user lost', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(capturePane)
          .mockResolvedValueOnce(RESIDUAL_FRAME)
          .mockResolvedValue(CLEAN_FRAME);

        const p = sendMessageWithSubmitVerification({
          sessionName: SESSION,
          message: 'hello',
          cliToolId: 'claude',
        });
        await vi.runAllTimersAsync();
        await p;

        expect(loggerSpies.warn).toHaveBeenCalledWith(
          'pre-send-composer-cleared',
          expect.objectContaining({ sessionName: SESSION, discardedText: 'echo PREFILLED', passes: 1 })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('THROWS without typing anything when the composer cannot be emptied', async () => {
      vi.useFakeTimers();
      try {
        // A composer that never comes back empty. Typing here would splice the
        // body into it and then report success — the whole defect of #1880.
        vi.mocked(capturePane).mockResolvedValue(RESIDUAL_FRAME);

        const p = sendMessageWithSubmitVerification({
          sessionName: SESSION,
          message: 'hello',
          cliToolId: 'claude',
        });
        const assertion = expect(p).rejects.toThrow(/still holds unsent text/i);
        await vi.runAllTimersAsync();
        await assertion;

        expect(sendKeys).not.toHaveBeenCalled();
        expect(sendSpecialKeys).not.toHaveBeenCalled();
        expect(loggerSpies.error).toHaveBeenCalledWith(
          'pre-send-composer-clear-failed',
          expect.objectContaining({ remainingText: 'echo PREFILLED' })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('sends no keys for a dim ghost, which C-u could never remove anyway', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(capturePane)
          .mockResolvedValueOnce(GHOST_FRAME)
          .mockResolvedValue(CLEAN_FRAME);

        const p = sendMessageWithSubmitVerification({
          sessionName: SESSION,
          message: 'hello',
          cliToolId: 'claude',
        });
        await vi.runAllTimersAsync();
        await expect(p).resolves.toBeUndefined();

        expect(clearComposerLine).not.toHaveBeenCalled();
        expect(sendKeys).toHaveBeenCalledWith(SESSION, 'hello', false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('still sends when no input box is on screen (an overlay is not a dirty composer)', async () => {
      vi.useFakeTimers();
      try {
        // `no_composer` means nothing was inspected. Refusing here would invent
        // a second way for sends to stall, on a frame carrying no evidence.
        vi.mocked(capturePane)
          .mockResolvedValueOnce(NO_COMPOSER_FRAME)
          .mockResolvedValue(CLEAN_FRAME);

        const p = sendMessageWithSubmitVerification({
          sessionName: SESSION,
          message: 'hello',
          cliToolId: 'claude',
        });
        await vi.runAllTimersAsync();
        await expect(p).resolves.toBeUndefined();

        expect(clearComposerLine).not.toHaveBeenCalled();
        expect(sendKeys).toHaveBeenCalledWith(SESSION, 'hello', false);
      } finally {
        vi.useRealTimers();
      }
    });

    // -------------------------------------------------------------------------
    // codex joins the clear path (Issue #1890).
    //
    // #1880 shipped claude-only because `extractComposerText` could not read any
    // other input box; its live ケース7 (codex + residual) reproduced the splice
    // verbatim. These pin the three verdicts codex can now reach, through the
    // REAL clearComposer against the tmux mocks.
    // -------------------------------------------------------------------------
    describe('codex now takes part (Issue #1890)', () => {
      it('empties a codex composer BEFORE typing, and types the body unchanged', async () => {
        vi.useFakeTimers();
        try {
          vi.mocked(capturePane)
            .mockResolvedValueOnce(CODEX_RESIDUAL_FRAME)
            .mockResolvedValue(CODEX_PLACEHOLDER_FRAME);

          const p = sendMessageWithSubmitVerification({
            sessionName: SESSION,
            message: 'ZZTOP1234 とだけ返答してください',
            cliToolId: 'codex',
          });
          await vi.runAllTimersAsync();
          await expect(p).resolves.toBeUndefined();

          expect(clearComposerLine).toHaveBeenCalledWith(SESSION);
          expect(sendKeys).toHaveBeenCalledWith(SESSION, 'ZZTOP1234 とだけ返答してください', false);
          // The clear ran first: that ordering IS the fix.
          expect(callOrder(vi.mocked(clearComposerLine)))
            .toBeLessThan(callOrder(vi.mocked(sendKeys)));
        } finally {
          vi.useRealTimers();
        }
      });

      it('sends no clear keys at an idle codex composer showing its placeholder', async () => {
        vi.useFakeTimers();
        try {
          // The cost of getting this wrong is not a cosmetic bar: a pass here
          // fires on every idle send, spins to the cap against a buffer that was
          // empty all along, and then throws instead of sending.
          vi.mocked(capturePane)
            .mockResolvedValueOnce(CODEX_PLACEHOLDER_FRAME)
            .mockResolvedValue(EMPTY_PROMPT);

          const p = sendMessageWithSubmitVerification({
            sessionName: SESSION,
            message: 'hello',
            cliToolId: 'codex',
          });
          await vi.runAllTimersAsync();
          await expect(p).resolves.toBeUndefined();

          expect(clearComposerLine).not.toHaveBeenCalled();
          expect(sendKeys).toHaveBeenCalledWith(SESSION, 'hello', false);
        } finally {
          vi.useRealTimers();
        }
      });

      it('sends no clear keys at a codex dialog, and still sends the body', async () => {
        vi.useFakeTimers();
        try {
          vi.mocked(capturePane)
            .mockResolvedValueOnce(CODEX_DIALOG_FRAME)
            .mockResolvedValue(EMPTY_PROMPT);

          const p = sendMessageWithSubmitVerification({
            sessionName: SESSION,
            message: 'hello',
            cliToolId: 'codex',
          });
          await vi.runAllTimersAsync();
          await expect(p).resolves.toBeUndefined();

          expect(clearComposerLine).not.toHaveBeenCalled();
          expect(sendKeys).toHaveBeenCalledWith(SESSION, 'hello', false);
        } finally {
          vi.useRealTimers();
        }
      });

      it('refuses to type into a codex composer it could not empty', async () => {
        vi.useFakeTimers();
        try {
          vi.mocked(capturePane).mockResolvedValue(CODEX_RESIDUAL_FRAME);

          const p = sendMessageWithSubmitVerification({
            sessionName: SESSION,
            message: 'hello',
            cliToolId: 'codex',
          });
          const assertion = expect(p).rejects.toThrow(/still holds unsent text/i);
          await vi.runAllTimersAsync();
          await assertion;

          expect(sendKeys).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      });
    });

    // -------------------------------------------------------------------------
    // Non-regression for every CLI whose input box is still unmeasured.
    //
    // extractComposerText short-circuits them to `unsupported_tool`, so
    // clearComposer can never report success for them. Treating that as "the
    // clear failed" would take gemini/copilot/opencode/vibe-local/antigravity
    // offline while claude and codex kept working and these tests stayed green.
    // They must not enter the clear path AT ALL.
    // -------------------------------------------------------------------------
    describe.each(INTERACTIVE_TOOLS.filter((t) => t !== 'claude' && t !== 'codex'))(
      'unmeasured-CLI send path is byte-for-byte unchanged: %s',
      (cliToolId) => {
        it('reads nothing and sends no clear keys before typing the body', async () => {
          vi.useFakeTimers();
          try {
            // Deliberately a frame FULL of residual: if the tool gate were
            // removed, this is what the extractor would be asked about.
            vi.mocked(capturePane)
              .mockResolvedValueOnce(RESIDUAL_FRAME)
              .mockResolvedValue(EMPTY_PROMPT);

            const submitEnterCount = cliToolId === 'vibe-local' ? 2 : 1;
            const p = sendMessageWithSubmitVerification({
              sessionName: SESSION,
              message: 'hello',
              cliToolId,
              submitEnterCount,
            });
            await vi.runAllTimersAsync();
            await expect(p).resolves.toBeUndefined();

            expect(clearComposerLine).not.toHaveBeenCalled();
            expect(sendKeys).toHaveBeenCalledWith(SESSION, 'hello', false);
            // No pre-send read either: the first capture is the post-Enter
            // verification, so the send costs exactly what it cost before.
            expect(callOrder(vi.mocked(sendKeys))).toBeLessThan(callOrder(vi.mocked(capturePane)));
          } finally {
            vi.useRealTimers();
          }
        });
      }
    );
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
