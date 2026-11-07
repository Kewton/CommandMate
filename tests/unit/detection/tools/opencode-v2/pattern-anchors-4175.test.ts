/**
 * Issue #4175, items 3 and 4 for OpenCode V2: the response poller's chrome
 * boundary (3b), and the readers that matched the footer's and the placeholder's
 * words anywhere (4a, 4b). Item 3a (a V2 completion rule) is not taken; the block
 * named for it pins that no V2 frame completes.
 *
 * Positive controls are measured frames: `tests/fixtures/opencode-v2-live-4175/`
 * (2.0.18, 80 columns, 2026-11-06) and the earlier V2 sets. Negative controls put
 * a reply's row with the words into one of those frames, in memory; the rule the
 * code had before is written out beside each so the control is not vacuous.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import {
  endsWithTurnComplete,
  findOpencodeV2LastTranscriptRow,
  OPENCODE_V2_TURN_COMPLETE_PATTERN,
  opencodeV2StatusDetector,
} from '@/lib/detection/tools/opencode-v2/detect';
import {
  findOpencodeV2ChromeStart,
  isOpencodeV2ComposerVisible,
  isOpencodeV2FooterRowAt,
  OPENCODE_V2_FOOTER_PATTERN,
  OPENCODE_V2_FOOTER_ROW_PATTERN,
  OPENCODE_V2_SKIP_PATTERNS,
  OPENCODE_V2_THINKING_PATTERN,
} from '@/lib/detection/tools/opencode-v2/patterns';
import { findOpenCodeChromeStart } from '@/lib/detection/tools/opencode/patterns';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { resolveLivenessSpec } from '@/lib/cli-tools/liveness-spec';
import { judgeToolLiveness } from '@/lib/detection/tool-liveness';
import { extractResponse } from '@/lib/polling/response-checker';

const fixture = (rel: string): string => readFileSync(resolve(__dirname, '../../../../fixtures', rel), 'utf8');
const live = (name: string): string => fixture(`opencode-v2-live-4175/${name}.txt`);

const LONG_RUNNING = live('long-running');
const LONG_DONE = live('long-done');
const IDLE_AFTER_TURN = live('idle-after-turn');
const ESC_AGAIN = live('esc-again-running');
const INTERRUPTED = live('interrupted');
const QUOTE = live('quote-footer-done');
const LIVE_4175 = { LONG_RUNNING, LONG_DONE, IDLE_AFTER_TURN, ESC_AGAIN, INTERRUPTED, QUOTE };

const BOOT = fixture('opencode-v2-live-2934/boot-idle.txt');
const TURN_DONE = fixture('opencode-v2-live-2934/turn-done.txt');
const TURN_RUNNING = fixture('opencode-v2-live-2934/turn-running.txt');
const PERMISSION = fixture('opencode-v2-live-2945/permission-required.txt');
const AFTER_APPROVAL = fixture('opencode-v2-live-2945/turn-done-after-approval.txt');
const QUESTION_ANSWERED = fixture('opencode-v2-live-2945/question-answered.txt');
const WIDE = fixture('opencode-v2-usage-2981/pane-turn1-2.0.18.txt');
const TRANSCRIPT_ONLY = fixture('opencode-v2-agent-mode-3038/completion-row-only.txt');

/** The three rows the measured reply quoted (column 5), and its real footer. */
const QUOTED_ROWS = [
  '     ⬝⬝⬝⬝■■■■ esc again to interrupt',
  '     esc interrupt',
  '     Ask anything... ctrl+p commands',
] as const;
const QUOTE_FOOTER = '  …/i…/4159-4163/uat/run/root/sample:main  22.3K (2%) · $0.05  ctrl+p commands';

/** The rules the code had before Issue #4175, for the non-vacuity checks. */
const OLD_FOOTER = /ctrl\+p commands/;
const OLD_PLACEHOLDER_SKIP = /Ask anything(?:\.\.\.|…)/;

const rowsOf = (raw: string): string[] => stripAnsi(raw).split('\n');
const clean = (raw: string): string => stripAnsi(raw);
const rowCount = (raw: string): number => raw.split('\n').length;
const verdict = (raw: string) => opencodeV2StatusDetector.detect(normalizeFrame(raw, 'opencode-v2'));

/** extractResponse as the poller calls it on an alternate-screen pane: the cursor at the row count. */
const extract = (raw: string) => extractResponse(raw, rowCount(raw), 'opencode-v2');
/**
 * The partial reading of the whole pane (cursor 0): every transcript row above the
 * chrome, less the skip list. With no V2 completion rule (3a is not taken) this is
 * the only extraction a V2 frame gets, and the poller discards it (an unfinished
 * frame is not saved); it is read here as the reader 3b and 4a bound.
 */
