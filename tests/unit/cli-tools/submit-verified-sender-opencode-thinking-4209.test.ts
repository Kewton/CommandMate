/**
 * Issue #4209 (the second contract, review P2): the opencode submit read-back's
 * "generating" rule (rule A of `classifySubmitWithRule`) reads `Thinking:` by the
 * position rules the status detector and the poller's save read since #4209
 * (`isOpenCodeThinkingBelowComposer`, `isOpenCodeThinkingInOpenTurn`), not as the
 * word anywhere in the 12-row tail window.
 *
 * Before the fix, rule A was `detectThinking('opencode', window)` — `/Thinking:/`
 * anywhere in the window — and the window holds the footer's cwd. A cwd of
 * `/tmp/Thinking:demo` made a body still sitting unsent in the composer read as
 * `submitted`, so the sender never pressed Enter again and reported a send that
 * did not happen.
 *
 * Path: `OpenCodeTool.sendMessage` → `sendMessageWithSubmitVerification` →
 * `classifySubmitWithRule`.
 *
 * Every frame is a measured capture (`tests/unit/lib/detection/fixtures/opencode-live-*`),
 * edited in memory only; the old rule is written out beside each case so the
 * control is not vacuous.
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

import { classifySubmitWithRule, sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { VERIFY_WINDOW_LINES } from '@/lib/cli-tools/submit-composer-read';
import { capturePane, sendSpecialKeys } from '@/lib/tmux/tmux';
import { detectThinking, stripAnsi } from '@/lib/detection/cli-patterns';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { STATUS_REASON } from '@/lib/detection/status-reason';

const FIXTURES = join(process.cwd(), 'tests/unit/lib/detection/fixtures');
const frame = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8');

/** Composer holds `echo PREFILLED` — a single-line body typed but not sent (#1883). */
const RESIDUAL = frame('opencode-live-1883/composer-residual.txt');
/** Composer holds a three-line body typed but not sent (#1906). */
const MULTILINE_PENDING = frame('opencode-live-1906/composer-multiline-pending.txt');
const MULTILINE_BODY = 'Review the send path.\nCheck newline handling.\nReport findings.';
/** A running turn: `⠦ Thinking: Preparing an essay` under the newest echo (#1894). */
const ESC_AGAIN_AFTER_MARKER = frame('opencode-live-1894/esc-again-after-marker.txt');

/** Rule A before #4209's second contract: the word in the tail window. */
function oldRuleA(output: string): boolean {
  const lines = stripAnsi(output).split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return detectThinking('opencode', lines.slice(0, end).slice(-VERIFY_WINDOW_LINES).join('\n'));
}

/** The index of the composer's bottom border, from the bottom. */
function borderOf(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^[^\S\n]*╹▀{4,}/.test(lines[i])) return i;
  }
  return -1;
}

/**
 * `raw` with the leading path of the `nth` row of the footer's cwd replaced by
 * `path`. The cwd is the last block of non-empty rows (wrapped over three rows on
 * these 80-column frames), under the composer's bottom border.
 */
function withCwdRow(raw: string, nth: number, path: string): string {
  const lines = stripAnsi(raw).split('\n');
  const border = borderOf(lines);
  expect(border).toBeGreaterThan(0);
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  let start = end;
  while (start > border + 1 && lines[start - 1].trim() !== '') start--;
  const at = start + nth;
  expect(at).toBeLessThan(end);
  expect(lines[at]).toMatch(/^\s*\S/);
  lines[at] = lines[at].replace(/^(\s*)\S+/, `$1${path}`);
  return lines.join('\n');
}

const CWDS: Array<[string, number, string]> = [
  ['a cwd of /tmp/Thinking:demo', 0, '/tmp/Thinking:demo'],
  ['a wrapped cwd row opening with Thinking:', 1, 'Thinking:demo/repo'],
];

const PENDING: Array<[string, string, string]> = [
  ['opencode-live-1883/composer-residual', RESIDUAL, 'echo PREFILLED'],
  ['opencode-live-1906/composer-multiline-pending', MULTILINE_PENDING, MULTILINE_BODY],
];

