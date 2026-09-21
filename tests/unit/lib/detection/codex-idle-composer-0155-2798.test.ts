/**
 * Issue #2798 — codex 0.155.1's idle composer is not a selection list.
 *
 * ## The defect
 *
 * codex 0.155.1 draws the idle composer's `›` bold AND in truecolor orange:
 *
 * ```text
 * ESC[1mESC[38;2;255;178;66m›ESC[0m ESC[2mAsk Codex to do anythingESC[0m
 * ```
 *
 * `readCodexGlyphRowKind` took any coloured glyph for a dialog's highlighted row
 * (#2310 had only ever seen colour on a dialog), so every finished turn read as
 * `waiting` / `codex_selection_list` while the composer reader said `ghost` on
 * the same frame. The chat pane stayed on the selection-list card, `commandmate
 * wait` exited 10 instead of completing, and the Pick pad offered the
 * assistant's own numbered paragraphs as choices.
 *
 * ## What these tests are read off
 *
 * `tests/fixtures/codex-idle-composer-0155/idle-after-turn.txt` — the frame the
 * Issue was filed on, read back from the production server's `current-output`
 * payload and anonymised. Its README says exactly what was edited and shows the
 * edited frame reading identically to the original under every reader this
 * file uses. It is RAW on purpose: the whole question is the SGR attributes.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectSessionStatus, SELECTION_LIST_REASONS } from '@/lib/detection/status-detector';
import { stripAnsi, findCodexChromeStart } from '@/lib/detection/cli-patterns';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { extractComposerText } from '@/lib/detection/composer-text';
import {
  findCodexBottomGlyphRow,
  readCodexDialogFrame,
  readCodexGlyphRowKind,
  resetCodexDialogFooterDriftForTests,
} from '@/lib/detection/tools/codex/cli-patterns';

const REPO_ROOT = join(__dirname, '../../../..');
const FIXTURE_0155 = join(REPO_ROOT, 'tests/fixtures/codex-idle-composer-0155/idle-after-turn.txt');
const LIVE_2310 = join(REPO_ROOT, 'tests/fixtures/codex-live-2310');

const readFrame = (path: string): string => readFileSync(path, 'utf-8');
const frame0155 = (): string => readFrame(FIXTURE_0155);

/** Index of the composer row in the fixture (`fullOutput` row 129, 1-based). */
const COMPOSER_ROW = 128;

/** The composer row exactly as codex 0.155.1 drew it. */
const LIVE_COMPOSER_ROW = '\x1b[1m\x1b[38;2;255;178;66m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m';

/** `current-output`'s `isSelectionListActive`, restated from `current-output-builder.ts`. */
function isSelectionListActive(frame: string): boolean {
  const result = detectSessionStatus(frame, 'codex');
  return result.status === 'waiting' && SELECTION_LIST_REASONS.has(result.reason);
}

/** Replace one row of a frame, leaving every other byte where it was. */
function withRow(frame: string, index: number, row: string): string {
  const rows = frame.split('\n');
  rows[index] = row;
  return rows.join('\n');
}

/** The rows `readCodexDialogFrame` is handed by `detect.ts`: stripped, trailing blanks cut. */
function contentOf(frame: string): { lines: string[]; end: number } {
  const lines = stripAnsi(frame).split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return { lines: lines.slice(0, end), end };
}

beforeEach(() => {
  resetCodexDialogFooterDriftForTests();
});

// ---------------------------------------------------------------------------
// The fixture is the measurement. If this fails, nothing below means anything.
// ---------------------------------------------------------------------------

describe('[#2798] the 0.155.1 fixture still carries what the Issue measured', () => {
  it('is raw, from 0.155.1, at the geometry the server captured', () => {
    const frame = frame0155();
    expect(frame).toContain('\x1b[');
    expect(stripAnsi(frame)).toContain('OpenAI Codex (v0.155.1)');
    // `lineCount` of the payload it was read from.
    expect(frame.split('\n')).toHaveLength(1002);
  });

  it('row 128 is the composer, byte for byte as codex drew it', () => {
    expect(frame0155().split('\n')[COMPOSER_ROW]).toBe(LIVE_COMPOSER_ROW);
  });

  it('carries the two settled echoes (dim glyph) the Issue compared it with', () => {
    const rows = frame0155().split('\n');
    expect(rows[11]).toBe('\x1b[1;2m› \x1b[0ma');
    expect(rows[19].startsWith('\x1b[1;2m› \x1b[0m')).toBe(true);
  });

  it("carries the assistant's numbered paragraphs the Pick pad was built from", () => {
    const text = stripAnsi(frame0155());
    for (const n of ['1.', '2.', '3.', '4.']) {
      expect(text).toMatch(new RegExp(`^  ${n.replace('.', '\\.')} `, 'm'));
    }
  });
});

