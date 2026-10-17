/**
 * agy's unnumbered arrow-key screens, read one by one (Issue #3755).
 *
 * `detect.ts` publishes the folder-trust screen, the `/model` picker and the
 * slash-command popup under one status reason (`antigravity_selection_list`),
 * which is right for the status — all three are driven from the terminal — and
 * not enough for a caller that is about to answer one of them: it has to know
 * WHICH one is open (#3746 P4). This module tells them apart and reads what
 * each one shows. It decides nothing about status and is not read by the
 * status detector, the poller or Auto-Yes; its one reader is the prompt
 * observation (`lib/prompt-observation`).
 *
 * ## What was measured
 *
 * | screen       | frame                                                     |
 * |--------------|-----------------------------------------------------------|
 * | trust        | `tests/fixtures/prompt-observation-3755/antigravity-trust.txt` (#3746's pane), `antigravity-live-2364/trust-dialog.txt` |
 * | model picker | `antigravity-live-2364/picker-switch-model.txt`           |
 * | slash popup  | `antigravity-live-2364/popup-slash-commands.txt`          |
 *
 * Every one of them ends in agy's `↑/↓ Navigate` footer with no `>` composer
 * drawn below it — agy paints none while a screen is open, which is the same
 * reading `locateAntigravityDialogRegion` gives a numbered dialog (#2845) — so
 * a screen quoted in a reply, or left in the scrollback above a composer, is
 * never read as open.
 *
 * ## Input contract
 *
 * ANSI-stripped text.
 */

import {
  ANTIGRAVITY_NAVIGATE_FOOTER_PATTERN,
  ANTIGRAVITY_PROMPT_PATTERN,
  ANTIGRAVITY_SWITCH_MODEL_HEADER_PATTERN,
} from './patterns';

/** Which unnumbered screen {@link readAntigravityArrowScreen} found. */
export type AntigravityArrowScreenKind = 'trust' | 'model-picker' | 'slash-menu';

/** What one of agy's unnumbered screens shows. */
export interface AntigravityArrowScreen {
  readonly screen: AntigravityArrowScreenKind;
  /** The question or header as drawn; null when the screen has none (the slash popup). */
  readonly question: string | null;
  /** The folder on the trust screen; null elsewhere. */
  readonly approvalTarget: string | null;
  /** Labels in draw order, the `>` highlight removed. */
  readonly options: readonly string[];
  /** Index into {@link options} of the highlighted row, or -1. */
  readonly selectedIndex: number;
}

/**
 * The trust screen's question. Same wording `cli-tools/antigravity.ts` waits for
 * at launch (`ANTIGRAVITY_TRUST_DIALOG_PATTERN`, Issue #988); restated because
 * that module is the launcher, which detection code does not import.
 */
const TRUST_QUESTION_PATTERN = /^\s*Do you trust the contents of this project\?\s*$/;

/** The row above the folder path on the trust screen. */
const TRUST_WORKSPACE_LABEL_PATTERN = /^\s*Accessing workspace:\s*(.*)$/;

/** The highlighted row of an unnumbered list: `> label`. */
const HIGHLIGHTED_ROW_PATTERN = /^\s*>\s+(\S.*)$/;

/** A row of the slash popup: an optional highlight, then `/command`, then its description. */
const SLASH_ROW_PATTERN = /^\s*(?:>\s+)?(\/[\w:.-]+)(?:\s{2,}.*)?$/;

/** The `↓ 41 more` row under the slash popup's visible rows. */
const MORE_ROWS_PATTERN = /^\s*[↓↑]\s*\d+\s+more\s*$/;

/** The picker's effort slider, the first row under its model list. */
const PICKER_EFFORT_ROW_PATTERN = /^\s*Effort\b/;

/** How far above the footer a screen's header may sit. Every measured screen spans under 20 rows. */
const SCREEN_MAX_ROWS = 30;

/** How far above the trust question the `Accessing workspace:` row may sit. */
const WORKSPACE_LOOKBACK_ROWS = 8;

/** Index of the last `↑/↓ Navigate` footer with no composer under it, or -1. */
function openScreenFooter(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!ANTIGRAVITY_NAVIGATE_FOOTER_PATTERN.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (ANTIGRAVITY_PROMPT_PATTERN.test(lines[j])) return -1;
    }
    return i;
  }
  return -1;
}

