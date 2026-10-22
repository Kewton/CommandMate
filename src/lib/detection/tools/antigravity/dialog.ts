/**
 * Antigravity (agy)'s numbered permission dialogs, read on their own terms
 * (Issue #2364).
 *
 * ## What was measured (agy 1.1.27, pane 200x1000, 2026-09-06)
 *
 * `tests/fixtures/antigravity-live-2364/` holds the frames. The two that this
 * module exists for:
 *
 * | frame                     | question                        | options | shape                              |
 * |---------------------------|---------------------------------|---------|------------------------------------|
 * | `dialog-create-file.txt`  | `Allow creation of this file?`   | 2       | diff preview above the question    |
 * | `dialog-bash-wrapped.txt` | `Do you want to proceed?`        | 4       | options 2 and 3 wrap onto 3 rows   |
 *
 * Before this Issue the first resolved as `antigravity_selection_list`
 * (`hasActivePrompt: false`, so the chat surface drew an arrow pad and no
 * yes/no panel) because Issue #2270's discriminator was the sentence `Do you
 * want to proceed?`; the second passed the discriminator and then failed in the
 * generic multiple-choice parser, which reads one row per option, so the
 * `esc to cancel` status row fell through to the thinking pattern and the pane
 * was published as `running` / `thinking_indicator` — "generating", with `wait`
 * never returning. agy prints the command text inside the option label, so
 * every Bash approval of a multi-line command takes the second shape.
 *
 * ## What this reads
 *
 * The block between the nearest boundary row and the `↑/↓ Navigate` footer
 * ({@link locateAntigravityDialogRegion}), through the shared
 * {@link findNumberedOptionBlock}: a run of `N. label` rows descending to `1.`,
 * every non-numbered row folded into the label above it, the `>` gutter naming
 * the highlighted option. The question is the one `?`-terminated row directly
 * above option 1 — NOT the five rows the generic parser joins, which on the
 * file-creation menu put the diff preview into the question
 * (`…hello-agy.txt +1 1 + hello from antigravity Allow creation of this file?`).
 * The diff, the command and the panel header go to `instructionText`, where the
 * prompt panels render them as context.
 *
 * ## Who calls it
 *
 * Every producer of the wire, so that they cannot disagree about one screen:
 * `antigravity/detect.ts` (the status verdict `/current-output` publishes),
 * `polling/response-checker.ts` (`detectPromptOnCleanFrame` — the `prompt` row
 * the poller stores, the push notification it raises, AND the Auto-Yes poller's
 * reading) and the `prompt-response` route's re-verification.
 *
 * Issue #2364 left the Auto-Yes poller on the generic pass, on the premise that
 * agy's `PreToolUse` hook answers the permission request before the dialog is
 * drawn. Measured false (#2368): agy 1.1.27 ignores a hook `allow` in
 * interactive mode and draws the dialog anyway (#1779), so agy's Auto-Yes
 * depends entirely on this TUI reading — and without it every wrapped Bash
 * approval sat unanswered while `/current-output` published it as waiting.
 * #2368 put that poller on the same entry.
 *
 * Deliberately NOT a change to the generic multiple-choice parser: folding
 * continuation rows there would change what every other tool's dialogs read
 * as, and each of those readings is pinned to its own live captures.
 *
 * ## Input contract
 *
 * ANSI-stripped text; box drawing optional (the poller's copy has been through
 * `stripBoxDrawing`, the status path's has not, and the block is bounded the
 * same way on both — see {@link ANTIGRAVITY_DIALOG_BOUNDARY_PATTERN}).
 */

import {
  ANTIGRAVITY_DIALOG_BOUNDARY_PATTERN,
  ANTIGRAVITY_SWITCH_MODEL_HEADER_PATTERN,
  locateAntigravityDialogRegion,
} from '../../cli-patterns';
import {
  buildMultipleChoiceResult,
  findApprovalContextStart,
  joinApprovalTarget,
} from '../../prompt-detect-multiple-choice';
import { normalizeTuiFrameForDetection } from '../../tui-detection-frame';
import { findNumberedOptionBlock } from '../dialog-block';
import {
  ANTIGRAVITY_PERMISSION_FOOTER_PATTERN,
  ANTIGRAVITY_PROMPT_PATTERN,
} from './patterns';
import type { PromptDetectionResult } from '../../types';
import { truncateRawContent } from '../../truncate-raw-content';

