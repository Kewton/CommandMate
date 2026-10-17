/**
 * Startup confirmations a launch answers by itself (Issue #3776).
 *
 * gemini and agy each ask a folder-trust question before their prompt comes
 * up, and their launch used to answer it with a blind Enter as soon as the
 * question's wording was anywhere on the screen. An Enter confirms whichever
 * row the cursor is on, so a cursor on `Don't trust` / `No, exit` wrote that
 * answer for good (gemini's `trustedFolders.json`), and a question whose
 * wording had changed (gemini v0.62.0) was never answered at all, silently.
 *
 * Each confirmation is declared once here — its question, the row that is safe
 * to confirm, how its cursor row looks and the key that confirms it — and
 * {@link decideLaunchDialog} reads one screen against that declaration: press,
 * leave it (the cursor is somewhere else), or "this looks like the dialog but
 * does not read as it" (the wording or the drawing changed). Pure: the caller
 * sends the key and writes the log.
 *
 * A screen counts as the dialog only when the question is followed, a few rows
 * down, by a block of the declared option rows (review of #3776): a reply that
 * quotes the question, a diff of this file, or another tool's permission
 * screen under a quoted question is not the dialog.
 *
 * Must not import `../tmux/tmux`: the Auto-Yes poller's suppression step reads
 * {@link isLaunchDialogOpen} / {@link decideLaunchDialog} to leave these
 * screens to the launch.
 *
 * @module lib/cli-tools/launch-dialog
 */

import { stripAnsi } from '../detection/cli-patterns';
import { ANTIGRAVITY_TRUST_DIALOG_PATTERN } from '../detection/tools/antigravity/patterns';

/** One startup confirmation, as the launch that answers it declares it. */
export interface LaunchDialogSpec {
  /** Stable name for logs and suppression records. */
  readonly id: string;
  /** The dialog's question. */
  readonly question: RegExp;
  /**
   * Option text only this dialog draws. Seen in the live rows without the
   * question, it means the wording changed: the launch leaves the screen alone
   * and logs it instead of passing it by in silence.
   */
  readonly signature: RegExp;
  /**
   * Any of the dialog's option rows, with or without a cursor (whatever glyph
   * it is drawn with), anchored at the row's start.
   */
  readonly optionRow: RegExp;
  /** How many option rows in a row make the block (fewer is not the dialog). */
  readonly minOptionRows: number;
  /** The option block starts within this many rows below the question. */
  readonly optionsWithin: number;
  /**
   * A row saying the dialog was answered (gemini's restart line). Rows above
   * the last such row are history: the dismissed dialog stays drawn there.
   */
  readonly dismissedRow?: RegExp;
  /** A row carrying the selection cursor; group 1 is the option label after it. */
  readonly cursorRow: RegExp;
  /** The option label (group 1 of {@link cursorRow}) that is safe to confirm. */
  readonly safeRow: RegExp;
  /** The key that confirms the cursor row. */
  readonly key: 'Enter';
  /**
   * How many non-blank rows at the bottom of the screen count as live. A
   * dismissed dialog stays in the pane above whatever came next, cursor and
   * all, so a question further up than this is history, not a screen.
   */
  readonly liveRows: number;
  /** Where the declaration lives, for the `unrecognized` log's hint. */
  readonly declaredIn: string;
}

/** What {@link decideLaunchDialog} read off one screen. */
export type LaunchDialogDecision =
  /** No sign of the dialog in the live rows. */
  | { readonly action: 'absent' }
  /** The question is live and the cursor is on the safe row: send `key` once. */
  | { readonly action: 'press'; readonly key: LaunchDialogSpec['key'] }
  /** The question is live and the cursor is on another row: send nothing. */
  | { readonly action: 'hold'; readonly reason: 'cursor-off-safe-row'; readonly cursorLabel: string }
  /** Something of the dialog is live, but it does not read as declared: send nothing. */
  | {
      readonly action: 'unrecognized';
      readonly reason: 'question-not-found' | 'cursor-not-found' | 'multiple-cursors';
    };

