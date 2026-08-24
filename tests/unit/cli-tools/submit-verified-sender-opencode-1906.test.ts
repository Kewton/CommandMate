/**
 * opencode submit verification (Issue #1906, item 2).
 *
 * `classifySubmit` decided "did the message leave the composer?" by looking for
 * a prompt marker — `>` / `❯` / `›` — in the last twelve rows of the pane.
 * opencode draws none. Its composer is a box with a `┃` gutter, so the reader
 * never found an input line and every opencode send took the "no input line =>
 * submitted" branch. Two consequences, both measured here against live frames:
 *
 * 1. #1471's recovery — "the TUI swallowed the Enter, resend it" — and its
 *    "throw rather than report a false success" have never once run on opencode.
 *    A body sitting unsent in the composer was reported as sent.
 * 2. The window was wrong as well as the reader. Before its first answered turn
 *    opencode centres the whole box under its banner (row ~100 of a 200-row
 *    pane), so a 12-row tail read of a first send contains blank padding and the
 *    cwd footer and nothing else.
 *
 * Every frame below is a real `capture-pane -e` of opencode 1.18.20/1.18.21 at
 * the production 80x200 geometry, ANSI and box drawing intact. The reader is
 * anchored on the box drawing, so a normalised fixture would let the old
 * marker-only reader pass this whole file.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
  clearInputLine: vi.fn().mockResolvedValue(undefined),
  clearComposerLine: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const spies = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { ...spies, withContext: () => spies };
  },
}));

import {
  classifySubmit,
  sendMessageWithSubmitVerification,
} from '@/lib/cli-tools/submit-verified-sender';
import { capturePane, sendSpecialKeys } from '@/lib/tmux/tmux';
import { OPENCODE_PANE_HEIGHT } from '@/config/tmux-pane-config';
import { stripAnsi } from '@/lib/detection/cli-patterns';

const FIXTURES = join(process.cwd(), 'tests/unit/lib/detection/fixtures');

function frame(dir: string, name: string): string {
  return readFileSync(join(FIXTURES, dir, name), 'utf-8');
}

/** Composer holds `echo PREFILLED` — a single-line body typed but not sent (#1883). */
const RESIDUAL = frame('opencode-live-1883', 'composer-residual.txt');
/** Composer holds a three-line body typed but not sent (#1906). */
const MULTILINE_PENDING = frame('opencode-live-1906', 'composer-multiline-pending.txt');
/** Boot screen: the box holds opencode's `Ask anything...` placeholder, i.e. empty. */
const BOOT_IDLE = frame('opencode-live-1883', 'boot-idle.txt');
/** A finished turn: the box is on screen, bottom-anchored, and empty. */
const TURN_COMPLETE = frame('opencode-live-1883', 'turn-complete.txt');
/** Mid-generation: `esc interrupt` in the footer. */
const TURN_RUNNING = frame('opencode-live-1883', 'turn-running.txt');
/** `Ask anything...` printed inside a REPLY, un-guttered, plus a guttered echo. */
const PHRASE_IN_RESPONSE = frame('opencode-live-1883', 'phrase-in-response.txt');
/** The permission dialog: it replaces the composer and draws no bottom border. */
const PERMISSION = frame('opencode-live-1893', 'permission-bash.txt');

