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
 * Must not import `../tmux/tmux`: the Auto-Yes poller's suppression step reads
 * {@link isLaunchDialogOpen} to leave these screens to the launch.
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
  safeRow: /^1\.\s+Trust folder\b/,
  key: 'Enter',
  liveRows: 20,
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
  cursorRow: /^\s*>\s+(\S.*?)\s*$/,
  safeRow: /^Yes, I trust this folder$/,
  key: 'Enter',
  liveRows: 12,
};

/** The last `count` non-blank rows of a screen, ANSI stripped and right-trimmed. */
function liveRowsOf(screen: string, count: number): string[] {
  const rows = stripAnsi(screen)
    .split('\n')
    .map((row) => row.trimEnd())
    .filter((row) => row.trim() !== '');
  return rows.slice(-count);
}

/** Index of the last live row asking the question, or -1. */
function lastQuestionRow(spec: LaunchDialogSpec, rows: readonly string[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (spec.question.test(rows[i])) return i;
  }
  return -1;
}

/**
 * Read one screen against a launch dialog's declaration (Issue #3776).
 *
 * The question must be among the last {@link LaunchDialogSpec.liveRows}
 * non-blank rows, and exactly one row below it must carry the cursor; the key
 * is pressed only when that row's label is the safe one.
 *
 * @param spec - The confirmation being looked for
 * @param screen - One capture of the pane (ANSI allowed)
 */
export function decideLaunchDialog(spec: LaunchDialogSpec, screen: string): LaunchDialogDecision {
  const rows = liveRowsOf(screen, spec.liveRows);
  const questionAt = lastQuestionRow(spec, rows);
  if (questionAt === -1) {
    return rows.some((row) => spec.signature.test(row))
      ? { action: 'unrecognized', reason: 'question-not-found' }
      : { action: 'absent' };
  }

  const cursorLabels: string[] = [];
  for (const row of rows.slice(questionAt + 1)) {
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
 * Whether the dialog's question is live on the screen, wherever its cursor is
 * (Issue #3776). The Auto-Yes poller leaves such a screen to the launch: its
 * rules answer the cursor row (`isDefault`), which on `3. Don't trust` is the
 * very answer the launch refuses to give.
 */
export function isLaunchDialogOpen(spec: LaunchDialogSpec, screen: string): boolean {
  return lastQuestionRow(spec, liveRowsOf(screen, spec.liveRows)) !== -1;
}
