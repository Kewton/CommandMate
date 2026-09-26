/**
 * Issue #2868 — codex 0.157.1's `/model` picker, re-measured.
 *
 * ## The defect
 *
 * 0.157.1 retitled the picker (`Select Model and Effort`) and replaced its
 * `Press enter to confirm or esc to go back` footer with `enter select · esc back`.
 * `CODEX_SELECTION_LIST_PATTERN` no longer matched, so branch 0.8 of `detect.ts`
 * missed the picker (the generic parser read it as `multiple_choice`, the UI
 * showed Send) and `detectCodexDialog`'s entry gate returned null, so
 * `/prompt-response` refused every answer with `prompt_no_longer_active`.
 *
 * ## What these tests are read off
 *
 * `tests/fixtures/codex-dialogs-0157/` — the six standard screens of
 * `docs/design/codex-detection-corpus.md` §2 plus two more `/model` frames,
 * captured from codex-cli 0.157.1 on a private tmux socket at 200x1000 and
 * anonymised by two same-length substitutions. The README has the provenance.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectSessionStatus, SELECTION_LIST_REASONS } from '@/lib/detection/status-detector';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import {
  buildDetectPromptOptions,
  CODEX_PICKER_FOOTER_PATTERN,
  CODEX_SELECTION_LIST_PATTERN,
  stripAnsi,
  stripBoxDrawing,
} from '@/lib/detection/cli-patterns';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { CODEX_VERIFIED_AGAINST } from '@/lib/detection/tools/verified-against';
import { evaluateDialogPresence, judgePromptResponse } from '@/lib/polling/auto-yes-dialog-gate';

const DIR = join(__dirname, '../../../fixtures/codex-dialogs-0157');

const read = (name: string): string => readFileSync(join(DIR, `${name}.txt`), 'utf-8');

const ALL = [
  'trust',
  'idle',
  'running',
  'approval',
  'model-picker',
  'model-picker-effort',
  'model-picker-digit',
  'quoted-approval-idle',
] as const;

/** `current-output`'s `isSelectionListActive`, restated from `current-output-builder.ts`. */
function isSelectionListActive(frame: string): boolean {
  const result = detectSessionStatus(frame, 'codex');
  return result.status === 'waiting' && SELECTION_LIST_REASONS.has(result.reason);
}

/** What `/prompt-response` runs on the frame before answering. */
function promptOf(frame: string) {
  return detectPrompt(stripBoxDrawing(stripAnsi(frame)), buildDetectPromptOptions('codex'));
}

/** Replace one row of a frame, leaving every other byte where it was. */
function withRow(frame: string, index: number, row: string): string {
  const rows = frame.split('\n');
  rows[index] = row;
  return rows.join('\n');
}

beforeEach(() => {
  resetDetectPromptCache();
});

describe('[#2868] the fixtures still carry what was measured', () => {
  it.each(ALL)('%s is raw and a whole 200x1000 pane', name => {
    const frame = read(name);
    expect(frame).toContain('\x1b[');
    const rows = frame.split('\n');
    expect(rows).toHaveLength(1001);
    expect(rows[1000]).toBe('');
  });

  it.each(ALL.filter(name => name !== 'trust'))('%s carries the 0.157.1 banner', name => {
    expect(stripAnsi(read(name))).toContain('OpenAI Codex (v0.157.1)');
  });

  it('the picker is bottom-aligned with no status bar below its footer', () => {
    const rows = stripAnsi(read('model-picker')).split('\n');
    expect(rows[988].trim()).toBe('Select Model and Effort');
    expect(rows[992]).toMatch(/^› 2\. GPT-6-Sol \(current\)/);
    expect(rows[999]).toBe('  enter select · esc back');
  });
});

describe('[#2868] CODEX_PICKER_FOOTER_PATTERN', () => {
  it('matches the measured footer row, which the list pattern does not', () => {
    expect(CODEX_PICKER_FOOTER_PATTERN.test('enter select · esc back')).toBe(true);
    expect(CODEX_SELECTION_LIST_PATTERN.test('enter select · esc back')).toBe(false);
  });

  it('does not match the row inside a longer sentence', () => {
    expect(CODEX_PICKER_FOOTER_PATTERN.test('The footer reads enter select · esc back')).toBe(false);
    expect(CODEX_PICKER_FOOTER_PATTERN.test('enter select · esc back to leave')).toBe(false);
  });
});

describe('[#2868] the 0.157.1 `/model` picker reads as a selection list', () => {
  it('detectSessionStatus: waiting / codex_selection_list', () => {
    const result = detectSessionStatus(read('model-picker'), 'codex');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.CODEX_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
    expect(isSelectionListActive(read('model-picker'))).toBe(true);
  });

  it('reads the same after stripAnsi (what Auto-Yes hands the detector)', () => {
    const result = detectSessionStatus(stripAnsi(read('model-picker')), 'codex');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.CODEX_SELECTION_LIST);
  });

  it('/prompt-response vouches for it: present, and no refusal', () => {
    const frame = read('model-picker');
    const presence = evaluateDialogPresence('codex', 'multiple_choice', frame);
    expect(presence.gated).toBe(true);
    expect(presence.present).toBe(true);
    const prompt = promptOf(frame);
    expect(prompt.isPrompt).toBe(true);
    expect(judgePromptResponse(prompt, presence)).toBeNull();
  });
});

describe('[#2868] a reply quoting the footer does not open a picker', () => {
  /** `idle.txt` with a reply whose body quotes the footer row just above the composer. */
  const quoted = (): string =>
    withRow(
      withRow(read('idle'), 992, '• The picker closes with this row:'),
      993,
      '  enter select · esc back',
    );

  it('the quoted row is really there', () => {
    expect(stripAnsi(quoted()).split('\n')[993]).toBe('  enter select · esc back');
  });

  it('is not waiting, and the dialog gate does not vouch for it', () => {
    const frame = quoted();
    const result = detectSessionStatus(frame, 'codex');
    expect(result.status).not.toBe('waiting');
    expect(isSelectionListActive(frame)).toBe(false);
    expect(evaluateDialogPresence('codex', 'multiple_choice', frame).present).toBe(false);
  });
});

describe('[#2868] the other standard screens read as on 0.155.1', () => {
  it.each([
    ['idle', 'ready', STATUS_REASON.INPUT_PROMPT],
    ['running', 'running', STATUS_REASON.THINKING_INDICATOR],
    ['approval', 'waiting', STATUS_REASON.PROMPT_DETECTED],
    ['trust', 'waiting', STATUS_REASON.PROMPT_DETECTED],
    ['quoted-approval-idle', 'ready', STATUS_REASON.INPUT_PROMPT],
  ] as const)('%s', (name, status, reason) => {
    const result = detectSessionStatus(read(name), 'codex');
    expect(result.status).toBe(status);
    expect(result.reason).toBe(reason);
  });

  it('advances the detector-wide stamp to 0.157.1', () => {
    expect(CODEX_VERIFIED_AGAINST).toEqual({
      version: '0.157.1',
      capturedAt: '2026-09-27',
      paneGeometry: '200x1000',
    });
  });
});