describe('opencode submit verification (#1906)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // The fixtures are still raw. Every verdict below is anchored on this.
  // -------------------------------------------------------------------------
  it('keeps the box drawing and ANSI in the fixtures', () => {
    for (const [name, text] of [
      ['composer-residual', RESIDUAL],
      ['composer-multiline-pending', MULTILINE_PENDING],
      ['boot-idle', BOOT_IDLE],
      ['turn-complete', TURN_COMPLETE],
    ] as const) {
      expect(text, `${name} lost its gutter`).toContain('┃');
      expect(text, `${name} lost its composer bottom border`).toContain('╹');
      expect(text, `${name} lost its ANSI`).toContain('[');
    }
    // The whole point: not one of these frames carries a prompt marker anywhere
    // near the composer, which is why the marker reader could never see it.
    expect(RESIDUAL).not.toMatch(/^\s*[>❯›]/m);
  });

  // -------------------------------------------------------------------------
  // The defect: a body still in the composer used to read as `submitted`.
  // -------------------------------------------------------------------------
  describe('a body still in the composer is `pending`', () => {
    it('reads a single-line residual body as pending', () => {
      expect(classifySubmit(RESIDUAL, 'opencode', 'echo PREFILLED')).toBe('pending');
    });

    it('reads a multi-line body as pending from its first row', () => {
      // opencode wraps the message one row per line inside the box; the reader
      // takes the first non-blank row, which is the body's first line.
      const body = 'Review the send path.\nCheck newline handling.\nReport findings.';
      expect(classifySubmit(MULTILINE_PENDING, 'opencode', body)).toBe('pending');
    });

    it('reads a body whose composer row is a visual truncation as pending', () => {
      // Line wrapping can leave a PREFIX of the first line on the row; that is
      // still our unsent body, not a substitution.
      expect(classifySubmit(RESIDUAL, 'opencode', 'echo PREFILLED --with-a-much-longer-tail')).toBe(
        'pending'
      );
    });
  });

  describe('an empty or absent composer is `submitted`', () => {
    it('treats the `Ask anything...` placeholder as an empty buffer', () => {
      // #1883: opencode paints the placeholder ONLY while the buffer is empty,
      // and paints it inside the box. So it is positive evidence of "empty",
      // not a row of text that happens to differ from the body.
      expect(classifySubmit(BOOT_IDLE, 'opencode', 'anything')).toBe('submitted');
    });

    it('does not let the placeholder be mistaken for the body still being there', () => {
      // Where "empty" and "text that is not the body" stop agreeing. The
      // placeholder is CHROME, and reading it as buffer content makes it eligible
      // for the prefix test in `inputMatchesBody` — so a message that happens to
      // open with it scores `pending` on an empty composer, and the sender then
      // presses Enter on a session it has no reason to press Enter on.
      const body = 'Ask anything... "Fix broken tests" — and then explain why';
      expect(classifySubmit(BOOT_IDLE, 'opencode', body)).toBe('submitted');
    });

    it('treats a bottom-anchored empty box after a finished turn as submitted', () => {
      expect(classifySubmit(TURN_COMPLETE, 'opencode', 'Reply with exactly: ok')).toBe('submitted');
    });

    it('treats a running turn as submitted (the footer carries `esc interrupt`)', () => {
      expect(classifySubmit(TURN_RUNNING, 'opencode', 'Reply with exactly: ok')).toBe('submitted');
    });

    it('treats the permission dialog as submitted — it replaced the composer', () => {
      // The dialog is up because the message WAS submitted and the agent asked
      // for permission. It draws no bottom border, so no composer is readable,
      // and #1893's own detector is what decides the session is waiting.
      expect(classifySubmit(PERMISSION, 'opencode', 'ls -la')).toBe('submitted');
    });
  });

  // -------------------------------------------------------------------------
  // The `Build · <model>` row is what makes a naive gutter read wrong.
  // -------------------------------------------------------------------------
  it('does not mistake the agent/model row for a typed body', () => {
    // `┃  Build · GPT-5.6 Luna GitHub Copilot` is a guttered row carrying text on
    // EVERY frame, empty composer included. Reading "any guttered row with text"
    // would make the composer never look empty — and, with the body absent from
    // it, would score a clean send as `submitted` for the wrong reason on frames
    // where it should be `pending`. It is excluded structurally: last gutter row
    // before the border.
    expect(stripAnsi(TURN_COMPLETE)).toContain('Build · GPT-5.6 Luna');
    expect(classifySubmit(TURN_COMPLETE, 'opencode', 'Build · GPT-5.6 Luna GitHub Copilot')).toBe(
      'submitted'
    );
  });

  it('reads the composer, not a `>` quote somewhere else on the pane', () => {
    // `phrase-in-response.txt` is the #1883 frame where opencode printed a
    // phrase into its reply body. Same principle, and the reason the marker is
    // now scoped to the tools that actually draw one: what a reply CONTAINS must
    // never be read as the state of the input box.
    const quoted = PHRASE_IN_RESPONSE.replace(
      'Output exactly this one line',
      '> Output exactly this one line'
    );
    expect(classifySubmit(quoted, 'opencode', 'anything at all')).toBe('submitted');
  });

  it('still reports a TUI substitution as `replaced`', () => {
    // Synthetic: the body row of a real frame, rewritten to a different slash
    // command. Resending Enter here would EXECUTE it (#1501 flavor A).
    const substituted = MULTILINE_PENDING.replace('Review the send path.', '/statusline');
    expect(classifySubmit(substituted, 'opencode', '/status')).toBe('replaced');
  });

  // -------------------------------------------------------------------------
  // The window: the composer has to be inside what was captured.
  // -------------------------------------------------------------------------
  describe('read-back window', () => {
    it('captures the whole opencode pane, not a 12-row tail', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(capturePane).mockResolvedValue(TURN_COMPLETE);
        const p = sendMessageWithSubmitVerification({
          sessionName: 'mcbd-opencode-wt',
          message: 'hello',
          cliToolId: 'opencode',
        });
        await vi.runAllTimersAsync();
        await expect(p).resolves.toBeUndefined();

        expect(capturePane).toHaveBeenCalledWith('mcbd-opencode-wt', {
          startLine: -OPENCODE_PANE_HEIGHT,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('would see no composer at all in a 12-row tail of a first send', () => {
      // The measurement behind the window. Before its first answered turn
      // opencode centres the box at row ~100 of 200, so the tail the marker
      // tools use holds blank padding and the wrapped cwd footer — and a body
      // sitting unsent in the composer scores `submitted` from it.
      const tail = MULTILINE_PENDING.split('\n').slice(-12).join('\n');
      expect(tail).not.toContain('┃');
      expect(tail).not.toContain('╹');
      expect(classifySubmit(tail, 'opencode', 'Review the send path.')).toBe('submitted');
      // The same frame, read whole, is the truth.
      expect(classifySubmit(MULTILINE_PENDING, 'opencode', 'Review the send path.')).toBe('pending');
    });

    it('leaves the marker tools on the 12-row tail', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(capturePane).mockResolvedValue('❯ ');
        const p = sendMessageWithSubmitVerification({
          sessionName: 'mcbd-claude-wt',
          message: 'hello',
          cliToolId: 'claude',
        });
        await vi.runAllTimersAsync();
        await expect(p).resolves.toBeUndefined();

        // #1880's pre-send composer read uses the legacy numeric signature; the
        // submit read-back is the one that passes an options object.
        const verifyReads = vi
          .mocked(capturePane)
          .mock.calls.filter((c) => typeof c[1] === 'object');
        expect(verifyReads.length).toBeGreaterThan(0);
        for (const call of verifyReads) {
          expect(call[1]).toEqual({ startLine: -12 });
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // End to end: the recovery that had never run on opencode now runs.
  // -------------------------------------------------------------------------
  describe('#1471 recovery reaches opencode', () => {
    it('resends Enter while the body is still in the composer, then confirms', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(capturePane)
          .mockResolvedValueOnce(RESIDUAL) // 1st read-back: still typed
          .mockResolvedValue(TURN_COMPLETE); // after the resend: box empty

        const p = sendMessageWithSubmitVerification({
          sessionName: 'mcbd-opencode-wt',
          message: 'echo PREFILLED',
          cliToolId: 'opencode',
        });
        await vi.runAllTimersAsync();
        await expect(p).resolves.toBeUndefined();

        const enters = vi
          .mocked(sendSpecialKeys)
          .mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'Enter');
        expect(enters.length).toBe(2); // initial submit + one recovery
      } finally {
        vi.useRealTimers();
      }
    });

    it('throws instead of reporting success when the body never leaves the composer', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(capturePane).mockResolvedValue(RESIDUAL);

        const p = sendMessageWithSubmitVerification({
          sessionName: 'mcbd-opencode-wt',
          message: 'echo PREFILLED',
          cliToolId: 'opencode',
          verifyAttempts: 3,
        });
        const assertion = expect(p).rejects.toThrow(/could not be confirmed/i);
        await vi.runAllTimersAsync();
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