const reply = (raw: string): string => stripAnsi(extractResponse(raw, 0, 'opencode-v2')?.response ?? '');

/** `raw` (ANSI stripped) with `rows` inserted after the first row equal to `after` (trimmed). */
function insertAfter(raw: string, after: string, rows: readonly string[]): string {
  const lines = rowsOf(raw);
  const at = lines.findIndex((row) => row.trim() === after);
  expect(at, `no row "${after}"`).toBeGreaterThanOrEqual(0);
  return [...lines.slice(0, at + 1), ...rows, ...lines.slice(at + 1)].join('\n');
}

/** The pre-#4175 completion-row reader: the footer's words made a row chrome. */
function oldEndsWithTurnComplete(raw: string): boolean {
  const lines = normalizeFrame(raw).contentLines;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/^[\s│┃╹▀]*$/.test(line)) continue;
    if (/^[^\S\n]*[│┃][^\S\n]*[A-Za-z][\w-]* · [^·\n]+$/.test(line)) continue;
    if (OLD_FOOTER.test(line)) continue;
    if (/^\s*\d+\.\d+\.\d+\s*$/.test(line)) continue;
    return OPENCODE_V2_TURN_COMPLETE_PATTERN.test(line);
  }
  return false;
}

describe('the measured frames (2.0.18, 80x200, 2026-11-06)', () => {
  it.each(Object.entries(LIVE_4175))('%s is a raw full-height capture with no user path in it', (_name, raw) => {
    expect(raw).toContain('\x1b[');
    expect(rowCount(raw)).toBeGreaterThanOrEqual(200);
    expect(raw).not.toMatch(/\/Users\/|\/home\/|maenokota|kewton/);
  });

  it.each([
    ...Object.entries(LIVE_4175),
    ['TURN_DONE', TURN_DONE],
    ['BOOT (footer mid-pane, version below it)', BOOT],
    ['WIDE (sidebar column after the footer)', WIDE],
  ])('%s: the footer is the row right under the composer border', (_name, raw) => {
    const rows = rowsOf(raw);
    const footer = rows.findIndex((row, i) => isOpencodeV2FooterRowAt(rows, i));
    expect(footer).toBeGreaterThan(0);
    expect(rows[footer - 1]).toMatch(/^\s*╹▀{4,}/);
    expect(rows.filter((_row, i) => isOpencodeV2FooterRowAt(rows, i))).toHaveLength(1);
  });

  it('the quoted rows sit at column 5, inside the reply, above the composer', () => {
    const rows = rowsOf(QUOTE);
    for (const quoted of QUOTED_ROWS) expect(rows).toContain(quoted);
    expect(rows).toContain(QUOTE_FOOTER);
  });
});

describe('3a is not taken here: the poller still never reads a V2 frame as finished', () => {
  // Issue #4175, item 3a was left out of this change: a completion rule here makes
  // the screen reading save V2 replies, and that save path is not ready for V2 (the
  // start of extraction is not read as on an alternate screen, the echo boundary
  // could stop on a row the reply quoted, and a long reply's scrolled-off head is
  // not carried into the save). Until it is designed, no frame completes, so the
  // screen reading saves nothing for V2 — what this pins.
  it.each([
    ...Object.entries(LIVE_4175),
    ['TURN_DONE', TURN_DONE],
    ['TURN_RUNNING', TURN_RUNNING],
    ['BOOT', BOOT],
    ['PERMISSION', PERMISSION],
    ['AFTER_APPROVAL', AFTER_APPROVAL],
    ['QUESTION_ANSWERED', QUESTION_ANSWERED],
    ['WIDE', WIDE],
  ])('%s: not complete, at either cursor', (_name, raw) => {
    expect(extract(raw)?.isComplete ?? false).toBe(false);
    expect(extractResponse(raw, 0, 'opencode-v2')?.isComplete ?? false).toBe(false);
  });

  it('the status detector still reads the finished frames as finished (that reader is unchanged)', () => {
    for (const raw of [LONG_DONE, INTERRUPTED, QUOTE, TURN_DONE]) {
      expect(endsWithTurnComplete(normalizeFrame(raw, 'opencode-v2'))).toBe(true);
    }
  });
});

