/** @vitest-environment node */

/**
 * Issue #3906 (condition 4): the clear reads the composer the sender reads.
 *
 * A pasted body of more paragraphs than `extractComposerText`'s four blocks is
 * a composer to the sender (`pasting` / `pending`, #3906), and the sender takes
 * an unarrived body back out through `clearComposer`. Read with the extractor
 * alone, that frame was `no_composer`: zero passes, the body left in the box,
 * and the next send's pre-clear passed it too — the next body was typed after
 * it. The positive controls here fail on the extractor-only loop; the negative
 * controls pin the frames the clear must still leave alone: an idle composer,
 * the transcript echo of a sent message (dim, and codex's bold-not-dim form),
 * and a composer row left above an approval dialog.
 *
 * Frames are built like `tests/unit/cli-tools/submit-verified-sender-codex-window-3906.test.ts`:
 * the live codex-cli 0.160.0 capture `tests/fixtures/codex-multiline-composer-3205/tc104-raw-pane.txt`
 * (transcript and footer), ANSI intact, with the composer rows replaced.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(),
  clearComposerLine: vi.fn(),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

import { clearComposer, findCodexLiveComposerRow } from '@/lib/session/composer-clear';
import {
  extractComposerText,
  isCodexBoldGutterRow,
  readCodexComposerFrom,
} from '@/lib/detection/composer-text';

const ESC = '\u001b';
const TC104 = readFileSync(
  path.resolve(__dirname, '../../fixtures/codex-multiline-composer-3205/tc104-raw-pane.txt'),
  'utf-8'
).split('\n');
const TRANSCRIPT = TC104.slice(0, 38);
const FOOTER = TC104[45];

const GLYPH = `${ESC}[1m›${ESC}[0m `;
const ECHO_GLYPH = `${ESC}[1;2m› ${ESC}[0m`;
const IDLE_ROW = `${GLYPH}${ESC}[2mAsk Codex to do anything${ESC}[0m`;
const DIALOG = [
  'Would you like to run the following command?',
  '',
  '  $ npm run build',
  '',
  `${ESC}[1m${ESC}[38;5;6m› 1. Yes, proceed (y)${ESC}[0m`,
  '  2. No, and tell Codex what to do differently (esc)',
  '',
  'Press enter to confirm or esc to cancel',
];

function codexFrame(composerRows: string[]): string {
  return [...TRANSCRIPT, ...composerRows, '', FOOTER].join('\n');
}

function composerRows(body: string, glyph = GLYPH): string[] {
  return body.split('\n').map((line, index) => (index === 0 ? glyph : line === '' ? '' : '  ') + line);
}

function paragraphs(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `paragraph ${i + 1}: review the composer reader and report every finding with its file, its line and the frame that shows it`
  ).join('\n\n');
}

const IDLE = codexFrame([IDLE_ROW]);
/** Four of five paragraphs: the frame the sender reads as `pasting` and withdraws. */
const PARTIAL = codexFrame(composerRows(paragraphs(4)));

const noDelay = (): Promise<void> => Promise.resolve();

/** A capture that shows `frames[n]` on the n-th read and the last one after that. */
function captureSequence(...frames: string[]): () => Promise<string> {
  let reads = 0;
  return async () => frames[Math.min(reads++, frames.length - 1)];
}

