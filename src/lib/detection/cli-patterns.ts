/**
 * Common CLI tool patterns for response detection
 * Shared between response-poller.ts and API routes
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type { DetectPromptOptions } from './types';
import { createLogger } from '@/lib/logger';
import { stripAnsi } from './ansi';
import { findClaudeInputBox } from './composer-text';
import { THINKING_TAIL_LINE_COUNT } from '@/config/thinking-constants';

const logger = createLogger('cli-patterns');

/**
 * Claude CLI spinner characters (expanded set)
 * These are shown when Claude is thinking/processing
 */
export const CLAUDE_SPINNER_CHARS = [
  '✻', '✽', '⏺', '·', '∴', '✢', '✳', '✶',
  '⦿', '◉', '●', '○', '◌', '◎', '⊙', '⊚',
  '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', // Braille spinner
];

/**
 * Claude thinking pattern
 * Matches spinner character followed by activity text ending with …
 * The text can contain spaces (e.g., "Verifying implementation (dead code detection)…")
 *
 * Alternative 2: "esc to interrupt" status bar text (Issue #188)
 * Claude Code shows "esc to interrupt" in the terminal status bar during active processing.
 * Previous pattern required closing paren `to interrupt\)` matching `(esc to interrupt)`,
 * but Claude Code v2.x status bar format uses `· esc to interrupt ·` without parens.
 * Updated to match `esc to interrupt` which covers both formats.
 */
export const CLAUDE_THINKING_PATTERN = new RegExp(
  `[${CLAUDE_SPINNER_CHARS.join('')}]\\s+.+…|esc to interrupt`,
  'm'
);

/**
 * Claude status-bar "esc to interrupt" hint (Issue #805)
 *
 * Claude Code shows "esc to interrupt" in the bottom status bar ONLY while it is
 * actively processing. When idle/ready, the status bar shows shortcut hints
 * (e.g., "? for shortcuts") instead -- so this token is a reliable "running" signal.
 *
 * Why this exists separately from CLAUDE_THINKING_PATTERN's "esc to interrupt"
 * alternative: status detection evaluates the spinner+ellipsis branch of
 * CLAUDE_THINKING_PATTERN within a narrow 5-line window (THINKING_TAIL_LINE_COUNT)
 * to avoid mistaking a completed thinking summary in scrollback for active work
 * (Issue #188). During /pm-auto-dev + subagent runs, the bottom task panel
 * ("⏺ main" / "◯ general-purpose ..." rows) pushes both the "✶ Running…" spinner
 * AND the "esc to interrupt" status bar out of that 5-line window, so the session
 * was misdetected as Ready (Issue #805). Unlike the spinner+ellipsis summary, the
 * status-bar text is repainted live and never lingers in scrollback, so it can be
 * matched in a wider footer window without regressing Issue #188.
 */
export const CLAUDE_INTERRUPT_HINT_PATTERN = /esc to interrupt/;

/**
 * Codex activity-marker pattern
 * Matches activity indicators like "• Planning", "• Searching", etc.
 * T1.1: Extended to include "Ran" and "Deciding"
 *
 * Issue #1671: these are *transcript records*, not a liveness signal. Codex is
 * inline-rendered (no alternate screen), so every "• Ran <cmd>" / "• Running
 * <cmd>" step it ever printed stays in the pane scrollback forever — measured on
 * a live `mcbd-codex-*` pane: 396 "• Ran" and 11 "• Running" rows, all of them
 * from finished steps. Matching this pattern against a fixed tail window
 * therefore answers "did a step happen recently", not "is Codex working now".
 * Use {@link isCodexTurnActive} for the latter.
 */
export const CODEX_THINKING_PATTERN = /•\s*(Planning|Searching|Exploring|Running|Thinking|Working|Reading|Writing|Analyzing|Ran|Deciding)/m;

/**
 * Codex live status-line hint (Issue #1671)
 *
 * While a turn is in flight Codex pins a status row directly above the composer:
 *
 *     • Working (13s • esc to interrupt) · 1 background terminal running · /ps to view
 *
 * It is repainted in place every tick and erased the moment the turn ends, so —
 * unlike the "• Ran"/"• Running" step records — it never lingers in scrollback.
 * Measured on a 11,000-line capture of an idle Codex pane: zero occurrences of
 * "esc to interrupt", against 396 lingering "• Ran" rows. That makes it the one
 * unambiguous "Codex is still generating" token, mirroring Claude's
 * {@link CLAUDE_INTERRUPT_HINT_PATTERN}.
 */
export const CODEX_INTERRUPT_HINT_PATTERN = /esc to interrupt/;

/**
 * How far above the last content row Codex's composer ("› …") may sit.
 *
 * Codex pins the composer and the status bar to the bottom of the pane, so the
 * composer lands 2-3 rows above the last non-blank row in every observed frame.
 * The small allowance keeps the search from walking up into the transcript and
 * latching onto the echoed user message, which uses the same "› " marker.
 */
const CODEX_COMPOSER_SEARCH_ROWS = 8;

/**
 * Decide whether a Codex turn is still in flight (Issue #1671).
 *
 * Completion detection used to answer this with {@link CODEX_THINKING_PATTERN}
 * over a fixed 20-row tail. Because "• Ran <cmd>" is a *past-tense record* that
 * never leaves the transcript, a turn that ended with a short final message kept
 * that record inside the tail window and was reported as "still thinking"
 * forever — so its reply was never saved, while a turn whose final message
 * happened to be longer than 20 rows pushed the record out of the window and was
 * saved. Whether a reply reached Message History depended on how long it was.
 *
 * Two signals, both measured against live codex-cli 0.146.0 captures:
 *
 * 1. The live status line ({@link CODEX_INTERRUPT_HINT_PATTERN}) anywhere in the
 *    tail window. Present in every generating frame from 1s onwards, absent from
 *    every idle frame.
 * 2. An activity marker in the rows immediately above the composer — the band
 *    Codex reserves for that status line. Version-agnostic backstop for a Codex
 *    build whose status row drops the "esc to interrupt" wording; deliberately
 *    narrow (THINKING_TAIL_LINE_COUNT rows, matching the window status-detector
 *    already uses) so records further up the transcript cannot reach it.
 *
 * When no composer can be located the frame is not a normal Codex layout (an
 * overlay is up, or the pane is mid-redraw), so signal 2 falls back to the whole
 * tail window — the pre-#1671 behaviour, which errs towards "still active".
 *
 * @param lines - Captured pane lines with trailing blank rows already trimmed
 * @param tailLineCount - Size of the tail window completion detection looks at
 * @returns True while Codex is still generating
 */
export function isCodexTurnActive(lines: string[], tailLineCount: number): boolean {
  const tailWindow = stripAnsi(lines.slice(Math.max(0, lines.length - tailLineCount)).join('\n'));

  // 1. Live status line — unambiguous, never survives the end of a turn.
  if (CODEX_INTERRUPT_HINT_PATTERN.test(tailWindow)) return true;

  // 2. Activity marker in the status-line band directly above the composer.
  //    Searched bottom-up so the composer wins over the echoed user message.
  let composerIndex = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - CODEX_COMPOSER_SEARCH_ROWS); i--) {
    if (CODEX_PROMPT_PATTERN.test(stripAnsi(lines[i]))) {
      composerIndex = i;
      break;
    }
  }

  if (composerIndex < 0) return CODEX_THINKING_PATTERN.test(tailWindow);

  const bandStart = Math.max(0, composerIndex - THINKING_TAIL_LINE_COUNT + 1);
  const band = stripAnsi(lines.slice(bandStart, composerIndex + 1).join('\n'));
  return CODEX_THINKING_PATTERN.test(band);
}

/**
 * Claude prompt pattern (waiting for input)
 * Supports both legacy '>' and new '❯' (U+276F) prompt characters
 * Issue #132: Also matches prompts with recommended commands (e.g., "❯ /work-plan")
 *
 * Matches:
 * - Empty prompt: "❯ " or "> "
 * - Prompt with command: "❯ /work-plan" or "> npm install"
 */
export const CLAUDE_PROMPT_PATTERN = /^[>❯](\s*$|\s+\S)/m;

/**
 * Claude separator pattern
 */
export const CLAUDE_SEPARATOR_PATTERN = /^─{10,}$/m;

/**
 * Locate the start of Claude Code's bottom-pinned footer within a captured pane.
 *
 * Claude Code v2 draws in the alternate screen and reserves the last rows of the
 * pane for a footer that is never transcript content:
 *
 *     <hint row>            ← "◉ xhigh · /effort", "tmux detected · …", or blank
 *     ────────────────────  ← separator
 *     ❯ <input box>         ← one or more rows
 *     ────────────────────  ← separator
 *     ⏸ manual mode on · ? for shortcuts · ← for agents        focus
 *
 * The hint row rotates every few seconds while the conversation sits idle, so
 * keeping the footer in an extracted response makes its content hash change on
 * every poll tick. That defeated the content-based dedup added in #1268 and
 * re-saved the same reply once per tick (#1289).
 *
 * The boundary is found structurally rather than by matching hint text: the hint
 * strings are Claude Code's to change, and pattern-matching them is what let this
 * regression through (`? for shortcuts` was already listed as a skip pattern, but
 * the real status bar embeds it mid-line so the anchors never matched). The row
 * above the opening separator is reserved by Claude Code's layout and stays blank
 * even when a reply fills the whole pane, so it is always safe to drop.
 *
 * @param lines - Captured pane lines; trailing blank rows are tolerated
 * @returns Index of the first footer row, or -1 when no footer is present
 */
export function findClaudeChromeStart(lines: string[]): number {
  // Issue #1879: the structural search (closing separator → opening separator →
  // prompt glyph, including the "is this really the input box and not a reply
  // fenced by two horizontal rules?" check) moved to `findClaudeInputBox` so the
  // composer reader locates the same box this trimmer does. Behaviour here is
  // unchanged; only the caller of the search moved.
  const box = findClaudeInputBox(lines);
  if (box === null) return -1;

  // Include the reserved hint row directly above the opening separator.
  return Math.max(0, box.openingSeparator - 1);
}

/**
 * Claude trust dialog pattern (Issue #201)
 *
 * Matches the "Quick safety check" dialog displayed by Claude CLI v2.x
 * when accessing a workspace for the first time.
 *
 * Intentionally uses partial matching (no line-start anchor ^):
 * Other pattern constants (CLAUDE_PROMPT_PATTERN, CLAUDE_SEPARATOR_PATTERN, etc.)
 * use line-start anchors (^), but this pattern needs to match at any position
 * within the tmux output buffer because the dialog text may appear after
 * tmux padding or other output. (SF-001)
 */