const CASES = PENDING.flatMap(([name, raw, body]) =>
  CWDS.map(([cwd, nth, path]) => [`${name}, ${cwd}`, withCwdRow(raw, nth, path), body, raw] as const));

describe('opencode submit read-back reads Thinking: by position (#4209)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('positive control: the footer cwd does not make an unsent body `submitted`', () => {
    it.each(CASES)('%s: pending (rule D), the old rule A read submitted', (_name, output, body) => {
      // The old rule read the cwd row as a generating turn.
      expect(oldRuleA(output)).toBe(true);

      expect(classifySubmitWithRule(output, 'opencode', body)).toEqual({ state: 'pending', rule: 'D' });
    });

    it('agrees with the status detector: the cwd changes neither verdict', () => {
      for (const [name, output, , raw] of CASES) {
        const edited = detectSessionStatus(output, 'opencode');
        const measured = detectSessionStatus(raw, 'opencode');
        expect(edited.reason, name).not.toBe(STATUS_REASON.THINKING_INDICATOR);
        expect([edited.status, edited.reason], name).toEqual([measured.status, measured.reason]);
      }
    });

    it('presses Enter again rather than reporting a send that did not happen', async () => {
      const [, output, body] = CASES[0];
      vi.mocked(capturePane).mockResolvedValue(output);
      vi.useFakeTimers();
      try {
        const p = sendMessageWithSubmitVerification({
          sessionName: 'mcbd-opencode-wt',
          message: body,
          cliToolId: 'opencode',
        });
        const settled = p.then(
          () => 'resolved',
          () => 'rejected'
        );
        await vi.runAllTimersAsync();
        // The body never leaves the box on this frame, so the send fails loudly.
        expect(await settled).toBe('rejected');
        const enters = vi.mocked(sendSpecialKeys).mock.calls.filter((c) => c[1].includes('Enter'));
        expect(enters.length).toBeGreaterThan(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('negative control: a real running turn is still `submitted` by rule A', () => {
    it('opencode-live-1894/esc-again-after-marker: the spinner Thinking: row in the open turn', () => {
      expect(oldRuleA(ESC_AGAIN_AFTER_MARKER)).toBe(true);
      expect(classifySubmitWithRule(ESC_AGAIN_AFTER_MARKER, 'opencode', 'anything')).toEqual({
        state: 'submitted',
        rule: 'A',
      });
      // The status detector reads the same frame as running.
      expect(detectSessionStatus(ESC_AGAIN_AFTER_MARKER, 'opencode').status).toBe('running');
    });

    it('the spinner progress row under the composer border is read, as the status detector reads it', () => {
      // The centred first-send box (#1906) puts the border far above the 12-row
      // tail, so the old rule never saw this row; the position rule reads the
      // frame whole, like the status detector's thinking step.
      const lines = stripAnsi(RESIDUAL).split('\n');
      const border = borderOf(lines);
      const withProgress = [
        ...lines.slice(0, border + 1),
        '     ⠦ Thinking: Crafting a reply',
        ...lines.slice(border + 1),
      ].join('\n');
      expect(classifySubmitWithRule(withProgress, 'opencode', 'echo PREFILLED')).toEqual({
        state: 'submitted',
        rule: 'A',
      });
      const verdict = detectSessionStatus(withProgress, 'opencode');
      expect([verdict.status, verdict.reason]).toEqual(['running', STATUS_REASON.THINKING_INDICATOR]);
    });

    it('the unsent body without a Thinking: cwd stays pending (rule D)', () => {
      expect(classifySubmitWithRule(RESIDUAL, 'opencode', 'echo PREFILLED')).toEqual({ state: 'pending', rule: 'D' });
    });

    it('does not change other tools: a Thinking: word in claude`s window is still rule A', () => {
      // claude's thinking pattern is its own; only opencode reads by position.
      const text = ['some output', '✻ Thinking… (esc to interrupt)', '❯ '].join('\n');
      expect(detectThinking('claude', text)).toBe(true);
      expect(classifySubmitWithRule(text, 'claude', 'hello').rule).toBe('A');
    });
  });
});
