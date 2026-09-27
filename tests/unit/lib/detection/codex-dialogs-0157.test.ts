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
  CODEX_EFFORT_PICKER_FOOTER_PATTERN,
  CODEX_PICKER_FOOTER_PATTERN,
  CODEX_SELECTION_LIST_PATTERN,
  getCodexActiveDialog,
  getCodexLifecycleDialog,
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

  it('the effort step closes with its own footer row', () => {
    const rows = stripAnsi(read('model-picker-effort')).split('\n');
    expect(rows[990].trim()).toBe('Select Reasoning Level for GPT-6-Sol');
    expect(rows[999]).toBe('  enter default · s session · esc back');
    expect(stripAnsi(read('model-picker-digit')).split('\n')[990].trim()).toBe(
      'Select Reasoning Level for GPT-6-Luna',
    );
  });
});

/** Each 0.157.1 `/model` footer row and the constant that admits it. */
const FOOTERS = [
  ['enter select · esc back', CODEX_PICKER_FOOTER_PATTERN],
  ['enter default · s session · esc back', CODEX_EFFORT_PICKER_FOOTER_PATTERN],
] as const;

describe('[#2868] the 0.157.1 `/model` footer constants', () => {
  it.each(FOOTERS)('%s: matches the measured row, which the list pattern does not', (row, pattern) => {
    expect(pattern.test(row)).toBe(true);
    expect(CODEX_SELECTION_LIST_PATTERN.test(row)).toBe(false);
  });

  it.each(FOOTERS)('%s: does not match the row inside a longer sentence', (row, pattern) => {
    expect(pattern.test(`The footer reads ${row}`)).toBe(false);
    expect(pattern.test(`${row} to leave`)).toBe(false);
  });
});

/** Both `/model` steps: the model list, the effort list after Enter, and after `3`. */
const PICKERS = ['model-picker', 'model-picker-effort', 'model-picker-digit'] as const;

describe('[#2868] the 0.157.1 `/model` steps read as selection lists', () => {
  it.each(PICKERS)('%s: detectSessionStatus is waiting / codex_selection_list', name => {
    const result = detectSessionStatus(read(name), 'codex');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.CODEX_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
    expect(isSelectionListActive(read(name))).toBe(true);
  });

  it.each(PICKERS)('%s: reads the same after stripAnsi (what Auto-Yes hands the detector)', name => {
    const result = detectSessionStatus(stripAnsi(read(name)), 'codex');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.CODEX_SELECTION_LIST);
  });

  it.each(PICKERS)('%s: /prompt-response vouches for it (present, no refusal)', name => {
    const frame = read(name);
    const presence = evaluateDialogPresence('codex', 'multiple_choice', frame);
    expect(presence.gated).toBe(true);
    expect(presence.present).toBe(true);
    const prompt = promptOf(frame);
    expect(prompt.isPrompt).toBe(true);
    expect(judgePromptResponse(prompt, presence)).toBeNull();
  });
});

describe('[#2868] a reply quoting a footer does not open a picker', () => {
  /** `idle.txt` with a reply whose body quotes the footer row just above the composer. */
  const quoted = (footer: string): string =>
    withRow(withRow(read('idle'), 992, '• The picker closes with this row:'), 993, `  ${footer}`);

  it.each(FOOTERS)('%s: the quoted row is really there', row => {
    expect(stripAnsi(quoted(row)).split('\n')[993]).toBe(`  ${row}`);
  });

  it.each(FOOTERS)('%s: is not waiting, and the dialog gate does not vouch for it', row => {
    const frame = quoted(row);
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

/**
 * Issue #2884 — the 0.157.1 trust dialog reworded its question line from
 * `Do you trust the contents of this directory?` to `Trust this folder?`,
 * dropping the "Do you trust" wording `getCodexActiveDialog` /
 * `getCodexLifecycleDialog` keyed on. Startup auto-approval and
 * `/prompt-response` both read `trust.txt` as `waiting` / `prompt_detected`
 * already (the generic parser does not depend on the wording), but neither
 * function named it `'trust'`, so `evaluateDialogPresence` could not vouch
 * for it and `/prompt-response` refused with `prompt_no_longer_active`.
 */
describe('[#2884] the 0.157.1 trust dialog is recognised by wording, not just structure', () => {
  it("trust: getCodexLifecycleDialog / getCodexActiveDialog read 'trust', and /prompt-response may answer it", () => {
    const raw = read('trust');
    const frame = stripAnsi(raw);
    expect(getCodexLifecycleDialog(frame)).toBe('trust');
    expect(getCodexActiveDialog(frame)).toBe('trust');

    const presence = evaluateDialogPresence('codex', 'multiple_choice', raw);
    expect(presence.present).toBe(true);
    expect(judgePromptResponse(promptOf(raw), presence)).toBeNull();
  });

  it('negative control: a reply quoting "Trust this folder? …" above the live prompt is not the trust dialog', () => {
    const quoted = withRow(
      withRow(read('idle'), 992, '• The trust dialog reads:'),
      993,
      '  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.',
    );
    const frame = stripAnsi(quoted);
    expect(getCodexLifecycleDialog(frame)).not.toBe('trust');
    expect(getCodexActiveDialog(frame)).not.toBe('trust');
  });

  it('regression guard: the 0.155.1 trust screen ("Do you trust …") still reads as trust', () => {
    const frame = stripAnsi(
      readFileSync(join(__dirname, '../../../fixtures/codex-dialogs-0155/dialog-trust-directory.txt'), 'utf-8'),
    );
    expect(getCodexLifecycleDialog(frame)).toBe('trust');
    expect(getCodexActiveDialog(frame)).toBe('trust');
  });
});