export const CLAUDE_TRUST_DIALOG_PATTERN = /Yes, I trust this folder/m;

/**
 * Codex prompt pattern
 * T1.2: Improved to detect empty prompts as well
 */
export const CODEX_PROMPT_PATTERN = /^›\s*/m;

/**
 * Codex INTERACTIVE startup dialog pattern (Issue #890)
 *
 * Codex shows interactive update-notification and trust dialogs on first launch.
 * Their currently-selected option lines render as "› 1. Update now", which ALSO
 * matches CODEX_PROMPT_PATTERN (the bare "^›" input-prompt pattern). So "is the
 * input prompt ready?" cannot be decided by CODEX_PROMPT_PATTERN alone -- it must
 * also confirm no INTERACTIVE dialog is still active. This pattern matches markers
 * that appear ONLY in interactive dialogs:
 *   - Interactive update dialog: "Skip until next version" (the option-3 label)
 *   - Trust dialog:              "Do you trust the contents of this directory?"
 *   - Dialog confirm footer:     "Press enter to continue"
 *   - Numbered selection option: "› 1. ..." (leading ›, a digit, a dot)
 *
 * IMPORTANT (Issue #890 regression): the substring "Update available" is
 * deliberately NOT a marker. After the update is skipped, codex keeps a
 * non-interactive banner box ("✨ Update available! ... / Run npm install -g
 * @openai/codex to update.") rendered ABOVE the genuine "› " prompt. Matching
 * "Update available" would make isCodexPromptReady() return false for as long as
 * that banner is visible, hanging waitForReady (~30s) and waitForPrompt (15s) on
 * exactly the first-launch + update-pending case this fix targets. The interactive
 * update dialog is still reliably detected via its other three markers above
 * ("› 1. Update now" + "Skip until next version" + "Press enter to continue").
 *
 * No /g flag (would make .test() stateful); no nested quantifiers (ReDoS-safe).
 */
export const CODEX_DIALOG_PATTERN =
  /Skip until next version|Do you trust|Press enter to continue|^\s*›\s*\d+\.\s/m;

/**
 * Codex genuine input-prompt line (Issue #892).
 *
 * A line whose first non-space glyph is "›" but which is NOT a numbered dialog
 * option ("› 1. ..."). The selected dialog option renders "›" at column 0 too
 * (same column as the live prompt), so the digit-dot negative lookahead is what
 * distinguishes the genuine input line from a dialog option line. Single-line
 * (no /m, no /g) -- callers test it per line to locate the prompt's position.
 */
const CODEX_GENUINE_PROMPT_LINE = /^\s*›(?!\s*\d+\.)/;

/**
 * Decide whether Codex output shows a genuine interactive input prompt rather than
 * a startup dialog (Issue #890, reworked in Issue #892).
 *
 * POSITION-based: capturePane(50) returns scrollback, so a dismissed update/trust
 * dialog lingers ABOVE the live prompt. The original Issue #890 form
 * (`CODEX_PROMPT_PATTERN && !CODEX_DIALOG_PATTERN`) is a whole-window test, so a
 * residual dialog line anywhere in the frame keeps it false forever -- hanging
 * waitForReady/waitForPrompt and (via the re-firing branches) injecting "222...".
 *
 * Instead the frame is ready when a genuine input-prompt line sits BELOW every
 * interactive dialog marker -- i.e. the prompt is the bottom-most active element.
 * CODEX_PROMPT_PATTERN / CODEX_DIALOG_PATTERN are intentionally unchanged here
 * (status-detector.ts / response-checker.ts depend on them).
 *
 * Used by both CodexTool.waitForReady() (startup) and CodexTool.waitForPrompt()
 * (before every send) so a residual dialog is never mistaken for "ready" and, just
 * as importantly, a genuine prompt below stale dialog scrollback IS detected.
 */
export function isCodexPromptReady(output: string): boolean {
  const lines = output.split('\n');
  let lastDialogMarkerIdx = -1;
  let lastPromptIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (CODEX_DIALOG_PATTERN.test(line)) {
      // A dialog marker/option line is never itself a genuine prompt.
      lastDialogMarkerIdx = i;
      continue;
    }
    if (CODEX_GENUINE_PROMPT_LINE.test(line)) {
      lastPromptIdx = i;
    }
  }
  return lastPromptIdx >= 0 && lastPromptIdx > lastDialogMarkerIdx;
}

/**
 * The bottom-most active Codex startup dialog awaiting a key press (Issue #892).
 * `null` means no dialog needs handling -- either none is present, or the only
 * dialog text is residual scrollback above a genuine prompt.
 */
export type CodexActiveDialog = 'update' | 'press-enter' | 'trust' | null;

/**
 * Classify the bottom-most active Codex startup dialog (Issue #892).
 *
 * POSITION-based companion to isCodexPromptReady(): only dialog text appearing
 * BELOW the genuine input-prompt line is considered "active". Dialog lines that
 * remain in scrollback ABOVE a live prompt are ignored, so a dismissed dialog is
 * never re-acted on (this is what stops the update branch from re-sending "2" once
 * the dialog has been skipped -- the root cause of the "222..." prefix).
 *
 * Precedence matches CodexTool.waitForReady()'s historical branch order: the
 * update dialog wins over its own "Press enter to continue" footer, because Enter
 * on the update dialog could confirm the default "1. Update now" (npm install).
 */
/**
 * The lines of Codex's ACTIVE region: everything strictly below the bottom-most
 * genuine input-prompt line, or the whole frame when there is no prompt line
 * (Issue #892).
 *
 * This is the one rule that keeps every Codex dialog classifier honest.
 * capturePane returns scrollback, so a dialog that was answered minutes ago is
 * still in the frame; only what sits BELOW the live prompt is still awaiting a
 * key. Shared by getCodexActiveDialog and getCodexLifecycleDialog so the two
 * cannot drift into disagreeing about what "active" means.
 */
function codexActiveRegionLines(output: string): string[] {
  const lines = output.split('\n');
  // Index of the bottom-most genuine input-prompt line (-1 if none).
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CODEX_GENUINE_PROMPT_LINE.test(lines[i])) {
      promptIdx = i;
      break;
    }
  }
  return lines.slice(promptIdx + 1);
}

export function getCodexActiveDialog(output: string): CodexActiveDialog {
  // Residual dialog text above a live prompt is excluded, so a dialog lingering
  // in scrollback is never treated as active.
  const active = codexActiveRegionLines(output).join('\n');
  if (active === '') {
    return null;
  }
  if (
    active.includes('Skip until next version') ||
    (active.includes('Update') && active.includes('Skip'))
  ) {
    return 'update';
  }
  if (active.includes('Do you trust')) {
    return 'trust';
  }
  if (active.includes('Press enter to continue')) {
    return 'press-enter';
  }
  return null;
}

/**
 * Anchors of codex's "Hooks need review" launch dialog — screen 1 of the three
 * it can put in front of a session (Issue #1760, re-measured on codex-cli
 * 0.148.0 for Issue #1829):
 *
 * ```
 *  Hooks need review
 *  4 hooks are new or changed.
 *  Hooks can run outside the sandbox after you trust them.
 *
 * > 1. Review hooks
 *   2. Trust all and continue
 *   3. Continue without trusting (hooks won't run)
 *   Press enter to confirm or esc to go back
 * ```
 *
 * The hook COUNT is data — 0.147.0 said 5, 0.148.0 said 4 — so neither anchor
 * reads it. Both strings are required so a "hooks" mention elsewhere cannot
 * select an option on a live prompt.
 */
export const CODEX_HOOKS_REVIEW_ANCHORS = ['Hooks need review', 'Continue without trusting'] as const;

/**
 * Footer of screen 2, the hooks LIST, new in codex-cli 0.148.0 (Issue #1829):
 * `Press t to trust all; enter to review hooks; esc to close`.
 *
 * The semicolon is what separates it from screen 3's footer — "trust all;" and
 * "trust;" are disjoint — and matching the footer rather than the table above it
 * keeps the two screens distinguishable by a single line each.
 */
const CODEX_HOOKS_LIST_FOOTER_PATTERN = /press\s+t\s+to\s+trust\s+all\s*;/i;

/**
 * Footer of screen 3, the per-hook review DETAIL (Issue #1829):
 * `Press t to trust; esc to go back`. Where both live sessions in the Issue were
 * found parked.
 */
const CODEX_HOOKS_DETAIL_FOOTER_PATTERN = /press\s+t\s+to\s+trust\s*;/i;

/**
 * A screen codex puts up around a session's LIFECYCLE rather than around the
 * work — one that `CodexTool.waitForReady` owns the answer to (Issue #1829).
 *
 * Wider than {@link CodexActiveDialog} in two directions: it covers the hooks
 * review dialog (which #890's classifier deliberately returns `null` for, its
 * wording matching none of that function's three anchors) and the two screens
 * that dialog leads to, which carry no numbered options at all.
 */
export type CodexLifecycleDialog =
  | 'hooks-review'
  | 'hooks-list'
  | 'hooks-detail'
  | 'update'
  | 'trust';

/**
 * How much of the active region {@link getCodexLifecycleDialog} judges, in
 * non-blank lines counted from the bottom (Issue #1829).
 *
 * `getCodexActiveDialog` searches the whole active region, which is right for
 * its caller: `waitForReady` only ever runs during `startSession`, when nothing
 * else can be on screen. This classifier runs on every Auto-Yes poll for the
 * life of the session, where "active region" alone is not enough — a codex
 * approval request renders no `› ` composer line, so an approval that comes up
 * while a dismissed hooks screen is still inside the capture window would have
 * the whole frame as its active region and would be mistaken for the dialog.
 * Requiring the dialog to be in the TAIL is what separates the screen the user
 * is looking at from the one they have already left.
 *
 * 12 lines fits the tallest screen this has to recognise (the review dialog's
 * two anchors sit 6 lines apart) and none of the shorter frames below it.
 */
const CODEX_LIFECYCLE_TAIL_LINES = 12;

/**
 * The interactive update dialog, by its option-3 label or its option-1 line.
 *
 * Deliberately stricter than `getCodexActiveDialog`'s `Update` AND `Skip`
 * fallback: that pair can occur in ordinary agent output, and here a false
 * positive silently stops Auto-Yes answering a real prompt. Both anchors below
 * are dialog chrome that agent output does not produce.
 */
const CODEX_UPDATE_DIALOG_ANCHORS = [
  /skip until next version/i,
  /^\s*[›❯]?\s*\d+\.\s*Update now/im,
] as const;