/**
 * How many non-blank rows above option 1 may be searched for the question.
 *
 * On every measured frame the question is the row directly above option 1;
 * the allowance is for a blank row or a wrapped question, not for reaching up
 * into the diff preview.
 */
const QUESTION_SCAN_ROWS = 3;

/**
 * How far above the question the panel header may sit.
 *
 * The `●` tool-call row that opens the panel is what `instructionText` starts
 * under; the cap keeps a frame with no such row from carrying the whole
 * transcript into the panel text.
 */
const INSTRUCTION_LOOKBACK_ROWS = 40;

/**
 * How many non-blank rows under the bottom option row may be its wrapped tail.
 *
 * Handed to {@link findNumberedOptionBlock} as its footer scan, because the
 * region this reader hands it ends above the real footer. Sized well past the
 * three-row labels agy 1.1.27 draws; a command long enough to exceed it is
 * elided by agy itself (`pr...'`).
 */
const LAST_OPTION_TAIL_ROWS = 12;

/** The `●` tool-call row that opens every measured agy permission panel. */
const TOOL_CALL_ROW_PATTERN = /^\s*●\s/;

/** A horizontal rule; dropped from `instructionText`, where a 200-column rule is noise. */
const RULE_ROW_PATTERN = /^\s*─{3,}\s*$/;

/** A row that asks something — the shape the question row takes on every measured dialog. */
const QUESTION_ROW_PATTERN = /[?？]\s*$/;

/** What {@link readAntigravityNumberedDialog} found on a frame. */
export interface AntigravityNumberedDialog {
  /** The `?`-terminated row above option 1, or the nearest non-blank row when none ends in one. */
  readonly question: string;
  /** Option labels in draw order, wrapped rows folded in; index 0 is option `1.`. */
  readonly options: readonly string[];
  /** Index into {@link options} of the row wearing the `>` gutter, or -1. */
  readonly selectedIndex: number;
  /** Absolute row index of the question row. */
  readonly questionRow: number;
  /** Absolute row index of option 1's own row. */
  readonly firstOptionRow: number;
  /** Absolute row index of the `↑/↓ Navigate` footer. */
  readonly footerRow: number;
}

/**
 * Read agy's numbered dialog off ANSI-stripped rows.
 *
 * Null when the frame has no `↑/↓ Navigate` footer, when that footer is not a
 * permission dialog's `… · tab Amend` one (the login-method screen, a footer a
 * narrow pane cut — Issue #3808), when the rows above it do
 * not form a numbered run reaching `1.` (the Switch Model picker, the trust
 * screen, the slash popup), or when the block sits under a `Switch Model`
 * header. A caller that has already passed `isAntigravityNumberedDialog` and
 * still gets null here is looking at a numbered dialog this reader cannot
 * parse — which is an unclassified frame, not a picker.
 */
