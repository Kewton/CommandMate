/**
 * Issue #3205: a codex composer holding two or more lines read as `running`.
 *
 * The frame is the 2026-10-04 UAT pane (`tests/fixtures/codex-multiline-composer-3205/
 * tc104-raw-pane.txt`, codex 0.160.0): codex idle, a 6-line message typed but
 * unsent in its composer. `detectSessionStatus` answered `running /
 * thinking_indicator` from codex's branch 2.7 C — the last content row above
 * the status bar was the composer's LAST line, which is neither the `›` row
 * branch B reads as idle nor a working row, and C reads "neither" as running.
 *
 * What is pinned here:
 *   - the Issue's table: the composer as captured (6 lines), with the `(esc)` /
 *     `esc to cancel` / numbered rows removed, `› hello` alone, and `› hello` +
 *     `  world` — every one `ready / input_prompt` (the multi-line rows fail on
 *     the pre-#3205 detector);
 *   - the same on the ANSI-stripped frame (Auto-Yes's spelling), except the
 *     captured frame, whose composer quotes a numbered dialog (see TABLE);
 *   - the composer's extent in the live region (`composerEndRow`);
 *   - negative control: a WORKING frame whose composer holds a multi-line
 *     follow-up stays `running`.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectSessionStatus } from '@/lib/detection/status-detector';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { normalizeFrame } from '@/lib/detection/tools/frame';

const FIXTURES = path.resolve(__dirname, '../../../fixtures/codex-multiline-composer-3205');

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf-8');
}

const RAW = fixture('tc104-raw-pane.txt');
const RAW_LINES = RAW.split('\n');
/** Rows 1-38 of the capture: the conversation, up to the composer. */
const ABOVE_COMPOSER = RAW_LINES.slice(0, 38);
/** Rows 39-45 of the capture: the 6-line composer and the blank row under it. */
const COMPOSER_AS_CAPTURED = RAW_LINES.slice(38, 45);
/** Row 46 onwards: the status bar. */
const STATUS_BAR = RAW_LINES.slice(45);

/** The capture with its composer rows replaced (the Issue's "39 行目以降を差し替え"). */
function withComposer(rows: readonly string[]): string {
  return [...ABOVE_COMPOSER, ...rows, '', ...STATUS_BAR].join('\n');
}

function verdictOf(frame: string): string {
  const r = detectSessionStatus(frame, 'codex');
  return `${r.status}/${r.reason}${r.hasActivePrompt ? '/prompt' : ''}`;
}

/**
 * [label, frame, verdict after stripAnsi]. The captured composer quotes an
 * approval dialog (`› 1. Yes, proceed (y)` …) in its continuation rows; once
 * ANSI is stripped nothing tells that row from a live dialog's highlighted
 * option, so the stripped frame keeps the reading it had before #3205.
 */
const TABLE: ReadonlyArray<readonly [string, string, string]> = [
  ['as captured (6 lines)', RAW, 'waiting/prompt_detected/prompt'],
  [
    'without the (esc) row, the esc-to-cancel row and the numbered rows (2 lines)',
    withComposer(
      COMPOSER_AS_CAPTURED.filter(
        row => row.trim() !== '' && !/\(esc\)|esc to cancel|^\s*›?\s*\d+\.\s/.test(stripAnsi(row)),
      ),
    ),
    'ready/input_prompt',
  ],
  ['`› hello` (1 line)', withComposer(['\x1b[1m›\x1b[0m hello']), 'ready/input_prompt'],
  ['`› hello` + `  world` (2 lines)', withComposer(['\x1b[1m›\x1b[0m hello', '  world']), 'ready/input_prompt'],
];

describe('Issue #3205: an idle codex with a multi-line composer is ready', () => {
  it('the derived variant really keeps two composer rows', () => {
    const rows = stripAnsi(TABLE[1][1]).split('\n').slice(38, 40);
    expect(rows[0]).toMatch(/^› /);
    expect(rows[1]).toMatch(/^ {2}Would you like to run the following command\?$/);
  });

  for (const [label, frame, stripped] of TABLE) {
    it(`${label}: ready / input_prompt`, () => {
      expect(verdictOf(frame)).toBe('ready/input_prompt');
    });

    it(`${label}: ${stripped} after stripAnsi`, () => {
      expect(verdictOf(stripAnsi(frame))).toBe(stripped);
    });
  }

  it('a 6-line composer of plain lines is ready too', () => {
    const rows = ['\x1b[1m›\x1b[0m line one', '  line two', '  line three', '  line four', '  line five', '  line six'];
    expect(verdictOf(withComposer(rows))).toBe('ready/input_prompt');
  });

  it('the committed two-line fixture is ready', () => {
    expect(verdictOf(fixture('idle-composer-two-lines.txt'))).toBe('ready/input_prompt');
  });

  it("the live region's composer spans all of its rows", () => {
    const frame = normalizeFrame(RAW, 'codex');
    const region = frame.liveRegion;
    expect(region.anchor).toBe('composer');
    expect(region.composerAtBottom).toBe(true);
    expect(frame.contentLines[region.startRow]).toMatch(/^› ツールやシェルは使わずに/);
    expect(region.composerEndRow).toBe(region.startRow + 5);
    expect(frame.contentLines[region.composerEndRow ?? -1]).toMatch(/Press enter to confirm or esc to cancel/);
  });

  it('a one-line composer still ends on its own row', () => {
    const frame = normalizeFrame(withComposer(['\x1b[1m›\x1b[0m hello']), 'codex');
    expect(frame.liveRegion.composerEndRow).toBe(frame.liveRegion.startRow);
  });
});

describe('Issue #3205: negative control — codex working with a multi-line composer', () => {
  it('a working frame with a two-line follow-up in the composer stays running', () => {
    expect(verdictOf(fixture('running-composer-two-lines.txt'))).toBe('running/thinking_indicator');
    expect(verdictOf(stripAnsi(fixture('running-composer-two-lines.txt')))).toBe('running/thinking_indicator');
  });

  it('a working frame with a six-line follow-up in the composer stays running', () => {
    const lines = fixture('running-composer-two-lines.txt').split('\n');
    const at = lines.findIndex(l => l.includes('follow-up line two'));
    const frame = [
      ...lines.slice(0, at + 1),
      '  follow-up line three',
      '  follow-up line four',
      '  follow-up line five',
      '  follow-up line six',
      ...lines.slice(at + 1),
    ].join('\n');
    expect(verdictOf(frame)).toBe('running/thinking_indicator');
  });
});