/** The directory-trust dialog's question line. */
const CODEX_TRUST_DIALOG_ANCHOR = /Do you trust/;

/**
 * Classify the bottom-most ACTIVE codex lifecycle screen (Issue #1829).
 *
 * Position-based, via {@link codexActiveRegionLines}: a dialog left in
 * scrollback above a live prompt is not active and returns `null`. That is not
 * a detail — the auto-answer guard in the Auto-Yes poller is built on this
 * function, and a whole-frame version of it would switch Auto-Yes off for the
 * rest of a codex session the moment any launch dialog scrolled past.
 *
 * The two hooks screens are matched FIRST and bottom-up, because a stuck pane
 * holds screen 2 above screen 3 and the way out of each differs. The remaining
 * three are region-level substring tests, which is all their anchors allow:
 * the review dialog's are on two different lines.
 *
 * Deliberately NOT used to decide whether a prompt exists. `detectPrompt` still
 * reports these screens, so a human still sees them; what this function gates is
 * only whether a machine may answer on their behalf.
 *
 * @param output - ANSI-stripped pane capture
 * @returns The active lifecycle screen, or null when none is
 */
export function getCodexLifecycleDialog(output: string): CodexLifecycleDialog | null {
  const activeLines = codexActiveRegionLines(output);
  const window: string[] = [];
  for (let i = activeLines.length - 1; i >= 0 && window.length < CODEX_LIFECYCLE_TAIL_LINES; i--) {
    if (activeLines[i].trim() === '') continue;
    window.unshift(activeLines[i]);
  }
  if (window.length === 0) return null;
  const text = window.join('\n');

  // One bottom-up pass, returning on the first line that decides the question --
  // including the lines that decide it NEGATIVELY. A stuck pane holds screen 2
  // above screen 3, and an approval request can come up with a hooks screen
  // still inside the capture window; in both cases the screen the user is
  // looking at is the lower one.
  for (let i = window.length - 1; i >= 0; i--) {
    const line = window[i];
    if (CODEX_HOOKS_LIST_FOOTER_PATTERN.test(line)) return 'hooks-list';
    if (CODEX_HOOKS_DETAIL_FOOTER_PATTERN.test(line)) return 'hooks-detail';
    // The agent asking the human for permission mid-turn (Issue #1628's
    // "esc to cancel" footer, which no lifecycle screen wears). This is exactly
    // the prompt Auto-Yes exists to answer, so whatever lifecycle text is still
    // above it has been left behind and must not withhold the answer.
    if (CODEX_APPROVAL_FOOTER_PATTERN.test(line)) return null;
    if (CODEX_UPDATE_DIALOG_ANCHORS.some((pattern) => pattern.test(line))) return 'update';
    if (CODEX_TRUST_DIALOG_ANCHOR.test(line)) return 'trust';
    // Both anchors required, so a stray "hooks" mention cannot claim the screen.
    if (line.includes(CODEX_HOOKS_REVIEW_ANCHORS[1]) && text.includes(CODEX_HOOKS_REVIEW_ANCHORS[0])) {
      return 'hooks-review';
    }
  }
  return null;
}

/**
 * Codex separator pattern
 */
export const CODEX_SEPARATOR_PATTERN = /^─.*Worked for.*─+$/m;

/**
 * Codex CLI selection list footer pattern (Issue #619, #622)
 * Detects Codex CLI's interactive selection prompts that use arrow key
 * navigation (e.g., /model command's model and reasoning level selection steps).
 *
 * Matches:
 *   - Step 1 (model selection): "Press enter to select reasoning effort, or esc to dismiss."
 *   - Step 2 (reasoning level): "Press enter to confirm or esc to go back"
 *   - Legacy: "press enter to confirm or esc to cancel"
 * Does NOT match: "press number to confirm" (handled by detectMultipleChoicePrompt)
 *
 * The distinction is important: "press enter to confirm/select" indicates an arrow-key
 * selection list (NavigationButtons), while "press number to confirm" indicates
 * a numbered prompt (PromptPanel with buttons).
 */
export const CODEX_SELECTION_LIST_PATTERN = /press\s+enter\s+to\s+(?:confirm|select)/i;

/**
 * Codex CLI approval-request footer pattern (Issue #1628).
 *
 * Codex renders an approval request ("Would you like to run the following
 * command?" / "Would you like to make the following edits?") with the SAME
 * "Press enter to confirm" footer as a `/model`-style menu, which is why
 * CODEX_SELECTION_LIST_PATTERN swallows it. The two differ in the escape verb:
 * an approval request can be *cancelled* (it is the agent asking the human for
 * permission), a menu can only be *gone back* from.
 *
 * Measured on codex-cli 0.146.0 (five consecutive live approval frames captured
 * from a real session, plus two live `/model` picker frames):
 *   - approval : "Press enter to confirm or esc to cancel"
 *   - /model   : "Press enter to confirm or esc to go back"
 *   - /model   : "Press enter to select reasoning effort, or esc to dismiss."
 *
 * Used only as one of two OR'd approval signals (see isCodexApprovalRequest in
 * status-detector.ts); the other is an interrogative question line, so a future
 * rewording of either signal alone does not reopen Issue #1628.
 *
 * No /g flag (keeps .test() stateless), no nested quantifiers (ReDoS-safe).
 */
export const CODEX_APPROVAL_FOOTER_PATTERN = /esc\s+to\s+cancel/i;

/**
 * Codex CLI pager / edit-previous (transcript) mode footer pattern (Issue #1017)
 *
 * When Codex enters its transcript pager / "edit previous message" mode, the
 * bottom of the frame shows scroll / edit key hints INSTEAD of the usual
 * "model · N% left · path" status bar, e.g.:
 *   "↑/↓ to scroll   pgup/pgdn to page   home/end to jump"
 *   "q to quit   esc/← to edit prev   → to edit next   enter to edit message"
 * together with a scroll-percentage separator ("─ N% ─", NOT "N% left ·").
 *
 * Neither CODEX_SELECTION_LIST_PATTERN (which needs "press enter to
 * confirm/select") nor the "N% left ·" status-bar boundary logic in
 * status-detector.ts fires here, so the read-only TerminalDisplay is left with no
 * way to scroll or escape (the reported bug). This pattern recognizes the pager
 * footer directly — independent of the status bar — so the selection window
 * (NavigationButtons) can be rendered.
 *
 * Matches any of the pager-specific hints (either footer line is sufficient):
 *   - scroll/page/jump hints: "↑/↓ to scroll" / "pgup/pgdn to page" / "home/end to jump"
 *   - edit-previous hints:    "esc/← to edit prev" / "→ to edit next" / "enter to edit message"
 * The two branches are independent so a mangled unicode-arrow footer line is still
 * caught by the ASCII "to edit prev/next/message" and "pgup/pgdn"/"home/end" hints.
 *
 * Does NOT match the genuine "/model" selection list ("press enter to select") —
 * that footer has no scroll/page/jump or edit-prev/next/message hint — so the
 * existing CODEX_SELECTION_LIST_PATTERN path is unaffected (no regression).
 *
 * No /g flag (S4-5: keeps test() stateless). No nested quantifiers (SEC4-001: ReDoS-safe).
 */
export const CODEX_PAGER_FOOTER_PATTERN =
  /(?:↑\/↓|pgup\/pgdn|home\/end)\s+to\s+(?:scroll|page|jump)|to\s+edit\s+(?:prev|next|message)/i;

/**
 * Codex CLI status-bar line pattern (Issue #1150)
 *
 * The Codex TUI renders a status bar as the bottom-most content line, just above
 * the input area. status-detector.ts uses it as the footer boundary that separates
 * the conversation content (thinking indicators / idle "›" prompt) from the input
 * area, so both the selection-list check (priority 0.8) and the running/idle check
 * (priority 2.7) depend on locating it.
 *
 * The format drifted across Codex versions — the "N% left ·" token was DROPPED in
 * v0.141 (gpt-5.5), which is exactly what broke Issue #1150:
 *   - v0.141 (gpt-5.5): "gpt-5.5 xhigh · ~/share/work/github_kewton/commandmate-issue-947"
 *   - legacy (gpt-5.4): "gpt-5.4 high · 21% left · ~/share/work/..."
 *   - legacy (o4-mini): "  o4-mini            50% left · /path/to/project"
 *
 * The previous pattern required "\d+%\s+left\s+·", so v0.141 bars never matched:
 * the footer boundary stayed -1 and the whole Codex running/idle block was skipped,
 * leaving generating sessions misreported as `ready` (static green dot, no glow).
 *
 * Version-independent anchor: a leading model token, a middle-dot "·" separator,
 * and a filesystem path ("~/…" or "/…") at the END of the line. Any "N% left ·"
 * segment (legacy) is absorbed by ".*·" before the trailing path. Requiring the
 * trailing path keeps this Codex-specific (guarded by cliToolId === 'codex' in
 * status-detector.ts) and stops ordinary conversation lines that merely contain a
 * "·" from being mistaken for the status bar.
 *
 * Single-line by design (no /m, no /g): status-detector.ts tests it per content
 * line. No nested quantifiers (ReDoS-safe; adjacent greedy quantifiers only).
 */
export const CODEX_STATUS_BAR_PATTERN = /^\s*\S.*·\s*~?\/\S*\s*$/;

/**
 * Pasted text pattern
 *
 * Claude CLI displays this when it detects multi-line text paste in the
 * ink-based TextInput. The pattern matches the folded display format.
 *
 * @example "[Pasted text #1 +46 lines]"
 * @see Issue #212, #163
 * @designNote PASTE-001: Pattern matches the start of the indicator only.
 *   The line count (+XX lines) is variable, so we match the fixed prefix
 *   to minimize false negatives. False positive risk is low because
 *   "[Pasted text #" is a unique format generated by Claude CLI's ink renderer.
 * @designNote PASTE-001-FP (SF-S4-002): When used in skipPatterns,
 *   line-level matching could filter legitimate response lines if Claude's
 *   answer text happens to contain "[Pasted text #". This is unlikely and
 *   acceptable -- only the affected line would be lost.
 */