describe('Issue #3906 (4): clearComposer reads a composer of many paragraphs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('the frame is one the extractor alone calls no_composer', () => {
    expect(extractComposerText(PARTIAL, 'codex').state).toBe('no_composer');
  });

  it('positive: a partly arrived multi-paragraph body is cleared, not skipped (was 0 passes / no_composer)', async () => {
    const sendClear = vi.fn().mockResolvedValue(undefined);
    const result = await clearComposer('sess', 'codex', {
      capture: captureSequence(PARTIAL, IDLE),
      sendClear,
      delay: noDelay,
    });
    expect(sendClear).toHaveBeenCalledTimes(1);
    expect(result.passes).toBe(1);
    expect(result.cleared).toBe(true);
    expect(result.state).toBe('ghost');
    expect(result.discardedText).toContain('paragraph 1:');
    expect(result.discardedText).toContain('paragraph 4:');
  });

  it('positive: a body the passes never remove is reported as content left, not cleared', async () => {
    const sendClear = vi.fn().mockResolvedValue(undefined);
    const result = await clearComposer('sess', 'codex', {
      capture: async () => PARTIAL,
      sendClear,
      delay: noDelay,
      maxPasses: 3,
    });
    expect(result.passes).toBe(3);
    expect(result.cleared).toBe(false);
    expect(result.state).toBe('content');
    expect(result.remainingText).toContain('paragraph 4:');
  });

  it('negative: an idle composer is left alone (ghost, 0 passes)', async () => {
    const sendClear = vi.fn();
    const result = await clearComposer('sess', 'codex', { capture: async () => IDLE, sendClear, delay: noDelay });
    expect(sendClear).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cleared: true, passes: 0, state: 'ghost' });
  });

  it('negative: the dim transcript echo of a sent body with no composer drawn stays no_composer', async () => {
    const frame = [...TRANSCRIPT, ...composerRows(paragraphs(9), ECHO_GLYPH), '', FOOTER].join('\n');
    const sendClear = vi.fn();
    const result = await clearComposer('sess', 'codex', { capture: async () => frame, sendClear, delay: noDelay });
    expect(sendClear).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cleared: false, passes: 0, state: 'no_composer' });
  });

  it('negative: a composer row left above an approval dialog stays no_composer (no keys into the dialog)', async () => {
    const frame = [...TRANSCRIPT, ...composerRows(paragraphs(5)), '', ...DIALOG].join('\n');
    expect(extractComposerText(frame, 'codex').state).toBe('no_composer');
    const sendClear = vi.fn();
    const result = await clearComposer('sess', 'codex', { capture: async () => frame, sendClear, delay: noDelay });
    expect(sendClear).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cleared: false, passes: 0, state: 'no_composer' });
  });

  it('negative: a claude frame is read by the extractor alone, as before', async () => {
    const sendClear = vi.fn();
    const result = await clearComposer('sess', 'claude', { capture: async () => PARTIAL, sendClear, delay: noDelay });
    expect(sendClear).not.toHaveBeenCalled();
    expect(result.state).toBe('no_composer');
  });
});

describe('Issue #3906: findCodexLiveComposerRow', () => {
  it('finds the `›` row of a composer above the extractor\'s blocks', () => {
    const rows = PARTIAL.split('\n');
    expect(findCodexLiveComposerRow(rows)).toBe(TRANSCRIPT.length);
  });

  it('answers -1 when a dialog option is drawn below the only composer row', () => {
    const rows = [...TRANSCRIPT, ...composerRows(paragraphs(5)), '', ...DIALOG];
    expect(findCodexLiveComposerRow(rows)).toBe(-1);
  });

  it('skips the bold-not-dim transcript echo codex 0.160.0 draws (tc104 row 20)', () => {
    expect(isCodexBoldGutterRow(TC104[19])).toBe(true);
    expect(isCodexBoldGutterRow(GLYPH + 'text')).toBe(false);
    expect(findCodexLiveComposerRow(TRANSCRIPT)).toBe(-1);
  });

  it('readCodexComposerFrom reads every paragraph down to the footer, not the first block only', () => {
    const rows = PARTIAL.split('\n');
    const read = readCodexComposerFrom(rows, TRANSCRIPT.length);
    expect(read.state).toBe('content');
    expect(read.text.split('\n\n')).toHaveLength(4);
    expect(read.text).not.toContain('GPT');
  });
});

describe('Issue #3906 re-review 2 (1): clearComposer and a dialog below a composer the extractor finds', () => {
  const ROWS = composerRows('row 1: old\nrow 2: old\nrow 3: old');
  const DIALOG_FRAME = [
    ...TRANSCRIPT,
    ...ROWS,
    '',
    `${ESC}[1m${ESC}[38;5;6m› 1. Yes, proceed (y)${ESC}[0m`,
    '  2. No, and tell Codex what to do differently (esc)',
  ].join('\n');

  it('the frame: the extractor reads the old composer as content', () => {
    expect(extractComposerText(DIALOG_FRAME, 'codex').state).toBe('content');
  });

  it('positive: no clear keys into the dialog — no_composer, 0 passes (was content, passes sent)', async () => {
    const sendClear = vi.fn().mockResolvedValue(undefined);
    const result = await clearComposer('sess', 'codex', { capture: async () => DIALOG_FRAME, sendClear, delay: noDelay });
    expect(sendClear).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cleared: false, passes: 0, state: 'no_composer' });
  });

  it('negative: the same rows as the live composer are cleared', async () => {
    const sendClear = vi.fn().mockResolvedValue(undefined);
    const result = await clearComposer('sess', 'codex', {
      capture: captureSequence(codexFrame(ROWS), IDLE),
      sendClear,
      delay: noDelay,
    });
    expect(sendClear).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ cleared: true, passes: 1, state: 'ghost' });
  });

  it('an attribute-free `›` row (a stripped capture) is never taken for the live composer', () => {
    expect(findCodexLiveComposerRow(['› 1. Update now', '  2. Skip', '', 'Press enter to continue'])).toBe(-1);
  });
});