// ---------------------------------------------------------------------------
// The defect.
// ---------------------------------------------------------------------------

describe('[#2798] a finished turn on 0.155.1 reads as idle', () => {
  it('is `ready` / `input_prompt`, not `waiting` / `codex_selection_list`', () => {
    const result = detectSessionStatus(frame0155(), 'codex');
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(result.reason).not.toBe(STATUS_REASON.CODEX_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('publishes `isSelectionListActive: false` (no card, no Nav/Pick pad, no `wait` exit 10)', () => {
    expect(isSelectionListActive(frame0155())).toBe(false);
  });

  it('the row reader and the composer reader agree on the same row', () => {
    const frame = frame0155();
    // The contradiction the Issue was filed on: `ghost` next to a dialog.
    expect(extractComposerText(frame, 'codex').state).toBe('ghost');
    expect(findCodexBottomGlyphRow(frame)).toEqual({ kind: 'composer', row: COMPOSER_ROW });
  });

  it('offers no dialog, so the numbered paragraphs are not turned into options', () => {
    const frame = frame0155();
    const { lines, end } = contentOf(frame);
    expect(readCodexDialogFrame(frame, lines, end)).toBeNull();
  });

  it("reaches #2400's chrome reader too: the composer is found where it is", () => {
    // With the row read as an option this answered -1, i.e. the pre-#2400
    // reading on a saturated pane.
    expect(findCodexChromeStart(frame0155().split('\n'))).toBe(COMPOSER_ROW);
  });
});

// ---------------------------------------------------------------------------
// #2310's menus must stay caught — the direction a fix could break.
// ---------------------------------------------------------------------------

describe('[#2798] the unnumbered menus #2310 was raised for are still `waiting`', () => {
  it.each(['dialog-experimental-toggles', 'dialog-keymap-editor'])('%s', name => {
    const frame = readFrame(join(LIVE_2310, `${name}.txt`));
    const result = detectSessionStatus(frame, 'codex');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.CODEX_SELECTION_LIST);
    expect(isSelectionListActive(frame)).toBe(true);
    expect(findCodexBottomGlyphRow(frame)?.kind).toBe('option');
  });

  it('the trust dialog — the one option recognised by colour, not bold — is still an option', () => {
    // `ESC[38;5;6m› 1. Yes, continueESC[39m`: neither bold nor dim. The colour
    // rule is what catches it, so this is the row the #2798 change had to keep.
    const frame = readFrame(join(LIVE_2310, 'dialog-trust-directory.txt'));
    expect(findCodexBottomGlyphRow(frame)?.kind).toBe('option');
    const result = detectSessionStatus(frame, 'codex');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(result.hasActivePrompt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The row reader.
// ---------------------------------------------------------------------------

describe('[#2798] readCodexGlyphRowKind with a coloured composer glyph', () => {
  // Only the first row is measured on 0.155.1. The other composer rows put that
  // measured glyph in front of labels measured on earlier builds (0.148.0's
  // typed text, 0.154.0's paste label) — composed, not captured; see the
  // fixture README's "what this does not cover".
  const GLYPH_0155 = '\x1b[1m\x1b[38;2;255;178;66m›\x1b[0m';

  const rows = [
    { what: '0.155.1 empty composer (measured)', kind: 'composer', row: LIVE_COMPOSER_ROW },
    { what: '0.155.1 glyph + typed text', kind: 'composer', row: `${GLYPH_0155} echo PREFILLED` },
    { what: '0.155.1 glyph + typed `1. buy milk`', kind: 'composer', row: `${GLYPH_0155} 1. buy milk` },
    {
      // #2464's measured paste label (cyan) beside the 0.155.1 glyph (orange):
      // "the label is coloured too" would call this a dialog.
      what: '0.155.1 glyph + pasted-content label',
      kind: 'composer',
      row: `${GLYPH_0155} \x1b[38;5;6m[Pasted Content 12288 chars]\x1b[39m`,
    },
    { what: 'trust dialog option (colour runs into the label)', kind: 'option', row: '\x1b[38;5;6m› 1. Yes, continue\x1b[39m' },
    { what: 'approval option (bold label)', kind: 'option', row: '\x1b[1m\x1b[38;5;6m› 1. Yes, proceed (y)\x1b[0m' },
    { what: 'bold label, 16-colour glyph', kind: 'option', row: '\x1b[1;36m› Global  - Open Agents\x1b[0m' },
    { what: 'settled echo (dim glyph)', kind: 'transcript-echo', row: '\x1b[1;2m› \x1b[0ma' },
  ] as const;

  it.each(rows)('$what → $kind', ({ row, kind }) => {
    expect(readCodexGlyphRowKind(row)).toBe(kind);
  });

  it('a stripped 0.155.1 composer still answers `null`, not a guess', () => {
    expect(readCodexGlyphRowKind(stripAnsi(LIVE_COMPOSER_ROW))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mutation injection: each guard is what holds its verdict.
// ---------------------------------------------------------------------------

describe('[#2798] guard 1 — colour counts only when the label is in the glyph\'s colour', () => {
  /**
   * The same composer row with `ESC[0m` after the glyph weakened to `ESC[22m`:
   * bold and dim are dropped, the orange carries on into the label. That is
   * exactly a dialog's one-span highlight, so it must read as an option — and
   * the unmutated row must not.
   */
  const TYPED = '\x1b[1m\x1b[38;2;255;178;66m›\x1b[0m echo PREFILLED';
  const TYPED_CARRIED = '\x1b[1m\x1b[38;2;255;178;66m›\x1b[22m echo PREFILLED';

  it('row: carrying the glyph colour into the label turns the composer into an option', () => {
    expect(readCodexGlyphRowKind(TYPED)).toBe('composer');
    expect(readCodexGlyphRowKind(TYPED_CARRIED)).toBe('option');
  });

  it('frame: the same mutation on the live frame flips it back to `waiting`', () => {
    const typed = withRow(frame0155(), COMPOSER_ROW, TYPED);
    expect(detectSessionStatus(typed, 'codex').status).toBe('ready');
    expect(isSelectionListActive(typed)).toBe(false);

    const carried = withRow(frame0155(), COMPOSER_ROW, TYPED_CARRIED);
    const result = detectSessionStatus(carried, 'codex');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.CODEX_SELECTION_LIST);
  });

  it('the colour VALUE is read: a trust option relabelled in another colour stops being one', () => {
    // Same row, one SGR inserted after the glyph so the label is green instead
    // of the glyph's cyan. Reading "the label is coloured" rather than "the
    // label is in the glyph's colour" would keep this an option.
    expect(readCodexGlyphRowKind('\x1b[38;5;6m› 1. Yes, continue\x1b[39m')).toBe('option');
    expect(readCodexGlyphRowKind('\x1b[38;5;6m›\x1b[38;5;2m 1. Yes, continue\x1b[39m')).toBe('composer');
  });
});

describe('[#2798] guard 2 — a dim label is the composer\'s own placeholder', () => {
  /**
   * The live row with the glyph's orange carried into the dim placeholder, so
   * guard 1 alone would call it an option: only the dim label holds `composer`.
   * Taking the dim away (`ESC[2m` removed) is the mutation.
   */
  const GHOST_CARRIED = '\x1b[1m\x1b[38;2;255;178;66m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[0m';
  const GHOST_CARRIED_NOT_DIM = '\x1b[1m\x1b[38;2;255;178;66m›\x1b[22m Ask Codex to do anything\x1b[0m';

  it('row: removing the dim from the placeholder turns the composer into an option', () => {
    expect(readCodexGlyphRowKind(GHOST_CARRIED)).toBe('composer');
    expect(readCodexGlyphRowKind(GHOST_CARRIED_NOT_DIM)).toBe('option');
  });

  it('frame: the same mutation on the live frame flips it back to `waiting`', () => {
    const ghost = withRow(frame0155(), COMPOSER_ROW, GHOST_CARRIED);
    expect(detectSessionStatus(ghost, 'codex').status).toBe('ready');
    expect(extractComposerText(ghost, 'codex').state).toBe('ghost');

    const notDim = withRow(frame0155(), COMPOSER_ROW, GHOST_CARRIED_NOT_DIM);
    expect(detectSessionStatus(notDim, 'codex').status).toBe('waiting');
    expect(isSelectionListActive(notDim)).toBe(true);
  });

  it('never outranks a bold label: a bold+dim highlighted label is still an option', () => {
    expect(readCodexGlyphRowKind('\x1b[36m›\x1b[1;2m 3. Disabled choice\x1b[0m')).toBe('option');
  });
});

// ---------------------------------------------------------------------------
// Every existing codex fixture reads exactly as it did before #2798.
// ---------------------------------------------------------------------------

describe('[#2798] no verdict of the existing codex fixture corpus moved', () => {
  /**
   * `[path, status, reason, hasActivePrompt, every › row's kind]`, recorded by
   * running this scan on `develop` at 13cfe5c6 — i.e. BEFORE the #2798 change —
   * over every raw codex frame under `tests/` (every `.txt` / `.capture` whose
   * path names codex and sits under a `fixtures` directory). The last column is
   * `row:kind` for each row `readCodexGlyphRowKind` classified, so a row that
   * changed kind without moving the verdict still fails here.
   *
   * Frames stored ANSI-stripped (`codex-hooks-review-0148.ts`,
   * `codex-1000-row-approval.ts`, most of `model-info-captures.ts`) are not
   * listed: the row reader answers `null` for a row with no escape before it
   * reaches anything #2798 changed, so they cannot move.
   *
   * The only frame whose reading #2798 changes is its own fixture
   * (`waiting` / `codex_selection_list` before, `ready` / `input_prompt` after),
   * which is pinned by the suites above rather than here.
   */
  const CORPUS: ReadonlyArray<readonly [string, string, string, boolean, string]> = [
    ['tests/fixtures/agent-mode-2592/codex-default-thread-title.txt', 'ready', 'input_prompt', false, ''],
    ['tests/fixtures/agent-mode-2592/codex-default.txt', 'ready', 'input_prompt', false, '12:composer'],
    ['tests/fixtures/agent-mode-2592/codex-plan-no-thread-title.txt', 'ready', 'input_prompt', false, ''],
    ['tests/fixtures/agent-mode-2592/codex-plan.txt', 'ready', 'input_prompt', false, ''],
    ['tests/fixtures/chat-dialog-card-2254/codex-model-0-151-0.txt', 'waiting', 'codex_selection_list', false, '23:option'],
    ['tests/fixtures/chat-dialog-card-2254/codex-trust-0-151-0.txt', 'waiting', 'prompt_detected', true, '5:option'],
    ['tests/fixtures/codex-browser-use-2609/approval-form-browser-use.txt', 'waiting', 'prompt_detected', true, ''],
    ['tests/fixtures/codex-live-2310/dialog-experimental-toggles.txt', 'waiting', 'codex_selection_list', false, '15:option'],
    ['tests/fixtures/codex-live-2310/dialog-keymap-editor.txt', 'waiting', 'codex_selection_list', false, '19:option'],
    ['tests/fixtures/codex-live-2310/dialog-permissions-picker.txt', 'waiting', 'codex_selection_list', false, '14:option'],
    ['tests/fixtures/codex-live-2310/dialog-trust-directory.txt', 'waiting', 'prompt_detected', true, '5:option'],
    ['tests/fixtures/codex-live-2310/idle-composer.txt', 'ready', 'input_prompt', false, '12:composer'],
    ['tests/fixtures/codex-live-2310/saturated-idle-tail.txt', 'ready', 'input_prompt', false, '49:transcript-echo 57:composer'],
    [
      'tests/fixtures/codex-live-2310/steer-queued-running.txt', 'ready', 'input_prompt', false,
      '13:transcript-echo 19:transcript-echo 35:composer 43:transcript-echo 51:composer',
    ],
    ['tests/fixtures/codex-live-2310/turn-running.txt', 'running', 'thinking_indicator', false, '12:transcript-echo 20:composer'],
    [
      'tests/fixtures/codex-live-2310/turn-submitted-no-status.txt', 'ready', 'input_prompt', false,
      '13:transcript-echo 19:transcript-echo 35:composer 39:composer',
    ],
    ['tests/fixtures/codex-update-dialog-2068/update-dialog-01491.txt', 'waiting', 'prompt_detected', true, ''],
    ['tests/fixtures/codex-update-dialog-2068/updated-shell-01491.txt', 'waiting', 'prompt_detected', true, ''],
    ['tests/fixtures/codex-update-dialog-2068/updating-01491.txt', 'waiting', 'prompt_detected', true, ''],
    ['tests/fixtures/long-body-2464/codex-idle.capture', 'ready', 'input_prompt', false, '37:composer'],
    ['tests/fixtures/long-body-2464/codex-pasted-content.capture', 'ready', 'input_prompt', false, '37:composer'],
    ['tests/fixtures/tool-liveness-2070/codex-exited-01491.txt', 'waiting', 'prompt_detected', true, ''],
    ['tests/fixtures/tool-liveness-2070/codex-ready-01491.txt', 'ready', 'input_prompt', false, ''],
    ['tests/fixtures/tool-liveness-2070/codex-trust-dialog-01491.txt', 'waiting', 'prompt_detected', true, ''],
    [
      'tests/unit/lib/detection/fixtures/codex-live-1628/approval-apply-patch.txt', 'waiting', 'prompt_detected', true,
      '14:transcript-echo 43:option',
    ],
    [
      'tests/unit/lib/detection/fixtures/codex-live-1628/approval-run-command.txt', 'waiting', 'prompt_detected', true,
      '14:transcript-echo 50:option',
    ],
    [
      'tests/unit/lib/detection/fixtures/codex-live-1628/idle-ready.txt', 'ready', 'input_prompt', false,
      '14:transcript-echo 66:composer',
    ],
    [
      'tests/unit/lib/detection/fixtures/codex-live-1628/model-picker-step1.txt', 'waiting', 'codex_selection_list', false,
      '14:transcript-echo 70:option',
    ],
    [
      'tests/unit/lib/detection/fixtures/codex-live-1628/model-picker-step2.txt', 'waiting', 'codex_selection_list', false,
      '14:transcript-echo 71:option',
    ],
    [
      'tests/unit/lib/detection/fixtures/codex-live-1628/working.txt', 'running', 'thinking_indicator', false,
      '14:transcript-echo 54:composer',
    ],
    ['tests/unit/lib/detection/fixtures/codex-live-1671/reported-session-tail.txt', 'ready', 'input_prompt', false, '57:composer'],
    [
      'tests/unit/lib/detection/fixtures/codex-live-1671/turn-complete-short-message.txt', 'ready', 'input_prompt', false,
      '9:composer 25:transcript-echo 42:composer',
    ],
    [
      'tests/unit/lib/detection/fixtures/codex-live-1671/turn-running-command.txt', 'running', 'thinking_indicator', false,
      '9:composer 25:transcript-echo 37:composer',
    ],
    ['tests/unit/lib/detection/fixtures/codex-live-1890/composer-placeholder-ask.txt', 'ready', 'input_prompt', false, '18:composer'],
    [
      'tests/unit/lib/detection/fixtures/codex-live-1890/composer-residual-leading-number.txt', 'ready', 'input_prompt', false,
      '18:composer',
    ],
    [
      'tests/unit/lib/detection/fixtures/codex-live-1890/composer-residual-multiline.txt', 'running', 'thinking_indicator', false,
      '18:composer',
    ],
    ['tests/unit/lib/detection/fixtures/codex-live-1890/composer-residual-plain.txt', 'ready', 'input_prompt', false, '18:composer'],
    ['tests/unit/lib/detection/fixtures/codex-live-1890/composer-residual-slash.txt', 'ready', 'input_prompt', false, '18:composer'],
    [
      'tests/unit/lib/detection/fixtures/codex-live-1890/dialog-model-picker.txt', 'waiting', 'codex_selection_list', false,
      '21:option',
    ],
    ['tests/unit/lib/tmux/fixtures/capture-codex.txt', 'running', 'thinking_indicator', false, '297:composer 397:composer'],
  ];

  /** Every `›` row the row reader classified, as `row:kind`. */
  function rowKinds(frame: string): string {
    return frame
      .split('\n')
      .flatMap((row, i) => {
        const kind = readCodexGlyphRowKind(row);
        return kind === null ? [] : [`${i}:${kind}`];
      })
      .join(' ');
  }

  it.each(CORPUS)('%s', (path, status, reason, hasActivePrompt, kinds) => {
    const absolute = join(REPO_ROOT, path);
    // A renamed or deleted fixture must fail here, not silently shrink the scan.
    expect(existsSync(absolute)).toBe(true);
    const frame = readFrame(absolute);
    const result = detectSessionStatus(frame, 'codex');
    expect({
      status: result.status,
      reason: result.reason,
      hasActivePrompt: result.hasActivePrompt,
      kinds: rowKinds(frame),
    }).toEqual({ status, reason, hasActivePrompt, kinds });
  });

  it('holds all 40 frames, 11 of them with a dialog option on screen', () => {
    expect(CORPUS.length).toBe(40);
    expect(CORPUS.filter(([, , , , kinds]) => kinds.includes('option'))).toHaveLength(11);
  });
});