export const PASTED_TEXT_PATTERN = /\[Pasted text #\d+/;

/**
 * Pasted text detection delay (milliseconds)
 *
 * Wait time after sendKeys for tmux buffer to reflect [Pasted text] display.
 *
 * @see Issue #212
 * @designNote PASTE-002: 500ms is the empirically measured time for
 *   Claude CLI's ink rendering to complete. capturePane({ startLine: -10 })
 *   reads only the last 10 lines since [Pasted text] appears in the most
 *   recent few lines.
 */
export const PASTED_TEXT_DETECT_DELAY = 500;

/**
 * Pasted text detection max retries
 *
 * @see Issue #212
 * @designNote PASTE-003: 3 retries x 500ms = max 1500ms additional delay.
 *   Typically resolves on the first attempt (+500ms).
 */
export const MAX_PASTED_TEXT_RETRIES = 3;

/**
 * Gemini interactive REPL prompt pattern
 * Gemini CLI shows a `>` or `❯` prompt when waiting for user input in interactive mode.
 *
 * Two branches (Issue #386):
 * - Branch 1: `^[>❯]\s*$` -- bare prompt character (empty input line)
 * - Branch 2: `^\s*[>❯]\s+Type your message.*$` -- new-format prompt with placeholder text
 *   (e.g., " >   Type your message or @path/to/file"). Leading whitespace is allowed
 *   because tmux capture-pane output may include padding.
 *
 * Branch 2 requires "Type your message" after the indicator to avoid false positives
 * on quoted response lines (e.g., "> some quoted text").
 *
 * @see CLAUDE_PROMPT_PATTERN for similar dual-format matching approach
 */
// [S4-5] /g flag prohibited: would make test() stateful
export const GEMINI_PROMPT_PATTERN = /^[>❯]\s*$|^\s*[>❯]\s+Type your message.*$/m;

/**
 * Gemini thinking/processing pattern
 * Gemini CLI shows braille spinner characters and status text while processing.
 */
export const GEMINI_THINKING_PATTERN = /[\u2800-\u28FF]|Thinking\.\.\./;

/**
 * OpenCode prompt pattern (Issue #379)
 * OpenCode TUI shows "Ask anything..." in the input area when waiting for user input.
 * Unlike Claude/Codex (which use > or ❯), OpenCode uses a text-based prompt indicator.
 */
export const OPENCODE_PROMPT_PATTERN = /Ask anything\.\.\./;

/**
 * OpenCode idle composer pattern (Issue #1883).
 *
 * The `Ask anything...` placeholder as opencode actually draws it: **inside the
 * input box**, behind the box's own gutter (`\u2503`, or `\u2502` on a lighter
 * border style). Two measured facts make that row positive evidence that the
 * composer is empty, rather than the mere absence of a busy marker (design
 * principle D1 in `docs/design/multi-agent-state-architecture.md`):
 *
 * - opencode paints the placeholder **only while the input buffer is empty**.
 *   The first typed character replaces the whole row — measured live on
 *   opencode 1.18.20, pane 80x200 (`opencode-live-1883/composer-residual.txt`
 *   holds `\u2503  echo PREFILLED` where the idle frame holds the placeholder).
 * - the gutter says the row belongs to the input box. `Ask anything...` printed
 *   in a response body has no gutter, and reading that as an idle composer is
 *   the "the phrase is on screen somewhere" inference D1 forbids.
 *
 * **Match this against the ANSI-stripped frame BEFORE {@link stripBoxDrawing}**,
 * which strips the very gutter this pattern anchors on.
 *
 * The whitespace runs are `[^\S\n]` (horizontal only) on purpose: plain `\s`
 * crosses newlines under the `m` flag, which let the gutter of one row pair up
 * with the phrase several rows below it and matched frames that hold no
 * composer at all (measured on `phrase-in-response.txt`).
 *
 * {@link OPENCODE_PROMPT_PATTERN} stays as it is: `response-checker` and
 * `OPENCODE_SKIP_PATTERNS` want the bare phrase wherever it lands, because they
 * are deleting the row from an extracted response, not judging a session.
 */
export const OPENCODE_IDLE_COMPOSER_PATTERN =
  /^[^\S\n]*[\u2502\u2503][^\S\n]*Ask anything\.\.\./m;

/**
 * OpenCode prompt pattern after response completion (Issue #379)
 * Shows "tab agents  ctrl+p commands" in the TUI status bar after a response finishes.
 * Used as extraction stop condition in response-poller.ts [D2-003].
 */
export const OPENCODE_PROMPT_AFTER_RESPONSE = /tab agents\s+ctrl\+p commands/;

/**
 * OpenCode thinking/processing pattern (Issue #379)
 * OpenCode TUI shows "Thinking:" prefix while the Ollama model is generating a response.
 * Used by detectThinking() to determine if the tool is actively processing.
 */
export const OPENCODE_THINKING_PATTERN = /Thinking:/;

/**
 * OpenCode loading indicator pattern (Issue #379)
 * Shows a series of 4+ filled square characters (U+2B1D) during initial loading/model warm-up.
 * Filtered from response extraction via OPENCODE_SKIP_PATTERNS.
 */
export const OPENCODE_LOADING_PATTERN = /\u2B1D{4,}/;

/**
 * OpenCode's Build summary LINE, in either of the two forms it is drawn in
 * (Issue #379, corrected by Issue #1893).
 *
 * **This is a line filter, not completion evidence.** It matches
 * `▣ <Action> · <model>` with the duration OPTIONAL, and opencode 1.18 draws
 * that duration-less form on a step that is still in flight -- so a frame this
 * pattern matches may be mid-turn, waiting on a permission dialog, or aborted.
 * Use {@link OPENCODE_TURN_COMPLETE_PATTERN} to decide that a turn has finished.
 *
 * The docstring that stood here until #1893 claimed the opposite ("short
 * responses may omit the timing portion"). Measured against opencode 1.18.21 at
 * the production 80x200 geometry, that is wrong in both directions:
 *
 * - a 2.3-second answer still carries its duration
 *   (`▣  Build · GPT-5.6 Luna · 2.3s`, `opencode-live-1893/turn-complete-short.txt`),
 *   so no completed turn needs the duration-less branch;
 * - the duration-less form is what opencode leaves on screen while a tool call
 *   waits for permission and after a rejected one
 *   (`opencode-live-1893/permission-bash.txt`, `…/turn-aborted-no-duration.txt`).
 *
 * Kept loose because three callers want the LINE rather than the verdict:
 * `tui-accumulator.ts`, `response-cleaner.ts` and `polling/response-checker.ts`
 * all use it to drop the summary row from an extracted response, and the
 * mid-step row has to be dropped too. #1911 removed the one caller that used it
 * as a turn BOUNDARY rather than a line filter (the "second-to-last ▣" anchor,
 * replaced by {@link findOpenCodeUserEchoEnd}); the name is left alone because
 * the remaining three callers all want the line.
 */
export const OPENCODE_RESPONSE_COMPLETE = /\u25A3\s+\w+\s+\u00b7\s+\S+(?:\s+\u00b7\s+(?:[\d]+h\s*)?(?:[\d]+m\s*)?[\d.]+s)?/;

/**
 * OpenCode's finished-turn marker: the Build summary line WITH its duration
 * (Issue #1893).
 *
 * `▣  Build · GPT-5.6 Luna · 5.2s`. This is the one tool-specific completion
 * marker design rule D1 recognises today
 * (`docs/design/multi-agent-state-architecture.md` §4 D1 decision 1, item 1),
 * and the duration is the whole of what makes it positive evidence: opencode
 * prints the same row without a duration while a step is still open, which is
 * how a session parked on a permission dialog was published as
 * `ready`/`opencode_response_complete` (#1893) and how `isOpenCodeComplete`
 * saved the dialog body as if it were an answer.
 *
 * The model segment is `[^·\n]+` rather than `\S+` because real model names
 * carry spaces (`GPT-5.6 Luna`): with `\S+` the optional-duration group of
 * {@link OPENCODE_RESPONSE_COMPLETE} could never reach the duration on a
 * two-word model, so "with duration" and "without duration" were the same match
 * there. Excluding the middle dot rather than allowing anything keeps the
 * quantifier unable to swallow its own delimiter (no nested/ambiguous
 * quantifier -- ReDoS safe), and `.`/`[^·\n]` never cross a line without the
 * `m` flag, so the duration has to be on the marker's own row.
 *
 * Durations observed: `2.3s`, `5.2s`, `45.2s`; the `Nh`/`Nm` prefixes are
 * inherited from the #379 pattern and kept for long turns.
 */
export const OPENCODE_TURN_COMPLETE_PATTERN =
  /\u25A3\s+\w+\s+\u00b7\s+[^\u00b7\n]+\u00b7\s+(?:\d+h\s*)?(?:\d+m\s*)?[\d.]+s/;

/**
 * OpenCode's permission dialog, anchored on its button row (Issue #1893).
 *
 * opencode 1.18 asks for tool permission with a bottom-anchored box whose last
 * interactive row is a horizontal button strip:
 *
 * ```
 *   ┃  △   Permission required
 *   ┃    # Shell command
 *   ┃  $ ls -la
 *   ┃   Allow once   Allow always   Reject  ctrl+f fullscreen  ⇆ select  enter con
 * ```
 *
 * Nothing in the detection layer saw it before #1893: it carries no number, no
 * `(y/n)`, and no "press enter to confirm" footer, so `detectPrompt` answers
 * `isPrompt: false` and the status detector fell through to the Build marker
 * above it. The row is matched as POSITIVE evidence that a decision is pending
 * (design rule D1) -- it is the affordance itself, not the absence of a busy
 * marker.
 *
 * **Match this against the ANSI-stripped frame BEFORE {@link stripBoxDrawing}**,
 * exactly like {@link OPENCODE_IDLE_COMPOSER_PATTERN}: the leading `┃` (or
 * `│` on a lighter border style) is what says the row belongs to the dialog box
 * rather than to a response body that happens to quote the labels -- the
 * "the phrase is on screen somewhere" inference #1883 had to remove.
 *
 * Deliberately NOT anchored on:
 *
 * - `enter confirm`, which is truncated to `enter con` at opencode's own 80
 *   column layout (measured);
 * - `△ Permission required` alone, which is a heading rather than an
 *   affordance and survives in the fullscreen (`ctrl+f`) view whose key handling
 *   was not measured.
 *
 * The three labels are the same for the `bash` and the `edit` dialog (measured:
 * `permission-bash.txt`, `permission-edit.txt`), and the strip is repainted away
 * the moment the dialog is answered, so a matched row is never scrollback
 * (`turn-aborted-no-duration.txt` holds no `Allow once`).
 *
 * The whitespace runs are `[^\S\n]` (horizontal only) for the reason #1883
 * documents: plain `\s` crosses newlines under the `m` flag and would pair a
 * gutter on one row with labels several rows below it.
 */
export const OPENCODE_PERMISSION_PATTERN =
  /^[^\S\n]*[\u2502\u2503][^\S\n]*Allow once[^\S\n]+Allow always[^\S\n]+Reject\b/m;

/**
 * OpenCode processing indicator pattern (Issue #379)
 * Shows "esc interrupt" in the TUI status bar during active model processing.
 * Filtered from response extraction via OPENCODE_SKIP_PATTERNS.
 */
export const OPENCODE_PROCESSING_INDICATOR = /esc interrupt/;

/**
 * OpenCode's composer bottom border: `  ╹▀▀▀▀▀▀…` (Issue #1911).
 *
 * `╹` (heavy up) is the corner opencode joins the input box's `┃`
 * gutter to, and the `▀` run is the box's bottom edge. It is the one row of
 * the bottom-anchored chrome that can never appear inside a response body, which
 * makes it the anchor {@link findOpenCodeChromeStart} walks up from.
 */
export const OPENCODE_COMPOSER_BOTTOM_BORDER = /^[^\S\n]*╹▀{4,}/;

/**
 * A row that belongs to one of opencode's boxes, matched by its own gutter
 * (Issue #1911).
 *
 * opencode draws three different boxes with the same `┃` gutter (`│`
 * on a lighter border style): the echoed USER PROMPT in the transcript, the
 * COMPOSER pinned to the bottom of the pane, and the PERMISSION DIALOG that
 * replaces the composer. Which one a matched row belongs to is decided by where
 * it sits, not by what it says — see {@link findOpenCodeChromeStart} and
 * {@link findOpenCodeUserEchoEnd}.
 *
 * **Match against the ANSI-stripped frame BEFORE {@link stripBoxDrawing}**,
 * which removes the very gutter this anchors on.
 */
export const OPENCODE_GUTTER_ROW_PATTERN = /^[^\S\n]*[│┃]/;

/**
 * An echoed user prompt row: a gutter row that carries text (Issue #1911).
 *
 * The echo block opencode draws for a submitted message is a blank gutter row,
 * one or more gutter rows holding the message, and another blank gutter row.
 * This matches the middle ones.
 */
export const OPENCODE_USER_ECHO_PATTERN = /^[^\S\n]*[│┃][^\S\n]*\S/;

/**
 * The status cell of opencode's bottom footer (Issue #1911).
 *
 * Measured at the production 80x200 geometry the footer reads
 * `<cwd>    6.4K (1%) · $ctrl+p` / `commands` while idle and
 * `⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt   6.3K (1%) · $0.00  ctrl+p commands` while running:
 * a context-usage cell followed by the cost sigil. Neither
 * {@link OPENCODE_PROMPT_AFTER_RESPONSE} (`tab agents  ctrl+p commands`, which
 * opencode only prints on the FIRST idle frame, before any turn has run) nor
 * {@link OPENCODE_PROCESSING_INDICATOR} covers the idle form, so this row used
 * to be saved as part of the assistant's reply.
 *
 * This is a SECONDARY net. The cwd that shares the row wraps over up to three
 * further rows that carry no signature at all, so the footer is removed
 * structurally by {@link findOpenCodeChromeStart}; this pattern only catches the
 * signed row when that boundary is not available (e.g. a caller holding a
 * fragment rather than a whole pane).
 *
 * Linear, no nested quantifiers — ReDoS safe.
 */
export const OPENCODE_FOOTER_STATUS_PATTERN =
  /\d+(?:\.\d+)?[KMGT]?\s+\(\d+%\)\s+·\s+\$/;

/**
 * Locate the start of opencode's bottom-anchored chrome within a captured pane
 * (Issue #1911).
 *
 * opencode runs in the alternate screen and reserves the last rows of the pane
 * for chrome that is never transcript content:
 *
 * ```
 *   ┃                              ← composer box (blank rows + model row),
 *   ┃  Build · GPT-5.6 Luna …        or the permission dialog that replaces it
 *   ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀   ← composer bottom border
 *   /private/tmp/…-share-    6.4K (1%) · $ctrl+p   ← footer, cwd wrapped
 *   work-github-kewton-…                 commands     over up to three rows
 * ```
 *
 * Everything from the returned index down is chrome. This is the opencode twin
 * of {@link findClaudeChromeStart} and exists for the same reason (#1289): the
 * footer's cwd rows and the composer's model row were reaching saved responses,
 * which is defect 1 of #1911.
 *
 * Found structurally rather than by matching footer text, because the footer's
 * text is opencode's to change and two of its four rows (the cwd continuations)
 * are an arbitrary filesystem path with no signature at all.
 *
 * @param lines - Captured pane lines, ANSI-stripped, box drawing intact.
 *   Trailing blank rows are tolerated.
 * @returns Index of the first chrome row, or -1 when no chrome is recognisable.
 */
export function findOpenCodeChromeStart(lines: string[]): number {
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  if (last < 0) return -1;

  const walkUpGutter = (from: number): number => {
    let top = from;
    while (top - 1 >= 0 && OPENCODE_GUTTER_ROW_PATTERN.test(lines[top - 1])) top--;
    return top;
  };

  // The composer's bottom border. Searched from the last row upwards over the
  // WHOLE pane rather than over the few rows the footer occupies: on the boot
  // screen opencode centres the composer under its banner (row ~99 of 200) while
  // the footer stays pinned to the bottom, so a window sized for the footer
  // misses the border entirely (measured, `opencode-live-1883/boot-idle.txt`).
  for (let i = last; i >= 0; i--) {
    if (OPENCODE_COMPOSER_BOTTOM_BORDER.test(lines[i])) {
      return walkUpGutter(i);
    }
  }

  // No border: the permission dialog draws over the composer and its own box
  // runs to the last row of the pane (measured, `opencode-live-1893/permission-*.txt`).
  if (OPENCODE_GUTTER_ROW_PATTERN.test(lines[last])) {
    return walkUpGutter(last);
  }

  return -1;
}

/**
 * Locate the last row of the NEWEST echoed user prompt in a captured pane
 * (Issue #1911).
 *
 * The turn currently being answered starts on the row after this one, so it is
 * both the extraction anchor (`resolveExtractionStartIndex`'s opencode branch)
 * and the floor the finished-turn marker has to sit below before a frame counts
 * as a completed turn (`isOpenCodeComplete`).
 *
 * Before #1911 the anchor was "the second-to-last `▣ Build` row", which has two
 * measured failure modes: on the first turn of a session there is no second row,
 * so extraction fell back to line 0 and saved the whole pane; and the row it
 * anchors on belongs to the PREVIOUS turn, so the echoed prompt of the current
 * one was always included in the reply.
 *
 * @param lines - Captured pane lines, ANSI-stripped, box drawing intact.
 * @param chromeStart - Result of {@link findOpenCodeChromeStart}; the search
 *   stops above it so the composer's and the permission dialog's own gutter rows
 *   are never read as an echoed prompt. Pass -1 when no chrome was found.
 * @returns Index of the echo block's last row, or -1 when no echo is on screen
 *   (a turn whose head has scrolled out of the alternate-screen pane).
 */
export function findOpenCodeUserEchoEnd(lines: string[], chromeStart: number): number {
  const limit = chromeStart >= 0 ? chromeStart : lines.length;

  for (let i = limit - 1; i >= 0; i--) {
    if (!OPENCODE_USER_ECHO_PATTERN.test(lines[i])) continue;
    // The block's trailing blank gutter row(s) belong to the echo, not to the reply.
    let end = i;
    while (end + 1 < limit && OPENCODE_GUTTER_ROW_PATTERN.test(lines[end + 1])) end++;
    return end;
  }

  return -1;
}

/**
 * OpenCode TUI selection list pattern (Issue #473, narrowed by Issue #1896).
 *
 * Detects the fuzzy-search picker overlay opencode draws for `/models`,
 * `/providers` and `/connect`, anchored on its HEADER ROW COMPLETE WITH the
 * right-aligned `esc` hatch:
 *
 * ```
 *               Select model                                     esc
 *
 *               Search
 *
 *               Recent
 *             ● GPT-5.6 Luna GitHub Copilot
 * ```
 *
 * The `esc` is the picker's own dismiss affordance -- positive evidence that an
 * overlay is open (design rule D1), rather than the presence of two English
 * words somewhere on the pane. Until #1896 the pattern was the bare phrase, and
 * `status-detector.ts` tests it against the WHOLE content area (up to ~200 rows,
 * because the header can sit far above the last row when the list is long), so
 * an agent that merely wrote `Select model to continue:` in its answer parked the
 * session on `waiting` / `opencode_selection_list` for the rest of the session
 * -- measured live on opencode 1.18.21,
 * `opencode-live-1896/select-model-in-response.txt`.
 *
 * Requiring two or more spaces before `esc` is what separates the header row
 * from prose: the picker right-aligns the hatch across the overlay's width
 * (37 spaces in the measured frame), while a sentence that happens to end in
 * "esc" would not.
 *
 * NOT additionally anchored on the `Search` row below the header: its distance
 * from the header is unmeasured for the `Connect a provider` variant (that
 * overlay needs an unconfigured provider to open, which the live probe could not
 * produce without touching the operator's real credentials), and the header's
 * own hatch is already the affordance.
 *
 * The header allowlist is deliberately unchanged. opencode 1.18 draws the same
 * chrome for its ctrl+p command palette (`Commands … esc`), which this pattern
 * therefore still does not match; that frame lands on `running` / `default`
 * (measured, `opencode-live-1896/command-palette.txt`) -- i.e. on the
 * "no evidence" side, which #1708's unclassified-frame guard already covers.
 * Widening the allowlist is a separate change with its own live frames.
 *
 * The whitespace runs are `[^\S\n]` (horizontal only) for the reason Issue #1883
 * documents: plain `\s` crosses newlines under the `m` flag, which would let a
 * header on one row pair up with an `esc` several rows below it.
 *
 * Linear pattern, no nested quantifiers -- ReDoS safe (S4-001).
 */
export const OPENCODE_SELECTION_LIST_PATTERN =
  /^[^\S\n]*(?:Select[^\S\n]+(?:model|provider)|Connect[^\S\n]+a[^\S\n]+provider)[^\S\n]{2,}esc[^\S\n]*$/m;

/**
 * [Issue #1495] Footer signature of Claude Code's `/model` local-settings overlay.
 * Verified against a real Claude Code v2.1.218 capture, the footer reads:
 *   "Enter to set as default · s to use this session only · Esc to cancel"
 *
 * The overlay renders a ❯-marked numbered model list ("1. Default … 5. Haiku")
 * under a "Select model" header that detectMultipleChoicePrompt() otherwise
 * matches as a genuine multiple_choice prompt — which let Auto-Yes Enter-confirm
 * a selection and silently change the user's default model. This "set as default"
 * phrasing is unique to the model picker: genuine confirmation prompts never
 * contain it (the trust dialog uses "Enter to confirm · Esc to cancel", Bash-tool
 * approvals use "Esc to cancel · Tab to amend", AskUserQuestion uses
 * "Enter to select · … to navigate"), so it is a safe exclusion signal.
 *
 * Linear pattern, no nested quantifiers — ReDoS safe (S4-001).
 */
export const CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN = /Enter\s+to\s+set\s+as\s+default\b/i;

/**
 * Claude CLI selection list footer pattern
 * Detects Claude CLI's interactive selection prompts that require
 * arrow key navigation and Enter to select/toggle.
 *
 * Matches footer instruction lines (known variants):
 *   "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"
 *   "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel"
 *   "Enter to confirm · Esc to exit"  (legacy /model command footer)
 *   "Enter to set as default · s to use this session only · Esc to cancel"
 *     (/model command footer as of Claude Code v2.1.218 — Issue #1495)
 *
 * The "set as default" branch lets status-detector classify the `/model` overlay
 * as a Claude selection list (NavigationButtons + ESC hatch, hasActivePrompt=false)
 * once detectPrompt() no longer reports it as a prompt (see
 * CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN).
 */
export const CLAUDE_SELECTION_LIST_FOOTER = /Enter\s+to\s+(?:select\s+.*to\s+navigate|confirm\s+·\s+Esc|set\s+as\s+default)/;

/**
 * OpenCode TUI separator pattern (Issue #379)
 * Matches lines composed entirely of box-drawing / TUI decoration characters.
 * Covers: vertical lines (U+2503), box corners, horizontal lines, and other TUI elements.
 */
export const OPENCODE_SEPARATOR_PATTERN = /^[\u2503\u2579\u25A3\u2580\u2500\u250C\u2510\u2514\u2518\u251C\u2524\u252C\u2534\u253C]+$/;

/**
 * OpenCode skip patterns for response cleaning (Issue #379)
 * Lines matching any of these patterns are filtered from extracted responses.
 * Includes: TUI separators, loading indicators, Build summary prefix,
 * status bar prompts, processing indicators, input prompt, the footer's
 * context/cost status cell (Issue #1911), and pasted text markers.
 */
export const OPENCODE_SKIP_PATTERNS: readonly RegExp[] = [
  OPENCODE_SEPARATOR_PATTERN,
  OPENCODE_LOADING_PATTERN,
  /^Build\s+/,
  OPENCODE_PROMPT_AFTER_RESPONSE,
  OPENCODE_PROCESSING_INDICATOR,
  OPENCODE_PROMPT_PATTERN,
  OPENCODE_FOOTER_STATUS_PATTERN,
  PASTED_TEXT_PATTERN,
] as const;

/**
 * Copilot prompt pattern (Issue #545)
 * Copilot CLI shows "❯" followed by cursor/text hint:
 *   - "❯ [7m [0mType @ to mention files, # for issues/PRs, / for commands, or ? for"
 *   - "❯ " (bare prompt)
 * Also matches "? " prefix for question prompts.
 */
export const COPILOT_PROMPT_PATTERN = /^[>❯]\s|^\?\s+/m;

/**
 * Copilot thinking/processing pattern (Issue #545)
 * Copilot CLI shows various action indicators during processing:
 *   - "Exploring repo (Esc to cancel · 2.3 KiB)"
 *   - "Reasoning ■■■ medium"
 *   - "... Thinking"
 *   - Tool use: "● Read package.json" / "◉ Mapping structure (Esc to cancel · 8.4 KiB)"
 * Note: "Esc to cancel" alone is not used because trust dialog footer also contains it.
 * Instead, match the action pattern with parenthesized context: "(Esc to cancel ·"
 * Braille spinner characters (U+2800-U+28FF) are also checked.
 */
export const COPILOT_THINKING_PATTERN = /[\u2800-\u28FF]|\(Esc to cancel|Reasoning\s+[■▪▮]|\.\.\.\s+Thinking|Generating|Processing/;

/**
 * Copilot CLI's bottom status bar while a turn is in flight (Issue #1885).
 *
 * Measured on copilot 1.0.80 at the production 200x1000 geometry
 * (`tests/unit/lib/detection/fixtures/copilot-live-1885/`). The bar is the
 * bottom row of the pane and reads, across 44 captured generating frames:
 *
 *   " ● Working esc interrupt                              GPT-5.6 Terra"
 *   " ◉ Working · 1.5 KiB esc interrupt                       GPT-5.6 Terra"
 *
 * The leading glyph cycles through ● ◉ ◎ ○ and the byte counter appears only
 * once the turn has produced output, so neither is anchored on. `esc interrupt`
 * is the affordance hint copilot draws for as long as the turn can be
 * interrupted -- it is on every generating frame and on every tool-execution
 * frame -- which makes it the same signal opencode's
 * {@link OPENCODE_PROCESSING_INDICATOR} rests on.
 *
 * It is matched against the STATUS BAR ROW ONLY, never a window
 * (see {@link readCopilotStatusBar}). `status-vocabulary-in-response.txt` is a
 * live frame where copilot was asked to print this vocabulary and answered
 * " ● Working esc interrupt" as body text: a window match would have pinned that
 * finished session to `running` for the rest of its life.
 *
 * No /g flag (S4-5: would make test() stateful). No quantifier over a
 * character class that can match its neighbour (SEC4-001: ReDoS safe).
 */
export const COPILOT_WORKING_STATUS_PATTERN = /\besc\s+interrupt\b/;

/**
 * Copilot CLI's bottom status bar while no turn is running (Issue #1885).
 *
 * The same row as {@link COPILOT_WORKING_STATUS_PATTERN}, in the state copilot
 * paints when it is NOT working:
 *
 *   " ← open sidebar · / commands · ? help · tab next tab            GPT-5.6 Terra"
 *
 * This is copilot's positive completion evidence under design rule D1
 * (`docs/design/multi-agent-state-architecture.md` §4 D1 decision 1, item 2):
 * the key-hint bar and the working bar are two renderings of one row, so seeing
 * the hints is an affirmative observation that the turn is over -- not the
 * absence of a busy marker somewhere on screen. The composer cannot carry that
 * evidence on copilot: `❯` between its two full-width rules is drawn during
 * generation too (measured on every frame of the running fixtures), which is
 * exactly why the always-visible prompt used to win at step 3 of
 * `detectSessionStatus` and report a generating session as ready.
 *
 * Two alternative spellings of one affordance, because copilot has reworded
 * this row before: 1.0.80 shows "? help", and the pre-1.0.79 wording survives
 * in {@link COPILOT_SKIP_PATTERNS} as "? for shortcuts". "/ commands" covers
 * the slash-command hint independently, so a rewording of either half alone
 * does not cost the tool its completion evidence.
 *
 * No /g flag (S4-5). Linear alternation, no nested quantifiers (SEC4-001).
 */
export const COPILOT_IDLE_STATUS_PATTERN = /\/\s+commands\b|\?\s+(?:help\b|for\s+shortcuts\b)/;

/**
 * The two states {@link readCopilotStatusBar} can positively identify.
 */
export type CopilotStatusBarState = 'working' | 'idle';

/**
 * Read copilot's bottom status bar out of a captured frame (Issue #1885).
 *
 * Takes the whole frame rather than a row so the positional anchor -- "the
 * status bar is the bottom row of the pane" -- cannot be lost at a call site.
 * The scan stops at the first non-blank row from the bottom: if that row is
 * neither state, this returns null and the caller has no evidence, which is the
 * D1-correct answer rather than a guess. Two measured frames rely on it:
 *
 *  - a permission dialog replaces the whole bottom of the pane with its box, so
 *    the bottom row is `╰───…` and neither pattern matches. The dialog then
 *    reaches `detectPrompt` and is reported as `waiting`, unchanged.
 *  - the `/model` picker ends in its own footer
 *    ("↑/↓ to navigate · … · enter to select · esc to cancel"), which is not the
 *    status bar either -- so this reports nothing about it and leaves that
 *    screen to the selection-list branch (Issue #1895's subject).
 *
 * @param contentLines - Frame rows, ANSI already stripped, in pane order
 * @returns The state the bottom row announces, or null when it announces neither
 */
export function readCopilotStatusBar(
  contentLines: readonly string[]
): CopilotStatusBarState | null {
  for (let i = contentLines.length - 1; i >= 0; i--) {
    const row = contentLines[i];
    if (row.trim() === '') continue;
    if (COPILOT_WORKING_STATUS_PATTERN.test(row)) return 'working';
    if (COPILOT_IDLE_STATUS_PATTERN.test(row)) return 'idle';
    return null;
  }
  return null;
}

/**
 * Copilot separator pattern (Issue #545)
 * Placeholder - to be updated after Phase 1 TUI investigation.
 */
export const COPILOT_SEPARATOR_PATTERN = /^─{10,}$/m;

/**
 * Copilot CLI selection list pattern (Issue #547)
 * Detects Copilot CLI's interactive selection/navigation prompts:
 *   - Model picker: "Search models..." / "Select Model"
 *   - Trust dialog: "↑↓ to navigate · Enter to select · Esc to cancel"
 *   - Other interactive lists with arrow key navigation
 *
 * No /g flag (S4-5: would make test() stateful).
 * No nested quantifiers (SEC4-001: ReDoS safety).
 */
export const COPILOT_SELECTION_LIST_PATTERN = /Search\s+\w+\.\.\.|Select\s+Model|to (?:navigate|select).*Enter to (?:select|confirm)/m;

/**
 * Anchors of Copilot CLI's first-launch "Confirm folder trust" dialog (Issue #1886).
 *
 * Recorded from copilot 1.0.80 (`tests/fixtures/copilot-folder-trust-1080.ts`):
 * copilot asks this once per untrusted git repository, before anything else runs,
 * and the whole dialog is drawn inside a box — every row reads `│ <content>`.
 * That is why `COPILOT_PROMPT_PATTERN` (`^[>❯]\s`) does not match the frame at
 * all and `waitForReady` used to spin its full 30-second window against it.
 *
 * Both anchors are required. One of them alone would also match this dialog's
 * text quoted back inside a model response, and a false positive here does not
 * merely mis-report a status: it sends a bare `1` into a live composer.
 *
 * The anchors live here rather than in `cli-tools/copilot` for the same reason
 * codex's do (Issue #1829): the Auto-Yes poller judges the same screen through
 * `detectPrompt`, and two copies of the wording would be two chances to disagree
 * about what this dialog is.
 */
export const COPILOT_FOLDER_TRUST_ANCHORS: readonly string[] = [
  'Confirm folder trust',
  'Do you trust the files in this folder?',
] as const;

/**
 * The one option CommandMate may answer on the operator's behalf: `1. Yes`,
 * which grants trust for THIS SESSION only.
 *
 * Matching the option text — not just the dialog — is the fail-safe. Option 2
 * ("Yes, and remember this folder for future sessions") writes `trustedFolders`
 * into `~/.copilot/config.json`, one file shared by every checkout on the
 * machine (measured: answering `1` leaves that file byte-identical). If copilot
 * ever reorders the list so that `1` is the remembering variant, this stops
 * matching, nothing is sent, and the launch degrades to the pre-#1886 stall
 * instead of silently persisting a trust grant.
 *
 * Written against the box-stripped frame, where the row reads `❯ 1. Yes`.
 * `[ \t]*$` rather than `\s*$` so the trailing anchor cannot roll onto a later
 * line and accept `1. Yes, and remember ...`.
 */
export const COPILOT_FOLDER_TRUST_SESSION_OPTION_PATTERN = /^[ \t]*(?:[>❯][ \t]*)?1\.[ \t]+Yes[ \t]*$/m;

/**
 * Key that selects {@link COPILOT_FOLDER_TRUST_SESSION_OPTION_PATTERN}.
 * Measured on 1.0.80: the digit confirms on its own — sending a trailing Enter
 * would land on the composer that the dialog's dismissal reveals.
 */
export const COPILOT_FOLDER_TRUST_ANSWER_KEY = '1';

/**
 * Whether the pane is sitting on the folder-trust dialog with the session-only
 * option in first position.
 *
 * @param output - ANSI-stripped pane capture (box drawing still present)
 * @returns True when both anchors and the `1. Yes` option row are present
 */
export function isCopilotFolderTrustDialog(output: string): boolean {
  if (!COPILOT_FOLDER_TRUST_ANCHORS.every((anchor) => output.includes(anchor))) {
    return false;
  }
  return COPILOT_FOLDER_TRUST_SESSION_OPTION_PATTERN.test(stripBoxDrawing(output));
}

/**
 * Copilot skip patterns for response cleaning (Issue #545)
 * Placeholder patterns - to be refined after Phase 1 TUI investigation.
 */
export const COPILOT_SKIP_PATTERNS: readonly RegExp[] = [
  PASTED_TEXT_PATTERN,
  COPILOT_SEPARATOR_PATTERN,
  COPILOT_THINKING_PATTERN,
  COPILOT_SELECTION_LIST_PATTERN,
  // Logo/banner lines
  /^GitHub Copilot\s+v/,
  /[█▘▝▖▗▔▄▌▐]/,
  /[╭╮╰╯│]/,
  // Status bar (branch + model display)
  /\[⎇\s+\w[^\]]*\]/,
  // Operation guide lines
  /^shift\+tab\s/,
  /^\?\s+for\s+shortcuts/,
  /^ctrl\+[a-z]\s+\w/,
  // Prompt lines
  /^[❯>]\s*(Type\s+@|$)/,
  // Tip/hint lines
  /^Tip:\s+\//,
  // Initial display text
  /^Describe a task to get started/,
  // Issue #571: Disclaimer, initialization message, environment info
  /^Copilot uses AI, so always check for mistakes\.$/,  // Disclaimer (full-line match to avoid filtering user content mentioning Copilot)
  /^● 💡/,                                              // Initialization hint message
  /^● Environment loaded:/,                              // Environment info
] as const;

/**
 * Vibe Local prompt pattern
 * vibe-local (vibe-coder) shows `ctx:N% ❯` prompt when waiting for user input.
 * The prompt line includes a context usage percentage prefix.
 * Examples: "ctx:9% ❯", "ctx:30% ❯", "ctx:9% ❯ /model"
 */
export const VIBE_LOCAL_PROMPT_PATTERN = /ctx:\d+%\s*[>❯]/m;

/**
 * Vibe Local thinking/processing pattern
 * vibe-local shows spinner characters and status text while processing.
 * Matches braille spinners, "Thinking", and tool execution indicators.
 */
export const VIBE_LOCAL_THINKING_PATTERN = /[\u2800-\u28FF]|Thinking|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Running|Executing/;

/**
 * Antigravity (agy) interactive REPL prompt pattern (Issue #988)
 * agy shows a bare ">" input box line when waiting for user input. The input box
 * is always rendered (even while generating), so prompt presence alone does not
 * mean "ready" — running vs idle is resolved together with the thinking pattern /
 * footer status bar in status-detector.ts. (Confirmed on machine: line is "> ".)
 */
export const ANTIGRAVITY_PROMPT_PATTERN = /^>\s*$/m;

/**
 * Antigravity (agy) thinking/processing pattern (Issue #988)
 * While generating, agy shows a braille spinner with "Generating..." in the
 * conversation area and an "esc to cancel" hint in the footer status bar. When
 * idle the footer shows "? for shortcuts" instead, so "esc to cancel" is a
 * reliable running signal. Braille spinner chars (U+2800-U+28FF) also matched.
 */
export const ANTIGRAVITY_THINKING_PATTERN = /[\u2800-\u28FF]|Generating|esc to cancel/;

/**
 * Antigravity (agy) separator pattern (Issue #988)
 * agy draws turn separators and the input-box border with runs of U+2500 (─).
 */
export const ANTIGRAVITY_SEPARATOR_PATTERN = /^─{3,}$/m;

/**
 * Antigravity (agy) selection list pattern (Issue #995, broadened in #997)
 * Detects agy's interactive arrow-key selection TUIs (e.g. the "Switch Model"
 * model picker, the "Do you want to proceed?" permission-approval menu). Their
 * footer status bar renders "esc to cancel", which ANTIGRAVITY_THINKING_PATTERN
 * also matches, so this pattern must be checked BEFORE thinking detection in
 * status-detector.ts to keep the selection screen from being misreported as
 * "generating".
 *
 * Matches (either is sufficient):
 *   - The "Switch Model" header of the model picker.
 *   - The "↑/↓ Navigate" arrow-key navigation hint, common to every agy
 *     selection TUI footer. Issue #995 originally required an "enter Select"
 *     hint too, but the permission-approval menu footer is
 *     "↑/↓ Navigate · tab Amend · ctrl+g … · ctrl+r Review" (no "enter Select"),
 *     so #997 relaxes this to the "↑/↓ Navigate" footer alone. This covers the
 *     Switch Model picker, permission-approval menus, and future agy selection
 *     TUIs in one shot, while staying agy-specific (the cliToolId === 'antigravity'
 *     guard in status-detector.ts keeps other tools unaffected).
 *
 * No /g flag (S4-5: would make test() stateful).
 * No `.*` at all (SEC4-001: ReDoS safe — strictly safer than the #995 form).
 */
export const ANTIGRAVITY_SELECTION_LIST_PATTERN = /Switch Model|↑\/↓\s*Navigate/m;

/**
 * Antigravity (agy) skip patterns for response cleaning (Issue #988)
 * Filters turn/input-box separators, the bare ">" input prompt, the idle status
 * bar ("? for shortcuts ... <model>"), the thinking footer/spinner, banner block
 * art, and pasted-text markers from extracted responses.
 */
export const ANTIGRAVITY_SKIP_PATTERNS: readonly RegExp[] = [
  ANTIGRAVITY_SEPARATOR_PATTERN, // Turn + input-box separators (─ runs)
  /^>\s*$/, // Bare input prompt line
  /^\?\s+for\s+shortcuts/, // Idle status bar (model name follows on the same line)
  ANTIGRAVITY_THINKING_PATTERN, // Spinner / Generating / "esc to cancel" footer
  /[▄▀█▌▐]/, // Banner block art (defensive; normally above the user-prompt anchor)
  PASTED_TEXT_PATTERN, // [Pasted text #N +XX lines]
] as const;

/**
 * Detect if CLI tool is showing "thinking" indicator
 */
export function detectThinking(cliToolId: CLIToolType, content: string): boolean {
  const log = logger.withContext({ cliToolId });
  log.debug('detectThinking:check', { contentLength: content.length });

  let result: boolean;
  switch (cliToolId) {
    case 'claude':
      result = CLAUDE_THINKING_PATTERN.test(content);
      break;
    case 'codex':
      result = CODEX_THINKING_PATTERN.test(content);
      break;
    case 'gemini':
      result = GEMINI_THINKING_PATTERN.test(content);
      break;
    case 'vibe-local':
      result = VIBE_LOCAL_THINKING_PATTERN.test(content);
      break;
    case 'opencode':
      result = OPENCODE_THINKING_PATTERN.test(content);
      break;
    case 'copilot':
      result = COPILOT_THINKING_PATTERN.test(content);
      break;
    case 'antigravity':
      result = ANTIGRAVITY_THINKING_PATTERN.test(content);
      break;
    default:
      result = CLAUDE_THINKING_PATTERN.test(content);
  }

  log.debug('detectThinking:result', { isThinking: result });
  return result;
}

/**
 * Get CLI tool patterns for response extraction
 */
export function getCliToolPatterns(cliToolId: CLIToolType): {
  promptPattern: RegExp;
  separatorPattern: RegExp;
  thinkingPattern: RegExp;
  skipPatterns: RegExp[];
} {
  switch (cliToolId) {
    case 'claude':
      return {
        promptPattern: CLAUDE_PROMPT_PATTERN,
        separatorPattern: CLAUDE_SEPARATOR_PATTERN,
        thinkingPattern: CLAUDE_THINKING_PATTERN,
        skipPatterns: [
          /^─{10,}$/, // Separator lines
          /^[>❯]\s*$/, // Prompt line (legacy '>' and new '❯')
          CLAUDE_THINKING_PATTERN, // Thinking indicators
          /^\s*[⎿⏋]\s+Tip:/, // Tip lines
          /^\s*Tip:/, // Tip lines
          /^\s*\?\s*for shortcuts/, // Shortcuts hint
          /to interrupt\)/, // Part of "esc to interrupt" message
          PASTED_TEXT_PATTERN, // [Pasted text #N +XX lines] (Issue #212)
        ],
      };

    case 'codex':
      return {
        promptPattern: CODEX_PROMPT_PATTERN,
        separatorPattern: CODEX_SEPARATOR_PATTERN,
        thinkingPattern: CODEX_THINKING_PATTERN,
        skipPatterns: [
          /^─.*─+$/, // Separator lines
          /^›\s*$/, // Empty prompt line
          /^›\s+(Implement|Find and fix|Type)/, // New prompt suggestions
          CODEX_THINKING_PATTERN, // Activity indicators
          /^\s*\d+%\s+context left/, // Context indicator
          /^\s*for shortcuts$/, // Shortcuts hint
          /╭─+╮/, // Box drawing (top)
          /╰─+╯/, // Box drawing (bottom)
          // T1.3: Additional skip patterns for Codex
          /•\s*Ran\s+/, // Command execution lines
          /^\s*└/, // Tree output (completion indicator)
          /^\s*│/, // Continuation lines
          /\(.*esc to interrupt\)/, // Interrupt hint
          PASTED_TEXT_PATTERN, // [Pasted text #N +XX lines] (Issue #212, defensive)
        ],
      };

    case 'gemini':
      return {
        promptPattern: GEMINI_PROMPT_PATTERN,
        separatorPattern: /^[─━]{3,}$/m,
        thinkingPattern: GEMINI_THINKING_PATTERN,
        skipPatterns: [
          GEMINI_PROMPT_PATTERN, // Prompt line (DRY: shared with GEMINI_PROMPT_PATTERN)
          GEMINI_THINKING_PATTERN, // Thinking indicators
          /^\s*$/, // Empty lines
          /Gemini\s+\d+\.\d+/, // Version line
          PASTED_TEXT_PATTERN, // [Pasted text #N +XX lines]
        ],
      };

    case 'vibe-local':
      return {
        promptPattern: VIBE_LOCAL_PROMPT_PATTERN,
        separatorPattern: /^[·]{10,}$/m, // vibe-local uses middle dot separators
        thinkingPattern: VIBE_LOCAL_THINKING_PATTERN,
        skipPatterns: [
          VIBE_LOCAL_PROMPT_PATTERN, // Prompt line (ctx:N% ❯)
          VIBE_LOCAL_THINKING_PATTERN, // Thinking indicators
          /^\s*$/, // Empty lines
          /vibe-local|vibe-coder/, // Version/banner lines
          /ctx:\s*\d+%/, // Context usage indicator
          /Model\s+\w/, // Model info line
          /Engine\s+\w/, // Engine info line
          /Mode\s+/, // Mode info line
          /RAM\s+/, // RAM info line
          /CWD\s+/, // Working directory line
          /^[·]{10,}$/, // Middle dot separator lines
          /✦\s*Ready/, // Status bar "Ready" indicator
          /ESC:\s*stop/, // Status bar "ESC: stop" hint
          PASTED_TEXT_PATTERN, // [Pasted text #N +XX lines]
        ],
      };

    case 'opencode':
      return {
        promptPattern: OPENCODE_PROMPT_PATTERN,
        separatorPattern: OPENCODE_SEPARATOR_PATTERN,
        thinkingPattern: OPENCODE_THINKING_PATTERN,
        skipPatterns: [...OPENCODE_SKIP_PATTERNS],
      };

    case 'copilot':
      return {
        promptPattern: COPILOT_PROMPT_PATTERN,
        separatorPattern: COPILOT_SEPARATOR_PATTERN,
        thinkingPattern: COPILOT_THINKING_PATTERN,
        skipPatterns: [...COPILOT_SKIP_PATTERNS],
      };

    case 'antigravity':
      return {
        promptPattern: ANTIGRAVITY_PROMPT_PATTERN,
        separatorPattern: ANTIGRAVITY_SEPARATOR_PATTERN,
        thinkingPattern: ANTIGRAVITY_THINKING_PATTERN,
        skipPatterns: [...ANTIGRAVITY_SKIP_PATTERNS],
      };

    default:
      // Default to Claude patterns
      return getCliToolPatterns('claude');
  }
}