export function readAntigravityNumberedDialog(lines: readonly string[]): AntigravityNumberedDialog | null {
  const region = locateAntigravityDialogRegion(lines);
  if (region === null) return null;
  // Issue #3808: only a permission dialog's footer vouches for the block —
  // see ANTIGRAVITY_PERMISSION_FOOTER_PATTERN.
  if (!ANTIGRAVITY_PERMISSION_FOOTER_PATTERN.test(lines[region.footer])) return null;

  const regionRows = lines.slice(region.start, region.footer);
  if (regionRows.some(row => ANTIGRAVITY_SWITCH_MODEL_HEADER_PATTERN.test(row))) return null;

  // The slice stops ABOVE the footer row, so the rows the block reader files
  // as `footer` — the non-option rows between the bottom option and the region
  // end — are the wrapped tail of the LAST option, not chrome: agy 1.1.27 draws
  // `6. No, and always deny for commands that start with '<cmd>` over three
  // rows on a repeated denial (`dialog-bash-wrapped-six.txt`), and the
  // `↑/↓ Navigate` footer this region is anchored on already vouched for the
  // block. Every other row of the region above the block is question / preview
  // and never reached (the run stops at `1.`).
  const block = findNumberedOptionBlock(regionRows, regionRows.length, LAST_OPTION_TAIL_ROWS);
  if (block === null) return null;

  const options = [...block.options];
  if (block.footer !== '') {
    const last = options.length - 1;
    options[last] = [options[last], ...block.footer.split('\n')].join(' ').trim();
  }

  const firstOptionRow = region.start + block.firstRow;

  // The question: the nearest `?`-terminated row above option 1, looking past
  // blank rows and at most QUESTION_SCAN_ROWS non-blank ones, none of which
  // may be a boundary (that would be the previous turn, not this panel).
  let questionRow = -1;
  let fallbackRow = -1;
  let scanned = 0;
  for (let i = firstOptionRow - 1; i >= region.start && scanned < QUESTION_SCAN_ROWS; i--) {
    const row = lines[i];
    if (row.trim() === '') continue;
    if (ANTIGRAVITY_DIALOG_BOUNDARY_PATTERN.test(row) || RULE_ROW_PATTERN.test(row)) break;
    scanned++;
    if (fallbackRow < 0) fallbackRow = i;
    if (QUESTION_ROW_PATTERN.test(row)) {
      questionRow = i;
      break;
    }
  }
  if (questionRow < 0) questionRow = fallbackRow;

  return {
    question: questionRow < 0 ? 'Please select an option:' : lines[questionRow].trim(),
    options,
    selectedIndex: block.selectedIndex,
    questionRow: questionRow < 0 ? firstOptionRow : questionRow,
    firstOptionRow,
    footerRow: region.footer,
  };
}

/**
 * The panel text above the options, for the prompt panels' context box.
 *
 * From the row under the `●` tool-call row that opened the panel (`Command`,
 * `Create file`, the `Requesting permission for:` block, the diff preview),
 * through the question, the options and the footer — rules dropped. Falls back
 * to the dialog region when no tool-call row is within reach.
 */
