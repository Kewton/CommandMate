/**
 * Issue #4188, items 1 and 2 for OpenCode V1: the rows only the chrome draws —
 * the busy hint (`esc interrupt`), the placeholder (`Ask anything...`), the
 * first-idle footer (`tab agents  ctrl+p commands`) and the spinner run — are read
 * by position (under the composer's bottom border), not as words anywhere, by the
 * completion check (`isOpenCodeComplete`) and by the extraction's skip list.
 *
 * Positive controls are measured frames: `tests/fixtures/opencode-live-2047/`
 * (`phrase-in-response.txt`, where the reply really is `Ask anything... is the
 * placeholder`), `tests/fixtures/opencode-live-4134/turn-done-subsecond.txt` and
 * the running frames of `opencode-live-2047`. Negative controls put a reply's row
 * into the measured finished frame, in memory; the rule the code had before is
 * written out beside each so the control is not vacuous.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import {
  findOpenCodeChromeStart,
  OPENCODE_CHROME_ROW_PATTERNS,
  OPENCODE_PROCESSING_INDICATOR,
  OPENCODE_SKIP_PATTERNS,
  OPENCODE_TRANSCRIPT_SKIP_PATTERNS,
} from '@/lib/detection/tools/opencode/patterns';
import { cleanOpenCodeTurnResponse, isOpenCodeComplete } from '@/lib/response-extractor';
import { cleanOpenCodeResponse } from '@/lib/response-cleaner';
import { extractResponse } from '@/lib/polling/response-checker';

const fixture = (rel: string): string => readFileSync(resolve(__dirname, '../../../../fixtures', rel), 'utf8');

const DONE = fixture('opencode-live-4134/turn-done-subsecond.txt');
const PHRASE_IN_RESPONSE = fixture('opencode-live-2047/w80/phrase-in-response.txt');
const RUNNING: Array<[string, string]> = [
  ['w80/turn-running', fixture('opencode-live-2047/w80/turn-running.txt')],
  ['w80/esc-again-window', fixture('opencode-live-2047/w80/esc-again-window.txt')],
  ['w120/esc-again-window', fixture('opencode-live-2047/w120/esc-again-window.txt')],
];

/**
 * The completion check before Issue #4188: today's, with the hint read anywhere on
 * the frame (the one term #4188 changed).
 */
const oldIsComplete = (text: string): boolean =>
  isOpenCodeComplete(text) && !OPENCODE_PROCESSING_INDICATOR.test(text);

/** A reply's rows quoting the chrome rows whole, at the reply's column (5). */
const QUOTED: Array<[string, string]> = [
  ['the busy hint', '     esc interrupt'],
  ['the hint after one Esc, with its spinner', '     ⬝⬝⬝⬝■■■■  esc again to interrupt'],
  ['the placeholder', '     Ask anything...'],
  ['the first-idle footer', '     tab agents  ctrl+p commands'],
  ['the spinner run', '     ⬝⬝⬝⬝⬝⬝⬝⬝'],
];
const HINT_ROWS = QUOTED.slice(0, 2);

/** The measured finished frame with `row` as a row of its reply, under `MOCK_OK`. */
function doneWith(row: string): string {
  const lines = stripAnsi(DONE).split('\n');
  const at = lines.findIndex((line) => line.trim() === 'MOCK_OK');
  expect(at).toBeGreaterThan(0);
  return [...lines.slice(0, at + 1), row, ...lines.slice(at + 1)].join('\n');
}

/** `text` cut above the composer, as a window that holds no chrome. */
function withoutChrome(text: string): string {
  const lines = text.split('\n');
  const chrome = findOpenCodeChromeStart(lines);
  expect(chrome).toBeGreaterThan(0);
  return lines.slice(0, chrome).join('\n');
}

const extract = (text: string) => extractResponse(text, text.split('\n').length, 'opencode');

describe('the measured frames', () => {
  it('every chrome-only row of the running frames sits under the composer border', () => {
    for (const [name, raw] of RUNNING) {
      const lines = stripAnsi(raw).split('\n');
      const chrome = findOpenCodeChromeStart(lines);
      const hits = lines
        .map((line, i) => [line, i] as const)
        .filter(([line]) => OPENCODE_CHROME_ROW_PATTERNS.some((p) => p.test(line)));
      expect(hits.length, name).toBeGreaterThan(0);
      for (const [, i] of hits) expect(i, name).toBeGreaterThan(chrome);
    }
  });

  it.each(RUNNING)('%s: still not complete (the hint under the border)', (_name, raw) => {
    expect(isOpenCodeComplete(stripAnsi(raw))).toBe(false);
  });

  it('the finished frame completes', () => {
    expect(isOpenCodeComplete(stripAnsi(DONE))).toBe(true);
  });
});

describe('item 1: a reply quoting the hint row whole completes', () => {
  it.each(HINT_ROWS)('%s: complete (the old rule held the turn open)', (_name, row) => {
    const frame = doneWith(row);
    expect(oldIsComplete(frame)).toBe(false);
    expect(OPENCODE_PROCESSING_INDICATOR.test(frame)).toBe(true);
    expect(isOpenCodeComplete(frame)).toBe(true);
    expect(extract(frame)?.isComplete).toBe(true);
  });
});

describe('items 1 and 2: the quoted row stays in the reply', () => {
  it.each(QUOTED)('%s: extracted and kept by the save-path cleaner', (_name, row) => {
    const frame = doneWith(row);
    const result = extract(frame);
    expect(result?.isComplete).toBe(true);
    // The words still match the per-row list — that is why it must not be read here.
    expect(OPENCODE_SKIP_PATTERNS.some((p) => p.test(row.trim()))).toBe(true);
    expect(OPENCODE_TRANSCRIPT_SKIP_PATTERNS.some((p) => p.test(row.trim()))).toBe(false);
    expect(stripAnsi(result?.response ?? '')).toContain(row.trim());
    const saved = cleanOpenCodeTurnResponse(result?.response ?? '');
    expect(saved).toContain(row.trim());
    expect(saved).toContain('MOCK_OK');
    expect(saved).not.toContain('▣');
    // The cleaner the save path used before dropped it.
    expect(cleanOpenCodeResponse(result?.response ?? '')).not.toContain(row.trim());
  });

  it('the measured reply `Ask anything... is the placeholder` is saved (it was saved empty)', () => {
    const result = extractResponse(PHRASE_IN_RESPONSE, 0, 'opencode');
    expect(result?.isComplete).toBe(true);
    expect(cleanOpenCodeResponse(result?.response ?? '')).toBe('');
    expect(cleanOpenCodeTurnResponse(result?.response ?? '')).toBe('Ask anything... is the placeholder');
  });

  it('the finished frame saves only its reply, without the chrome', () => {
    const result = extract(stripAnsi(DONE));
    expect(cleanOpenCodeTurnResponse(result?.response ?? '')).toBe('MOCK_OK');
  });
});

describe('with no chrome on the frame, the words are still read (the rule as it was)', () => {
  it('a hint row anywhere holds the turn open', () => {
    const frame = withoutChrome(doneWith('     esc interrupt'));
    expect(isOpenCodeComplete(frame)).toBe(false);
  });

  it('a row with the chrome words is skipped from the extraction', () => {
    const frame = withoutChrome(doneWith('     ⬝⬝⬝⬝⬝⬝⬝⬝'));
    const result = extract(frame);
    expect(result?.isComplete).toBe(true);
    expect(stripAnsi(result?.response ?? '')).toContain('MOCK_OK');
    expect(stripAnsi(result?.response ?? '')).not.toContain('⬝⬝⬝⬝');
  });
});