// ANSI primitives live in a dependency-free leaf module so client components can
// reuse the same tested pattern without pulling this file's server-only imports
// (logger/db) into the browser bundle. Re-exported here for existing importers.
export { stripAnsi, extractAnsiSequences } from './ansi';

/**
 * Strip box-drawing border characters from CLI output.
 * Gemini CLI wraps Action Required prompts in ╭─╮│╰─╯ borders.
 * Removes │ (U+2502) prefix/suffix and border-only lines (╭╮╰╯─).
 *
 * @param str - Input string (typically after stripAnsi())
 * @returns String with box-drawing borders removed
 */
export function stripBoxDrawing(str: string): string {
  return str.split('\n').map(line => {
    // Remove border-only lines (╭──╮, ╰──╯, │ only, ┃ only, ╹▀▀▀, █ scrollbar, etc.)
    // U+2502 │ (light vertical), U+2503 ┃ (heavy vertical - OpenCode TUI)
    // U+2579 ╹ (heavy up), U+2580 ▀ (upper half block - OpenCode separator)
    // U+2588 █ (full block - OpenCode scrollbar)
    if (/^[\u2502\u2503\u256D\u256E\u256F\u2570\u2500\u2579\u2580\u2588\s]+$/.test(line)) return '';
    // Strip leading whitespace + │/┃ + optional space, trailing space + │/┃/█
    // OpenCode TUI adds 2-space padding before ┃ borders (e.g., "  ┃  content")
    // OpenCode scrollbar █ appears at end of content lines
    return line.replace(/^\s*[\u2502\u2503]\s?/, '').replace(/\s*[\u2502\u2503\u2588]$/, '');
  }).join('\n');
}