/** Longest cursor label a decision carries (it goes into logs). */
const MAX_CURSOR_LABEL_LENGTH = 80;

/**
 * gemini's folder-trust question (measured on v0.62.0, 2026-10-17, private
 * HOME, empty folder; `tests/fixtures/gemini-live-3776/`):
 *
 *   │ Do you trust the files in this folder?
 *   │ ● 1. Trust folder (<folder>)       <- cursor here by default
 *   │   2. Trust parent folder (<parent>)
 *   │   3. Don't trust
 *
 * Earlier builds asked `Do you trust this folder?` over the same three rows.
 * Only `1. Trust folder` is safe: `2.` trusts every sibling of the worktree.
 * One Enter on it makes gemini restart itself ("Gemini CLI is restarting to
 * apply the trust changes...") and, on a HOME that never signed in, draw the
 * authentication picker — whose default an extra Enter would confirm.
 */
export const GEMINI_TRUST_LAUNCH_DIALOG: LaunchDialogSpec = {
  id: 'gemini-folder-trust',
  question: /Do you trust (?:the files in )?this folder\?/,
  signature: /\bTrust folder\b|\bDon't trust\b/,
  cursorRow: /^[\s│]*●\s*(\S.*?)[\s│]*$/,
  optionRow: /^[\s│]*(?:\S\s+)?\d\.\s+(?:Trust folder|Trust parent folder|Don't trust)\b/,
  minOptionRows: 2,
  optionsWithin: 8,
  dismissedRow: /restarting to apply the trust changes/,
  safeRow: /^1\.\s+Trust folder\b/,
  key: 'Enter',
  // The dialog is 11 rows from its question to its lower border; the rest is
  // room for a notice or footer drawn under it.
  liveRows: 30,
  declaredIn: 'src/lib/cli-tools/launch-dialog.ts (GEMINI_TRUST_LAUNCH_DIALOG)',
};

/**
 * agy's folder-trust question (Issue #988;
 * `tests/fixtures/antigravity-live-2364/trust-dialog.txt`):
 *
 *   Do you trust the contents of this project?
 *   > Yes, I trust this folder   <- cursor here by default
 *     No, exit
 *   ↑/↓ Navigate · enter Confirm
 */
export const ANTIGRAVITY_TRUST_LAUNCH_DIALOG: LaunchDialogSpec = {
  id: 'antigravity-folder-trust',
  question: ANTIGRAVITY_TRUST_DIALOG_PATTERN,
  signature: /\bYes, I trust this folder\b/,
  optionRow: /^\s*(?:\S\s+)?(?:Yes, I trust this folder|No, exit)\s*$/,
  minOptionRows: 2,
  optionsWithin: 4,
  cursorRow: /^\s*>\s+(\S.*?)\s*$/,
  safeRow: /^Yes, I trust this folder$/,
  key: 'Enter',
  liveRows: 12,
  declaredIn: 'src/lib/cli-tools/launch-dialog.ts (ANTIGRAVITY_TRUST_LAUNCH_DIALOG)',
};

/** The last `count` non-blank rows of a screen, ANSI stripped and right-trimmed. */
function liveRowsOf(screen: string, count: number): string[] {
  const rows = stripAnsi(screen)
    .split('\n')
    .map((row) => row.trimEnd())
    .filter((row) => row.trim() !== '');
  return rows.slice(-count);
}

/** The rows below the last dismissal row (all of them when there is none). */
function rowsAfterDismissal(spec: LaunchDialogSpec, rows: readonly string[]): readonly string[] {
  if (!spec.dismissedRow) return rows;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (spec.dismissedRow.test(rows[i])) return rows.slice(i + 1);
  }
  return rows;
}