/** A label as drawn: highlight removed, runs of spaces folded, ends trimmed. */
function labelOf(row: string): string {
  return row.replace(/^\s*>\s+/, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * The unnumbered option rows from `from` (inclusive) up to the first blank row,
 * `stop` row or `end`. Null unless at least two rows were read and exactly one
 * of them wears the highlight.
 */
function readOptionRows(
  lines: readonly string[],
  from: number,
  end: number,
  stop?: RegExp
): { options: string[]; selectedIndex: number } | null {
  const options: string[] = [];
  let selectedIndex = -1;
  for (let i = from; i < end; i++) {
    const row = lines[i];
    if (row.trim() === '' || (stop && stop.test(row))) break;
    if (HIGHLIGHTED_ROW_PATTERN.test(row)) {
      if (selectedIndex >= 0) return null;
      selectedIndex = options.length;
    }
    options.push(labelOf(row));
  }
  if (options.length < 2 || selectedIndex < 0) return null;
  return { options, selectedIndex };
}

function readTrust(lines: readonly string[], footer: number): AntigravityArrowScreen | null {
  const floor = Math.max(0, footer - SCREEN_MAX_ROWS);
  let questionRow = -1;
  for (let i = footer - 1; i >= floor; i--) {
    if (TRUST_QUESTION_PATTERN.test(lines[i])) {
      questionRow = i;
      break;
    }
  }
  if (questionRow < 0) return null;

  let first = -1;
  for (let i = questionRow + 1; i < footer; i++) {
    if (HIGHLIGHTED_ROW_PATTERN.test(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) return null;
  const read = readOptionRows(lines, first, footer);
  if (read === null) return null;

  // The folder: on the row after `Accessing workspace:` (blank rows skipped),
  // or on the label's own row when agy draws it there.
  let approvalTarget: string | null = null;
  const workspaceFloor = Math.max(0, questionRow - WORKSPACE_LOOKBACK_ROWS);
  for (let i = questionRow - 1; i >= workspaceFloor; i--) {
    const match = TRUST_WORKSPACE_LABEL_PATTERN.exec(lines[i]);
    if (!match) continue;
    const inline = match[1].trim();
    if (inline !== '') {
      approvalTarget = inline;
    } else {
      for (let j = i + 1; j < questionRow; j++) {
        if (lines[j].trim() !== '') {
          approvalTarget = lines[j].trim();
          break;
        }
      }
    }
    break;
  }

  return {
    screen: 'trust',
    question: lines[questionRow].trim(),
    approvalTarget,
    options: read.options,
    selectedIndex: read.selectedIndex,
  };
}

function readModelPicker(lines: readonly string[], footer: number): AntigravityArrowScreen | null {
  const floor = Math.max(0, footer - SCREEN_MAX_ROWS);
  for (let i = footer - 1; i >= floor; i--) {
    if (!ANTIGRAVITY_SWITCH_MODEL_HEADER_PATTERN.test(lines[i])) continue;
    // agy 1.1.27 draws a blank row between the header and the first model.
    let first = i + 1;
    while (first < footer && lines[first].trim() === '') first++;
    const read = readOptionRows(lines, first, footer, PICKER_EFFORT_ROW_PATTERN);
    if (read === null) return null;
    return {
      screen: 'model-picker',
      question: lines[i].trim(),
      approvalTarget: null,
      options: read.options,
      selectedIndex: read.selectedIndex,
    };
  }
  return null;
}

function readSlashMenu(lines: readonly string[], footer: number): AntigravityArrowScreen | null {
  // Read upward from the footer: blank rows and the `↓ N more` row, then the
  // popup's rows, which end at the first row that is not one.
  let i = footer - 1;
  while (i >= 0 && (lines[i].trim() === '' || MORE_ROWS_PATTERN.test(lines[i]))) i--;
  const rows: string[] = [];
  const floor = Math.max(0, footer - SCREEN_MAX_ROWS);
  for (; i >= floor; i--) {
    if (!SLASH_ROW_PATTERN.test(lines[i])) break;
    rows.unshift(lines[i]);
  }
  if (rows.length < 2) return null;
  const highlighted = rows.filter(row => HIGHLIGHTED_ROW_PATTERN.test(row));
  if (highlighted.length !== 1) return null;
  return {
    screen: 'slash-menu',
    question: null,
    approvalTarget: null,
    options: rows.map(row => (SLASH_ROW_PATTERN.exec(row) as RegExpExecArray)[1]),
    selectedIndex: rows.findIndex(row => HIGHLIGHTED_ROW_PATTERN.test(row)),
  };
}

/**
 * Read the unnumbered agy screen that is open on this frame, or null.
 *
 * Null when no `↑/↓ Navigate` footer is open, and when the screen above it is
 * none of the three measured ones — a numbered dialog among them, which
 * `./dialog.ts` reads.
 *
 * @param text - ANSI-stripped frame
 */
export function readAntigravityArrowScreen(text: string): AntigravityArrowScreen | null {
  const lines = text.split('\n').map(row => row.trimEnd());
  const footer = openScreenFooter(lines);
  if (footer < 0) return null;
  return readTrust(lines, footer) ?? readModelPicker(lines, footer) ?? readSlashMenu(lines, footer);
}