/**
 * Error patterns that indicate a Claude session failed to start properly
 * Used by isSessionHealthy() to detect broken sessions (MF-001: SRP)
 * Style: readonly + as const for type safety (SF-S2-001: follows response-poller.ts precedent)
 *
 * SEC-SF-004: Pattern maintenance process:
 * - When Claude CLI is updated, verify that error messages still match these patterns.
 * - Test procedure: Intentionally trigger each error condition (e.g., nested session launch)
 *   and confirm the error message is captured by the patterns.
 * - If Claude CLI introduces localized error messages, add locale-aware patterns or
 *   consider switching to exit code-based detection as a more robust alternative.
 * - Pattern additions should be accompanied by corresponding test cases in
 *   claude-session.test.ts.
 *
 * C-S3-001: Codex/Gemini monitoring note:
 * These patterns are currently Claude-specific. If Codex or Gemini exhibit similar
 * "nested session" or startup failure behaviors, analogous error patterns should be
 * added to their respective tool configurations (codex.ts, gemini.ts) rather than
 * extending these arrays, to maintain SRP per CLI tool type.
 */
export const CLAUDE_SESSION_ERROR_PATTERNS: readonly string[] = [
  'Claude Code cannot be launched inside another Claude Code session',
] as const;

/**
 * Regex patterns for Claude session errors requiring context matching
 * Used by isSessionHealthy() for multi-condition error detection (MF-001: SRP)
 * Style: readonly + as const for type safety (SF-S2-001: follows response-poller.ts precedent)
 *
 * SEC-SF-004: See CLAUDE_SESSION_ERROR_PATTERNS JSDoc for pattern maintenance process.
 */