describe('3b: the chrome is cut by position, so the column no longer decides', () => {
  it.each([
    ['LONG_DONE', LONG_DONE],
    ['QUOTE', QUOTE],
    ['PERMISSION (dialog gutter to the last row)', PERMISSION],
    ['WIDE', WIDE],
  ])('%s: findOpencodeV2ChromeStart is V1’s structural boundary', (_name, raw) => {
    const rows = rowsOf(raw);
    const start = findOpencodeV2ChromeStart(rows);
    expect(start).toBeGreaterThan(0);
    expect(start).toBe(findOpenCodeChromeStart(rows));
    expect(rows[start]).toMatch(/^\s*┃/);
  });

  it('the measured reply keeps the three rows it quoted, and loses the real footer', () => {
    const text = reply(QUOTE);
    for (const quoted of QUOTED_ROWS) expect(text).toContain(quoted.trim());
    expect(text).not.toContain('22.3K (2%)');
    // Before: the placeholder words dropped the third row from the reply.
    expect(OLD_PLACEHOLDER_SKIP.test(QUOTED_ROWS[2])).toBe(true);
  });

  it('a quoted footer row drawn left of column 5 stays in the reply (the column rule dropped it)', () => {
    const row = '  /…/repo:main  8.6K (1%)  ctrl+p commands';
    expect(OPENCODE_V2_FOOTER_ROW_PATTERN.test(row)).toBe(true);
    const frame = insertAfter(TURN_DONE, 'OK', [row]);
    const text = reply(frame);
    expect(text).toContain(row.trim());
    expect(text).not.toContain('repo:master');
  });

  it('a footer drawn right of column 4 stays out of the reply (the column rule let it in)', () => {
    const rows = rowsOf(LONG_DONE);
    const footer = rows.findIndex((row, i) => isOpencodeV2FooterRowAt(rows, i));
    const moved = `      ${rows[footer].trim()}`;
    expect(OPENCODE_V2_FOOTER_ROW_PATTERN.test(moved)).toBe(false);
    rows[footer] = moved;
    const text = reply(rows.join('\n'));
    expect(text).toContain('REPOSTAMP');
    expect(text).not.toContain('ctrl+p commands');
  });

  it('a reply being written is read without the composer, its hint or the footer', () => {
    const text = reply(LONG_RUNNING);
    // From the reply's head down: the echoes above it are transcript and stay.
    const head = text.indexOf('The History of the Bicycle');
    expect(head).toBeGreaterThan(0);
    const tail = text.slice(head);
    expect(tail).not.toContain('┃');
    expect(tail).not.toContain('esc interrupt');
    expect(tail).not.toContain('ctrl+p commands');
  });

  it('with no composer on the frame, the footer is cut only as the last row', () => {
    const lines = rowsOf(TRANSCRIPT_ONLY);
    const footer = '  /…/tmp/probe/repo:master  6.3K (1%)  ctrl+p commands';
    expect(findOpencodeV2ChromeStart([...lines, footer])).toBe(lines.length);
    expect(findOpencodeV2ChromeStart([...lines.slice(0, 3), footer, ...lines.slice(3)])).toBe(-1);
  });
});

describe('4a: the reply skip list matches the placeholder row only', () => {
  it('the measured placeholder row (gutter, `Ask anything…`) is skipped', () => {
    const row = rowsOf(BOOT).find((r) => r.includes('Ask anything'));
    expect(row).toBeDefined();
    expect(OPENCODE_V2_SKIP_PATTERNS.some((p) => p.test(row as string))).toBe(true);
  });

  it.each([
    ['the measured quote', QUOTED_ROWS[2]],
    ['a sentence', '     You can Ask anything... here, the footer says.'],
    ['alone on the row', '     Ask anything…'],
  ])('a reply row with the words (%s) is not skipped', (_name, row) => {
    expect(OLD_PLACEHOLDER_SKIP.test(row)).toBe(true);
    expect(OPENCODE_V2_SKIP_PATTERNS.some((p) => p.test(row))).toBe(false);
    expect(reply(insertAfter(TURN_DONE, 'OK', [row]))).toContain(row.trim());
  });
});