/** The option rows of the dialog asked at `questionAt`, or null if it has none. */
function optionBlockAfter(spec: LaunchDialogSpec, rows: readonly string[], questionAt: number): string[] | null {
  const last = Math.min(rows.length - 1, questionAt + spec.optionsWithin);
  for (let start = questionAt + 1; start <= last; start++) {
    if (!spec.optionRow.test(rows[start])) continue;
    const block: string[] = [];
    for (let i = start; i < rows.length && spec.optionRow.test(rows[i]); i++) block.push(rows[i]);
    return block.length >= spec.minOptionRows ? block : null;
  }
  return null;
}

/** The option rows under the last live question that has them, or null. */
function findDialog(spec: LaunchDialogSpec, rows: readonly string[]): string[] | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!spec.question.test(rows[i])) continue;
    const block = optionBlockAfter(spec, rows, i);
    if (block) return block;
  }
  return null;
}

/**
 * Read one screen against a launch dialog's declaration (Issue #3776).
 *
 * The question must be among the last {@link LaunchDialogSpec.liveRows}
 * non-blank rows, below any dismissal row, with its option block under it; the
 * key is pressed only when exactly one option row carries the cursor and its
 * label is the safe one.
 *
 * @param spec - The confirmation being looked for
 * @param screen - One capture of the pane (ANSI allowed)
 */
export function decideLaunchDialog(spec: LaunchDialogSpec, screen: string): LaunchDialogDecision {
  const rows = rowsAfterDismissal(spec, liveRowsOf(screen, spec.liveRows));
  const options = findDialog(spec, rows);
  if (!options) {
    return rows.some((row) => spec.signature.test(row))
      ? { action: 'unrecognized', reason: 'question-not-found' }
      : { action: 'absent' };
  }

  const cursorLabels: string[] = [];
  for (const row of options) {
    const match = spec.cursorRow.exec(row);
    if (match) cursorLabels.push(match[1]);
  }
  if (cursorLabels.length === 0) return { action: 'unrecognized', reason: 'cursor-not-found' };
  if (cursorLabels.length > 1) return { action: 'unrecognized', reason: 'multiple-cursors' };

  const label = cursorLabels[0];
  return spec.safeRow.test(label)
    ? { action: 'press', key: spec.key }
    : { action: 'hold', reason: 'cursor-off-safe-row', cursorLabel: label.slice(0, MAX_CURSOR_LABEL_LENGTH) };
}

/**
 * Whether the dialog — its question over its option block, not dismissed — is
 * live on the screen, wherever its cursor is (Issue #3776).
 */
export function isLaunchDialogOpen(spec: LaunchDialogSpec, screen: string): boolean {
  return findDialog(spec, rowsAfterDismissal(spec, liveRowsOf(screen, spec.liveRows))) !== null;
}

/**
 * Whether the dialog is drawn in the live rows, dismissed or not: a dialog
 * gemini answered stays on the screen, cursor and all, above its restart line
 * while the restart runs.
 */
export function isLaunchDialogDrawn(spec: LaunchDialogSpec, screen: string): boolean {
  return findDialog(spec, liveRowsOf(screen, spec.liveRows)) !== null;
}

/**
 * The warn a launch writes when it leaves the dialog alone, or null when the
 * decision sends or there is nothing to say. Never carries the screen.
 */
export function launchDialogWarning(
  spec: LaunchDialogSpec,
  decision: LaunchDialogDecision,
): { event: string; fields: Record<string, unknown> } | null {
  if (decision.action === 'absent' || decision.action === 'press') return null;
  if (decision.action === 'hold') {
    return { event: 'launch-dialog-held', fields: { dialog: spec.id, ...decision } };
  }
  return {
    event: 'launch-dialog-unrecognized',
    fields: {
      dialog: spec.id,
      ...decision,
      // Fail-closed by design; this warn is written once, so say what to look at.
      hint: `the dialog's wording or cursor drawing may have changed; compare the screen with ${spec.declaredIn}`,
    },
  };
}