export const CLAUDE_SESSION_ERROR_REGEX_PATTERNS: readonly RegExp[] = [
  /^Error:.*Claude Code/,
] as const;

/**
 * Build DetectPromptOptions for a given CLI tool.
 * Centralizes cliToolId-to-options mapping logic (DRY - MF-001).
 *
 * prompt-detector.ts remains CLI tool independent (Issue #161 principle);
 * this function lives in cli-patterns.ts which already depends on CLIToolType.
 *
 * [Future extension memo (C-002)]
 * If CLI tool count grows significantly (currently 6), consider migrating
 * to a CLIToolConfig registry pattern where tool-specific settings
 * (including promptDetectionOptions) are managed in a Record<CLIToolType, CLIToolConfig>.
 * Migration threshold: 7th tool addition triggers registry pattern migration [D1-003].
 *
 * @param cliToolId - CLI tool identifier
 * @returns DetectPromptOptions for the tool, or undefined for default behavior
 */
export function buildDetectPromptOptions(
  cliToolId: CLIToolType
): DetectPromptOptions | undefined {
  if (cliToolId === 'claude') {
    return { requireDefaultIndicator: false };
  }
  // [D2-006] OpenCode prompt "Ask anything..." does not use standard indicators (> / ❯),
  // so requireDefaultIndicator must be false to avoid missing prompt detection.
  //
  // [Issue #1896] `hasNumberedDialogs: false` -- opencode 1.18 renders NO dialog
  // that a typed number drives, so the generic numbered-list inference has
  // nothing to find on its pane and every hit it scored was transcript text.
  // Its two interactive surfaces were both measured at the production 80x200
  // geometry and both are cursor-driven:
  //
  //  - the permission dialog is a horizontal button strip
  //    ({@link OPENCODE_PERMISSION_PATTERN}, Issue #1893) driven by ←/→ + Enter;
  //    typing a number does nothing to it.
  //  - the pickers (`/models`, `/providers`, `/connect`, and the ctrl+p command
  //    palette) are fuzzy-search lists driven by ↑/↓ + Enter, with no numbers
  //    drawn at all. The first three are what
  //    {@link OPENCODE_SELECTION_LIST_PATTERN} names; the palette shares the
  //    chrome but not the header allowlist, and lands on `running` / `default`.
  //
  // Both keep their own POSITIVE detection in `status-detector.ts`, so `wait`
  // still stops for them (exit 10 via `isSelectionListActive`) and the UI still
  // renders NavigationButtons: nothing that could be answered before stops being
  // answered. What ends is the false positive -- a response whose body ends in
  // `1. / 2. / 3.` + a question was published as
  // `waiting`/`prompt_detected`/`hasActivePrompt: true`, and Auto-Yes typed `1`
  // into the composer and SENT IT as a user utterance (Issue #1896).
  //
  // `requireDefaultIndicator` is kept at its D2-006 value: it is the correct
  // setting for opencode's ❯-less rendering should the numbered path ever be
  // re-enabled, and it still describes the tool.
  if (cliToolId === 'opencode') {
    return { requireDefaultIndicator: false, hasNumberedDialogs: false };
  }
  // [Issue #545] Copilot prompt pattern may not use standard indicators
  if (cliToolId === 'copilot') {
    return { requireDefaultIndicator: false };
  }
  // [Issue #999] Antigravity (agy) permission-approval menus highlight the
  // default with an ASCII ">" (0x3E), not the "❯/●/›" indicators that
  // DEFAULT_OPTION_PATTERN recognizes, and their footer is "↑/↓ Navigate"
  // (no "press enter to confirm"). Under the default requireDefaultIndicator=true
  // the Pass 1 gate rejects these menus, so Auto-Yes never responds. Treat agy
  // like claude/opencode/copilot so Pass 2 collects its "1. Yes / … / N. No"
  // options and reports isPrompt=true.
  if (cliToolId === 'antigravity') {
    return { requireDefaultIndicator: false };
  }
  return undefined; // Default behavior (requireDefaultIndicator = true)
}