describe('4b: the footer is read by position in every reader', () => {
  describe('chrome (the completion row reader)', () => {
    it.each([
      ['LONG_DONE', LONG_DONE],
      ['INTERRUPTED', INTERRUPTED],
      ['QUOTE', QUOTE],
      ['IDLE_AFTER_TURN', IDLE_AFTER_TURN],
    ])('%s: the last transcript row is the completion row', (_name, raw) => {
      const frame = normalizeFrame(raw, 'opencode-v2');
      expect(endsWithTurnComplete(frame)).toBe(true);
      const last = findOpencodeV2LastTranscriptRow(frame.contentLines);
      expect(OPENCODE_V2_TURN_COMPLETE_PATTERN.test(frame.contentLines[last])).toBe(true);
    });

    it('a reply row quoting the footer under the interrupted row is the last row, not chrome', () => {
      const frame = insertAfter(INTERRUPTED, 'Build · Claude Sonnet 5.5 · 8.5s · interrupted', [QUOTED_ROWS[2]]);
      expect(oldEndsWithTurnComplete(frame)).toBe(true);
      expect(endsWithTurnComplete(normalizeFrame(frame, 'opencode-v2'))).toBe(false);
    });
  });

  describe('input box (isOpencodeV2ComposerVisible)', () => {
    it.each([
      ['BOOT', BOOT],
      ['TURN_DONE', TURN_DONE],
      ['WIDE', WIDE],
      ...Object.entries(LIVE_4175),
    ])('%s: visible', (_name, raw) => {
      expect(isOpencodeV2ComposerVisible(clean(raw))).toBe(true);
    });

    it('the approval dialog with a reply above it quoting the footer: no composer', () => {
      const text = insertAfter(PERMISSION, '+ Thought · 1.5s', [...QUOTED_ROWS, QUOTE_FOOTER]);
      expect(OLD_FOOTER.test(text)).toBe(true);
      expect(isOpencodeV2ComposerVisible(text)).toBe(false);
      expect(isOpencodeV2ComposerVisible(clean(PERMISSION))).toBe(false);
    });
  });

  describe('ready (the status detector)', () => {
    it.each([
      ['LONG_DONE', LONG_DONE, STATUS_REASON.OPENCODE_RESPONSE_COMPLETE],
      ['QUOTE', QUOTE, STATUS_REASON.OPENCODE_RESPONSE_COMPLETE],
      ['INTERRUPTED', INTERRUPTED, STATUS_REASON.OPENCODE_RESPONSE_COMPLETE],
      ['BOOT', BOOT, STATUS_REASON.INPUT_PROMPT],
    ])('%s: ready (%s)', (_name, raw, reason) => {
      expect(verdict(raw).status).toBe('ready');
      expect(verdict(raw).reason).toBe(reason);
    });

    it('the footer pattern reads the measured footer in the status window', () => {
      expect(OPENCODE_V2_FOOTER_PATTERN.test(normalizeFrame(LONG_DONE, 'opencode-v2').lastLines)).toBe(true);
    });

    it('a frame with no footer whose last row quotes it is not ready', () => {
      const text = `${clean(TRANSCRIPT_ONLY).trimEnd()}\n${QUOTED_ROWS[2]}\n`;
      expect(OLD_FOOTER.test(normalizeFrame(text).lastLines)).toBe(true);
      expect(verdict(text).status).not.toBe('ready');
    });
  });

  describe('liveness (the footer as proof the TUI is up)', () => {
    const spec = resolveLivenessSpec('opencode-v2');

    it.each([['BOOT', BOOT], ['LONG_DONE', LONG_DONE], ['ESC_AGAIN', ESC_AGAIN]])('%s: alive', (_name, raw) => {
      expect(judgeToolLiveness(raw, spec).alive).toBe(true);
    });

    it('a shell that printed the words is not the TUI', () => {
      const shell = 'dev@host repo % echo "ctrl+p commands"\nctrl+p commands\ndev@host repo % ';
      expect(OLD_FOOTER.test(shell)).toBe(true);
      expect(judgeToolLiveness(shell, spec).alive).toBe(false);
    });
  });

  describe('running (the hint, read on the real 80-column footer)', () => {
    it.each([
      ['LONG_RUNNING', LONG_RUNNING],
      ['ESC_AGAIN', ESC_AGAIN],
    ])('%s: running on the hint', (_name, raw) => {
      expect(OPENCODE_V2_THINKING_PATTERN.test(normalizeFrame(raw, 'opencode-v2').lastLines)).toBe(true);
      expect(verdict(raw).status).toBe('running');
      expect(verdict(raw).reason).toBe(STATUS_REASON.THINKING_INDICATOR);
    });

    it('the finished reply that quotes the hint rows is not running', () => {
      expect(OPENCODE_V2_THINKING_PATTERN.test(normalizeFrame(QUOTE, 'opencode-v2').lastLines)).toBe(false);
      expect(verdict(QUOTE).status).toBe('ready');
    });
  });
});
