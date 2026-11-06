/**
 * Issue #4175, item 4c: V1's busy footer (`esc interrupt` / `esc again to
 * interrupt`) was matched as words anywhere, so a reply saying them read as a
 * running turn. Now a whole row (the hint opens it, after the spinner run) and, in
 * the status reader, a row under the composer's border.
 *
 * Positive controls are measured frames (opencode 1.18.x: `opencode-live-1894/`,
 * `opencode-live-2047/`, the canary capture). Negative controls put a reply's row
 * into the measured finished frame `opencode-live-4134/turn-done-subsecond.txt`, in
 * memory, with the old rule beside them.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { opencodeStatusDetector } from '@/lib/detection/tools/opencode/detect';
import {
  isOpencodeProcessingFooter,
  OPENCODE_PROCESSING_INDICATOR,
  OPENCODE_SKIP_PATTERNS,
} from '@/lib/detection/tools/opencode/patterns';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { isOpenCodeComplete } from '@/lib/response-extractor';
import { extractResponse } from '@/lib/polling/response-checker';
import { CANARY_OPENCODE_GENERATING } from '../../../../fixtures/canary/opencode-generating';

const read = (rel: string): string => readFileSync(resolve(__dirname, '../../../..', rel), 'utf8');

const RUNNING: Array<[string, string]> = [
  ['opencode-live-1894/esc-again-window', read('unit/lib/detection/fixtures/opencode-live-1894/esc-again-window.txt')],
  ['opencode-live-1894/esc-again-after-marker', read('unit/lib/detection/fixtures/opencode-live-1894/esc-again-after-marker.txt')],
  ['opencode-live-2047/w80/esc-again-window', read('fixtures/opencode-live-2047/w80/esc-again-window.txt')],
  ['opencode-live-2047/w120/esc-again-window', read('fixtures/opencode-live-2047/w120/esc-again-window.txt')],
  ['opencode-live-2047/w200/esc-again-window', read('fixtures/opencode-live-2047/w200/esc-again-window.txt')],
  ['canary/opencode-generating', CANARY_OPENCODE_GENERATING],
];

const DONE = read('fixtures/opencode-live-4134/turn-done-subsecond.txt');

/** The rule before Issue #4175. */
const OLD_INDICATOR = /esc (?:again to )?interrupt/;

const verdict = (raw: string) => opencodeStatusDetector.detect(normalizeFrame(raw, 'opencode'));

/**
 * The measured finished frame with `row` as a row of its reply, under `MOCK_OK`, and
 * the blank rows between the reply and the composer taken out — the shape of a reply
 * long enough to reach the composer, so the row is inside the status reader's window
 * (`lastLines`, the last 15 rows).
 */
function doneWith(row: string): string {
  const lines = stripAnsi(DONE).split('\n');
  const at = lines.findIndex((line) => line.trim() === 'MOCK_OK');
  const composer = lines.findIndex((line, i) => i > at + 2 && /^\s*┃/.test(line));
  expect(at).toBeGreaterThan(0);
  expect(composer).toBeGreaterThan(at);
  const marker = lines.slice(at + 1, composer).filter((line) => line.trim() !== '');
  return [...lines.slice(0, at + 1), row, ...marker, ...lines.slice(composer)].join('\n');
}

const SENTENCES = [
  ['in a sentence', '     The footer reads esc interrupt while a turn runs.'],
  ['at the head of the row', '     esc again to interrupt is what the footer says after one Esc.'],
  ['after a word', '     Press esc interrupt twice.'],
] as const;

describe('positive: the measured busy footers', () => {
  it.each(RUNNING)('%s: the footer row matches, and the frame is running on it', (_name, raw) => {
    const rows = stripAnsi(raw).split('\n');
    const footer = rows.find((row) => /esc (?:again to )?interrupt/.test(row));
    expect(footer).toBeDefined();
    expect(OPENCODE_PROCESSING_INDICATOR.test(footer as string)).toBe(true);
    const frame = normalizeFrame(raw, 'opencode');
    expect(isOpencodeProcessingFooter(frame.lastLines)).toBe(true);
    expect(verdict(raw).status).toBe('running');
    expect(verdict(raw).reason).toBe(STATUS_REASON.OPENCODE_PROCESSING_INDICATOR);
  });

  it.each(RUNNING)('%s: the hint row is the row right under the composer border', (_name, raw) => {
    const rows = stripAnsi(raw).split('\n');
    const hint = rows.findIndex((row) => OPENCODE_PROCESSING_INDICATOR.test(row));
    expect(rows[hint - 1]).toMatch(/^\s*╹▀{4,}/);
  });

  it('the finished frame is ready, complete, and has no busy footer', () => {
    expect(verdict(DONE).status).toBe('ready');
    expect(isOpenCodeComplete(stripAnsi(DONE))).toBe(true);
  });
});

describe('negative: a reply with the words in a sentence', () => {
  it.each(SENTENCES)('%s: the old rule matched; the row rule does not', (_name, row) => {
    expect(OLD_INDICATOR.test(row)).toBe(true);
    expect(OPENCODE_PROCESSING_INDICATOR.test(row)).toBe(false);
  });

  it.each(SENTENCES)('%s: the status reader stays ready (it read running before)', (_name, row) => {
    const frame = doneWith(row);
    expect(OLD_INDICATOR.test(normalizeFrame(frame, 'opencode').lastLines)).toBe(true);
    expect(verdict(frame).status).toBe('ready');
    expect(verdict(frame).reason).not.toBe(STATUS_REASON.OPENCODE_PROCESSING_INDICATOR);
  });

  it.each(SENTENCES)('%s: the turn completes, and the row stays in the reply', (_name, row) => {
    const frame = doneWith(row);
    expect(isOpenCodeComplete(frame)).toBe(true);
    expect(OPENCODE_SKIP_PATTERNS.some((p) => p.test(row))).toBe(false);
    const result = extractResponse(frame, frame.split('\n').length, 'opencode');
    expect(result?.isComplete).toBe(true);
    expect(stripAnsi(result?.response ?? '')).toContain(row.trim());
  });
});

describe('negative: a reply quoting the hint row whole, above the composer', () => {
  const QUOTED = '     ⬝⬝⬝⬝■■■■  esc again to interrupt';

  it('matches the row rule (a row cannot tell a quote from the footer)', () => {
    expect(OPENCODE_PROCESSING_INDICATOR.test(QUOTED)).toBe(true);
  });

  it('the status reader takes the hint only under the border, so the frame stays ready', () => {
    const frame = doneWith(QUOTED);
    expect(OPENCODE_PROCESSING_INDICATOR.test(normalizeFrame(frame, 'opencode').lastLines)).toBe(true);
    expect(isOpencodeProcessingFooter(normalizeFrame(frame, 'opencode').lastLines)).toBe(false);
    expect(verdict(frame).status).toBe('ready');
  });

  it('with no border in the text, the hint anywhere is still read (the rule as it was)', () => {
    expect(isOpencodeProcessingFooter('  Build GPT-5-mini\n  esc interrupt')).toBe(true);
    expect(isOpencodeProcessingFooter('  The footer reads esc interrupt while a turn runs.')).toBe(false);
  });
});