function extractInstructionText(lines: readonly string[], dialog: AntigravityNumberedDialog): string | undefined {
  const region = locateAntigravityDialogRegion(lines);
  let start = region?.start ?? dialog.questionRow;
  const floor = Math.max(0, dialog.questionRow - INSTRUCTION_LOOKBACK_ROWS);
  for (let i = dialog.questionRow - 1; i >= floor; i--) {
    if (TOOL_CALL_ROW_PATTERN.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  const text = lines
    .slice(start, dialog.footerRow + 1)
    .filter(row => !RULE_ROW_PATTERN.test(row))
    .map(row => row.trimEnd())
    .join('\n')
    .trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Read agy's numbered dialog as the `multiple_choice` prompt the rest of the
 * system consumes, or null when the frame does not carry one.
 *
 * The result has the same shape `detectPrompt` produces for a numbered dialog
 * — `promptData.type === 'multiple_choice'`, `options[].isDefault` on the
 * highlighted row, `instructionText` / `approvalTarget` / `rawContent` filled
 * the way Issues #235 and #1699 defined them — so `PromptPanel`,
 * `MobilePromptSheet`, `respond`, the deny patterns and the prompt-history
 * writers all read it unchanged.
 *
 * @param text - ANSI-stripped capture, box drawing optional
 */
export function detectAntigravityNumberedDialogPrompt(text: string): PromptDetectionResult | null {
  const normalized = normalizeTuiFrameForDetection(text);
  const lines = normalized.split('\n');
  const dialog = readAntigravityNumberedDialog(lines);
  if (dialog === null) return null;

  return buildMultipleChoiceResult(
    dialog.question,
    dialog.options.map((label, index) => ({
      number: index + 1,
      label,
      isDefault: index === dialog.selectedIndex,
    })),
    {
      instructionText: extractInstructionText(lines, dialog),
      // Issue #1699's machine-facing surface: bounded above at the previous
      // turn's boundary and below at the footer, so the command in the
      // `Requesting permission for:` block and in the labels is judged and
      // nothing from an earlier, already-answered approval is.
      approvalTarget: joinApprovalTarget(
        lines,
        findApprovalContextStart(lines, dialog.questionRow, dialog.footerRow),
        dialog.footerRow,
      ),
    },
    normalized,
    truncateRawContent,
  );
}

/**
 * agy's `/feedback` category menu footer (`esc Cancel · 1-6 Select & Continue ·
 * enter Continue`, `antigravity-live-2364/dialog-feedback-category.txt`): the
 * one numbered agy screen the generic parser is left to read (#2364).
 */
/** A numbered option row (`> 1. Yes`, `  2. No`): the `>` cursor, then the number. */
const OPTION_ROW_PATTERN = /^\s*(>)?\s*(\d+)\.\s+\S/;

/**
 * agy's `/feedback` category menu footer (`esc Cancel · 1-6 Select & Continue ·
 * enter Continue`, `antigravity-live-2364/dialog-feedback-category.txt`): the
 * one numbered agy screen the generic parser is left to read (#2364). Anchored
 * at the row start and matched only on the first row under the last option,
 * so the same words inside an option label or a quoted command never match.
 */
const FEEDBACK_MENU_FOOTER_PATTERN = /^\s*esc Cancel\s*·\s*\d+-\d+\s+Select\b/;

/** How far above the bottom option row the run down from `1.` may reach. */
const OPTION_RUN_MAX_ROWS = 40;

/**
 * Is this an agy screen with numbered options that the permission reader does
 * NOT vouch for? (Issue #3808)
 *
 * True when the frame ends on a run of options numbered `1.` … `N.` (N ≥ 2,
 * consecutive, wrapped label rows allowed between them, no boundary row
 * inside) with one row wearing agy's `>` cursor, no `>` composer drawn under
 * the run — agy paints none while a screen replaces it, so the options are the
 * live screen's, not a reply's (a reply's list wears no cursor either) — and
 * {@link readAntigravityNumberedDialog} does not read the frame (no complete
 * `↑/↓ Navigate · tab Amend` footer: the login-method screen, a footer a narrow
 * pane cut at `↑/↓ Nav`, or one below the pane altogether). Deliberately
 * independent of the footer, so a footer that is not on screen cannot hand the
 * frame back to the generic parser. A single `> 1. …` row — a sent message
 * echoed above the spinner — is not a run.
 *
 * False for the `/feedback` menu (its `esc Cancel · 1-6 Select` footer directly
 * under the last option), which keeps the generic reading #2364 left it.
 *
 * Callers treat true as "no prompt to answer": a human drives the screen.
 *
 * @param text - ANSI-stripped capture, box drawing optional
 */
export function isAntigravityUnvouchedNumberedScreen(text: string): boolean {
  const lines = normalizeTuiFrameForDetection(text).split('\n');
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ANTIGRAVITY_PROMPT_PATTERN.test(lines[i])) return false;
    if (OPTION_ROW_PATTERN.test(lines[i])) {
      last = i;
      break;
    }
  }
  if (last < 0) return false;

  // The run, read upward from the bottom option: N., N-1., … 1.
  let expected = Number(OPTION_ROW_PATTERN.exec(lines[last])![2]);
  if (expected < 2) return false;
  let highlighted = OPTION_ROW_PATTERN.exec(lines[last])![1] !== undefined;
  const floor = Math.max(0, last - OPTION_RUN_MAX_ROWS);
  for (let i = last - 1; i >= floor && expected > 1; i--) {
    const match = OPTION_ROW_PATTERN.exec(lines[i]);
    if (match === null) {
      if (ANTIGRAVITY_DIALOG_BOUNDARY_PATTERN.test(lines[i])) return false;
      continue;
    }
    if (Number(match[2]) !== expected - 1) return false;
    expected--;
    if (match[1] !== undefined) highlighted = true;
  }
  if (expected !== 1 || !highlighted) return false;

  const footer = lines.slice(last + 1).find(row => row.trim() !== '');
  if (footer !== undefined && FEEDBACK_MENU_FOOTER_PATTERN.test(footer)) return false;
  return readAntigravityNumberedDialog(lines) === null;
}
