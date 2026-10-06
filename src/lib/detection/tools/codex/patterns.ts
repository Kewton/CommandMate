/**
 * Codex pattern constants and helpers moved out of `../../cli-patterns.ts`
 * (Issue #3217 I-2). `cli-patterns.ts` re-exports every public name.
 */

import type { NormalizedFrame } from '../types';
import { stripAnsi } from '../../ansi';
import { THINKING_TAIL_LINE_COUNT } from '@/config/thinking-constants';
import { readCodexGlyphRowKind } from './cli-patterns';

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
 * Codex's live status row itself, whatever its header says (Issue #3337).
 *
 * {@link CODEX_THINKING_PATTERN} names the row by a `•` and a fixed list of
 * verbs, and codex-cli 0.160.0 draws the row two ways that list misses
 * (`tests/fixtures/codex-mid-turn-3337/`, a live turn sampled every second):
 *
 *  - the bullet is a spinner that alternates `•` and `◦`, about half the frames
 *    each — so a `◦ Working (43s • esc to interrupt)` frame read `ready`;
 *  - the header is not always a verb from the list — `Reconnecting... waiting
 *    for network` while codex retries the request.
 *
 * Anchored on the parenthesised elapsed time that precedes `esc to interrupt`
 * (`(43s •`, `(1m 00s •`), which only the live row carries. The queued-steer
 * row's `(press esc to interrupt and send immediately)` has no elapsed time,
 * so it does not match — `steer-queued-running.txt` keeps its verdict.
 */
export const CODEX_LIVE_STATUS_ROW_PATTERN =
  /^[•◦]\s.*\((?:\d+h\s*)?(?:\d+m\s*)?\d+s\s*•\s*esc to interrupt\)/m;

/** The row codex prints when a turn is interrupted (Esc), measured on 0.160.0. */
const CODEX_TURN_INTERRUPTED_ROW = /^■ Conversation interrupted\b/;

/**
 * The row codex keeps between the interruption and the composer while a shell
 * the turn started is still running (`1 background terminal running · /ps to
 * view · /stop to close`). Not content of the turn: it says the terminal is
 * alive, not that the agent is.
 */
const CODEX_BACKGROUND_TERMINAL_ROW = /^\d+ background terminals? running\b/;

/**
 * Whether the frame shows a codex turn that was interrupted, as its last word
 * (Issue #3337).
 *
 * The last non-blank row above the composer is `■ Conversation interrupted …`.
 * An interrupted turn fires no `Stop` hook (measured on codex 0.160.0 with the
 * hooks trusted: `UserPromptSubmit`, then nothing, after Esc), so this is the
 * frame that says the agent's own end-of-turn report is not coming. A marker
 * from an earlier turn is not the last row once anything follows it. A
 * background-terminal row between the marker and the composer is skipped — an
 * Esc during `sleep 90 && ls` leaves one there.
 *
 * @param lines - Pane rows, ANSI stripped
 */
export function isCodexTurnInterruptedFrame(lines: readonly string[]): boolean {
  const composer = findCodexComposerRow(lines);
  if (composer < 0) return false;
  for (let i = composer - 1; i >= 0; i--) {
    const row = lines[i].trim();
    if (row === '' || CODEX_BACKGROUND_TERMINAL_ROW.test(row)) continue;
    return CODEX_TURN_INTERRUPTED_ROW.test(row);
  }
  return false;
}

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
 * Codex prompt pattern
 * T1.2: Improved to detect empty prompts as well
 */
export const CODEX_PROMPT_PATTERN = /^›\s*/m;

/**
 * The directory/folder trust dialog's question line, across codex builds
 * (Issue #2884): `Do you trust the contents of this directory?` (<=0.155.1)
 * and `Trust this folder?` (0.157.1, which dropped the "Do you trust" wording
 * entirely -- `tests/fixtures/codex-dialogs-0157/trust.txt`). The two variants
 * are kept as alternatives of one pattern -- rather than duplicated across
 * {@link CODEX_DIALOG_PATTERN}, `getCodexActiveDialog` and
 * `getCodexLifecycleDialog` -- so those three cannot drift into disagreeing
 * about what counts as the trust dialog.
 */
export const CODEX_TRUST_QUESTION_PATTERN = /Do you trust|Trust this folder\?/;

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
 *   - Trust dialog:              {@link CODEX_TRUST_QUESTION_PATTERN}
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
export const CODEX_DIALOG_PATTERN = new RegExp(
  `Skip until next version|${CODEX_TRUST_QUESTION_PATTERN.source}|Press enter to continue|^\\s*›\\s*\\d+\\.\\s`,
  'm',
);

/**
 * Codex genuine input-prompt line (Issue #892).
 *
 * A line whose first non-space glyph is "›" but which is NOT a numbered dialog
 * option ("› 1. ..."). The selected dialog option renders "›" at column 0 too
 * (same column as the live prompt), so the digit-dot negative lookahead is what
 * distinguishes the genuine input line from a dialog option line. Single-line
 * (no /m, no /g) -- callers test it per line to locate the prompt's position.
 */
export const CODEX_GENUINE_PROMPT_LINE = /^\s*›(?!\s*\d+\.)/;

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
 * Index of codex's bottom-most genuine input-prompt row, or -1 (Issue #892).
 *
 * This is codex's live-region composer marker (Issue #3183): the declaration in
 * `tools/codex/live-region.ts` is built on it, so `NormalizedFrame.liveRegion`
 * starts at this row, and the string entries below — which keep a caller that
 * has no `NormalizedFrame` (codex's own launch loop) — read the same row.
 *
 * capturePane returns scrollback, so a dialog that was answered minutes ago is
 * still in the frame; only what sits BELOW the live prompt is still awaiting a
 * key. Shared by getCodexActiveDialog and getCodexLifecycleDialog so the two
 * cannot drift into disagreeing about what "active" means.
 */
export function findCodexComposerRow(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CODEX_GENUINE_PROMPT_LINE.test(lines[i])) return i;
  }
  return -1;
}

/**
 * The rows of codex's ACTIVE region: everything strictly below the composer
 * row, or the whole frame when there is none (Issue #892).
 *
 * A {@link NormalizedFrame} carries that answer already (Issue #3183); a string
 * is read with the same marker, {@link findCodexComposerRow}.
 */
function codexActiveRows(input: string | NormalizedFrame): readonly string[] {
  if (typeof input !== 'string') {
    const region = input.liveRegion;
    if (region.tool === 'codex') {
      return region.anchor === 'composer'
        ? input.contentLines.slice((region.composerEndRow ?? region.startRow) + 1)
        : input.contentLines;
    }
    return codexActiveRows(input.clean);
  }
  const lines = input.split('\n');
  return lines.slice(findCodexComposerRow(lines) + 1);
}

export function getCodexActiveDialog(output: string | NormalizedFrame): CodexActiveDialog {
  // Residual dialog text above a live prompt is excluded, so a dialog lingering
  // in scrollback is never treated as active.
  const active = codexActiveRows(output).join('\n');
  if (active === '') {
    return null;
  }
  if (
    active.includes('Skip until next version') ||
    (active.includes('Update') && active.includes('Skip'))
  ) {
    return 'update';
  }
  if (CODEX_TRUST_QUESTION_PATTERN.test(active)) {
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

/**
 * Classify the bottom-most ACTIVE codex lifecycle screen (Issue #1829).
 *
 * Position-based, via {@link codexActiveRows}: a dialog left in
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
 * @param output - ANSI-stripped pane capture, or a frame `normalizeFrame(…, 'codex')` built
 * @returns The active lifecycle screen, or null when none is
 */
export function getCodexLifecycleDialog(output: string | NormalizedFrame): CodexLifecycleDialog | null {
  const activeLines = codexActiveRows(output);
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
    if (CODEX_TRUST_QUESTION_PATTERN.test(line)) return 'trust';
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
 * Codex CLI tool-call approval FORM footer (Issue #2609).
 *
 * Codex asks for some tool calls through a form rather than the classic
 * approval list, and closes it with a different sentence. Measured on a live
 * Browser use approval (2026-09-17, twice in one session):
 *
 * ```text
 * • Calling 修正前の専用GUIを開く
 *
 *   Field 1/1
 *   Allow Browser use to access http://127.0.0.1:60311?
 *
 *   origin: http://127.0.0.1:60311
 *
 *   › 1. Allow         Run the tool and continue.
 *     2. Always allow  Run the tool and remember this choice for future tool calls.
 *     3. Cancel        Cancel this tool call
 *   enter to submit | esc to cancel
 * ```
 *
 * No `press enter to confirm/select`, so {@link CODEX_SELECTION_LIST_PATTERN}
 * misses it and `detectCodexDialog` returned null for a dialog the status
 * detector reported as `waiting` — which `/prompt-response` read as
 * `prompt_no_longer_active` and Auto-Yes as `unclassified-frame`.
 *
 * Deliberately a separate constant rather than another alternative in
 * CODEX_SELECTION_LIST_PATTERN: that one also drives `detect.ts` branch 0.8, and
 * this footer is consumed ONLY by `detectCodexDialog`'s entry gate. It is the
 * whole measured row and nothing looser — `/m` + `^…$` against the trimmed
 * footer rows `findNumberedOptionBlock` returns, so a sentence that merely
 * contains "enter to submit", or "esc to cancel" on its own (the #1928 mutation
 * that rewords the approval footer), still does not vouch for a block.
 *
 * No /g flag (keeps .test() stateless), no nested quantifiers (ReDoS-safe).
 */
export const CODEX_FORM_SUBMIT_FOOTER_PATTERN = /^enter\s+to\s+submit\s*\|\s*esc\s+to\s+cancel$/im;

/**
 * Codex CLI 0.157 picker footer pattern (Issue #2868).
 *
 * codex-cli 0.157.1 retitled `/model` ("Select Model and Effort") and replaced
 * its "Press enter to confirm or esc to go back" footer with the terse
 * `enter select · esc back` row (measured: `tests/fixtures/codex-dialogs-0157/`).
 * CODEX_SELECTION_LIST_PATTERN no longer matched, so branch 0.8 missed the
 * picker and the dialog entry gate refused the answer (`prompt_no_longer_active`).
 *
 * Same construction as CODEX_FORM_SUBMIT_FOOTER_PATTERN: the whole measured row
 * (`/m` + `^…$`), tested only against a trimmed single footer row — never a
 * window — so a transcript quoting the words does not vouch for anything.
 * CODEX_SELECTION_LIST_PATTERN is deliberately left as is (#2774 / #2841).
 *
 * No /g flag (keeps .test() stateless), no nested quantifiers (ReDoS-safe).
 */
export const CODEX_PICKER_FOOTER_PATTERN = /^enter\s+select\s*·\s*esc\s+back$/im;

/**
 * Codex CLI 0.157 effort-picker footer pattern (Issue #2868).
 *
 * The second `/model` step ("Select Reasoning Level for …") closes with
 * `enter default · s session · esc back` (measured:
 * `tests/fixtures/codex-dialogs-0157/model-picker-effort.txt`). Same
 * construction and rules as CODEX_PICKER_FOOTER_PATTERN: the whole row, tested
 * only against a single trimmed footer row.
 *
 * No /g flag (keeps .test() stateless), no nested quantifiers (ReDoS-safe).
 */
export const CODEX_EFFORT_PICKER_FOOTER_PATTERN = /^enter\s+default\s*·\s*s\s+session\s*·\s*esc\s+back$/im;

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
 * Codex status bar with something drawn AFTER the path (Issue #2818) — the
 * second shape `findCodexFooterBoundary` in `tools/codex/detect.ts` accepts.
 *
 * From codex 0.154.0 on, the bar stops ending in the path once the first turn
 * has named the thread, and Plan mode adds a right-aligned badge:
 *
 * ```text
 *   gpt-5.6-terra low · /private/var/…/repo · Run touch probe.txt
 *   gpt-6-astra medium · ~/uat3-…/sandbox-repo                    Plan mode (shift+tab to cycle)
 * ```
 *
 * {@link CODEX_STATUS_BAR_PATTERN} wants the path last, so every such frame had
 * no boundary and fell to the detector's bar-independent branch D (#1150's
 * safety net). That branch reads the 15-row tail, and on an idle frame the tail
 * still holds the finished turn's `• Ran …` record — which is how an idle
 * session read `running` (#2808's `idle-after-declined-approval.txt`; #2818
 * reproduced it on a turn that simply ran one command and answered).
 *
 * Kept a SEPARATE pattern rather than a widened {@link CODEX_STATUS_BAR_PATTERN}
 * so the change stays on the one reader it was measured for: that pattern is
 * also the stripped-capture landmark of {@link findCodexChromeStart} and the
 * value reader's first test in `model-info-extractor.ts`, neither of which
 * this Issue measured.
 *
 * The shape is the one `CODEX_STATUS_BAR_WITH_TRAILER_PATTERN`
 * (`model-info-extractor.ts`, #2592) reads values off, written out here rather
 * than imported: that module's rule is that it must never be the reason this
 * boundary moves. Head segment, `·`, a path, then EITHER a further `·`
 * segment OR a column gap (two spaces) before right-aligned text. `[^·]*` puts
 * the path right after the FIRST `·`, so codex's in-flight row (`• Working (…)
 * · 1 background terminal running · /ps to view`) is not a bar — its first `·`
 * is followed by a count, not a path.
 *
 * Single-line, no /g, no nested quantifiers (ReDoS-safe), as above.
 */
export const CODEX_TRAILED_STATUS_BAR_PATTERN =
  /^\s*\S[^·]*·\s*~?\/\S*(?:\s*·[^\n]*|[^\S\n]{2,}\S[^\n]*)$/;

/**
 * How far above the last non-blank row {@link findCodexChromeStart} looks for the
 * composer.
 *
 * Same allowance and the same reason as {@link CODEX_COMPOSER_SEARCH_ROWS}: codex
 * pins the composer two to three rows above the bottom in every measured frame
 * (`tests/fixtures/codex-live-2310/`), and a wider band would let the search walk
 * into the transcript and mistake the echoed user message — drawn with the same
 * `›` — for the input box.
 *
 * Wider than the 8 rows of the liveness search because 0.15x can draw notices
 * BELOW the composer (`N background terminal running · /ps to view · /stop to
 * close`) that the liveness search never had to step over.
 */
const CODEX_CHROME_SEARCH_ROWS = 12;

/**
 * A row whose first character is codex's `›` glyph, with something after it.
 *
 * Deliberately not {@link CODEX_PROMPT_PATTERN}: that one is multiline and
 * matches a bare `›`, which is right for "is a prompt on screen anywhere?" and
 * wrong for classifying ONE row. Anchored at column 0 because all three of
 * codex's `›` uses are, and an indented `›` in a reply is quoted text.
 */
const CODEX_CHROME_GLYPH_ROW_PATTERN = /^›(\s|$)/;

/**
 * Locate the start of codex's bottom-pinned chrome within a captured pane.
 *
 * The fifth reader of this shape, after {@link findClaudeChromeStart} (#1289),
 * {@link findCopilotChromeStart} (#1897), {@link findOpenCodeChromeStart}
 * (#1911) and {@link findCommandCodeChromeStart} (#2250). codex is the tool that
 * never got one, and Issue #2400 is the bill for that.
 *
 * codex renders inline and pins two rows to the bottom of a settled pane:
 *
 * ```text
 * › Ask Codex to do anything                      ← composer (placeholder or typed text)
 *
 *   gpt-6-astra xhigh · ~/share/work/…/CommandMate ← status bar (model · cwd)
 * ```
 *
 * Below the composer codex may also draw its own notices (`N background terminal
 * running · /ps to view`), so the boundary is "the composer row" rather than a
 * list of footer shapes: everything from the composer down is chrome by
 * construction, whatever codex adds there next.
 *
 * ## What went wrong without it (#2400)
 *
 * While the capture window is NOT saturated codex's extraction starts at
 * `lastCapturedLine`, so the composer only ever mattered as the `endIndex` break
 * — which the extraction loop already had. Once the pane outgrows
 * `CACHE_MAX_CAPTURE_LINES` (#1670) the cursor stops being a position in the
 * capture and `resolveExtractionStartIndex` switches to the newest echoed user
 * prompt. With no `contentEnd`, that backwards search started at the very bottom
 * of the pane and the first `›` it met was the COMPOSER. Extraction then began
 * on the row after it, i.e. on the status bar, and the saved "reply" for every
 * turn on a saturated pane was one row:
 *
 * ```text
 * gpt-6-astra xhigh · ~/share/work/github_kewton/CommandAgent-develop
 * ```
 *
 * Identical on every turn, so `isDuplicateResponse` then locked on it and the
 * pane could not record another reply at all. That is #1289's defect verbatim,
 * one tool later — the same reason `findCommandCodeChromeStart` exists.
 *
 * ## Why the attributes and not the placeholder text
 *
 * The codex branch of `findRecentUserPromptIndex` used to exclude the composer by
 * naming its placeholders (`Implement`, `Find and fix`, `Type`, `Summarize`).
 * Those are codex 0.1x wording, and 0.15x draws `Ask Codex to do anything`, so
 * the list silently stopped matching the thing it was written for. Issue #2310
 * measured what actually separates codex's three uses of `›` (U+203A), and it is
 * the SGR attributes, not the text: the composer glyph is bold (`ESC[1m›`), a
 * transcript echo is dim (`ESC[1;2m›`), a dialog option carries a bold label or
 * a label drawn in the glyph's own colour (one span — since #2798 a coloured
 * glyph alone is not enough, because 0.155.1 colours the composer's glyph too).
 * {@link readCodexGlyphRowKind} is that measurement, and this reader is one of
 * its callers.
 *
 * `-1` is returned for a frame whose bottom-most `›` is an option row: codex
 * replaces the composer with the dialog, so there is no chrome to trim and the
 * caller resolves the frame on the prompt path instead.
 *
 * ## The stripped-capture fallback
 *
 * Auto-Yes hands the detection layer a capture that has already been through
 * `stripAnsi`, and there every `›` is the same byte — {@link
 * readCodexGlyphRowKind} answers `null` on purpose rather than guessing. This
 * reader still has to answer for those frames, so it falls back to the one
 * structural landmark codex pins BELOW the composer and nowhere else: the status
 * bar ({@link CODEX_STATUS_BAR_PATTERN}, `model · /path`). Requiring it means a
 * frame with no bar — a pane mid-redraw, an overlay — yields `-1` and the
 * pre-#2400 reading, which is the direction that costs nothing.
 *
 * @param lines - Captured pane lines, ANSI-bearing or not; trailing blanks tolerated
 * @returns Index of the composer row, or -1 when no composer chrome is present
 */
export function findCodexChromeStart(lines: readonly string[]): number {
  let lastRow = lines.length - 1;
  while (lastRow >= 0 && stripAnsi(lines[lastRow]).trim() === '') lastRow--;
  if (lastRow < 0) return -1;

  // Bottom-most `›` row within the band codex reserves for its chrome. Anything
  // further up is transcript, and latching onto an echo there would cut the
  // reply this whole reader exists to keep.
  let glyphRow = -1;
  for (let i = lastRow; i >= Math.max(0, lastRow - CODEX_CHROME_SEARCH_ROWS); i--) {
    if (CODEX_CHROME_GLYPH_ROW_PATTERN.test(stripAnsi(lines[i]))) {
      glyphRow = i;
      break;
    }
  }
  if (glyphRow < 0) return -1;

  const kind = readCodexGlyphRowKind(lines[glyphRow]);
  if (kind === 'composer') return glyphRow;
  // A dialog is up (no composer drawn) or the bottom-most `›` is a transcript
  // echo mid-redraw. Neither is chrome to trim.
  if (kind !== null) return -1;

  // Stripped capture: no attributes to read. Accept the row as the composer only
  // when codex's status bar is drawn below it, which is where it always sits and
  // where a transcript echo can never be.
  for (let i = glyphRow + 1; i <= lastRow; i++) {
    if (CODEX_STATUS_BAR_PATTERN.test(stripAnsi(lines[i]))) return glyphRow;
  }
  return -1;
}

/**
 * The shape of a codex row that could be the echo of a message the user sent.
 *
 * Shape only — `›` at column 0 with text after it — which all three of codex's
 * `›` uses share. {@link findCodexUserEchoIndex} is what tells them apart.
 */
export const CODEX_USER_ECHO_PATTERN = /^›\s+\S/;

/**
 * Find the newest transcript echo of an operator message in a codex capture.
 *
 * The reader `findRecentUserPromptIndex` anchors codex turns on (Issue #2400).
 * It replaces a negative lookahead over composer placeholder strings
 * (`(?!Implement|Find and fix|Type|Summarize)`) written against codex 0.1x:
 * 0.15x draws `Ask Codex to do anything`, so the guard matched nothing it was
 * written for. The composer became the newest "echo", and on a saturated pane —
 * the one path where this anchor decides where extraction STARTS (#1670) — the
 * reply saved for every turn was the single status-bar row below it.
 *
 * ## What the attributes can and cannot separate
 *
 * #2310 measured the three uses of `›` and this reader adds the fourth reading
 * they left open, captured for #2400 on codex-cli 0.153.4
 * (`tests/fixtures/codex-live-2310/turn-submitted-no-status.txt`): the echo of
 * a message the operator has JUST submitted is drawn `ESC[1m› ESC[0m<text>` —
 * bold glyph, plain label — and only becomes the dim `ESC[1;2m› ` of the
 * measured frames once the turn settles. That shape is indistinguishable from a
 * composer holding typed text, so no per-row attribute rule can separate them.
 *
 * What separates them is position, which codex's layout fixes: the composer is
 * the BOTTOM-MOST `›` row of a frame. So the reader takes the boundary from its
 * caller:
 *
 * - `composerTrimmed` — `findCodexChromeStart` located the chrome and `lines`
 *   has already been cut above it, so every `›` row left is transcript and the
 *   newest one wins outright.
 * - otherwise — the composer may still be the bottom-most `›` row, so the first
 *   candidate is stepped over. This is the structural spelling of the guard the
 *   placeholder list used to be, and unlike that list it cannot go stale.
 *
 * Dialog option rows are refused wherever they appear: codex renders inline, so
 * a dialog answered minutes ago is still in the scrollback with its options
 * intact (#1160), and anchoring on one would cut the reply mid-way.
 *
 * @param lines - Captured pane rows, ANSI intact where the caller has it
 * @param contentEnd - Exclusive end of the conversation region
 * @param windowSize - How many rows above `contentEnd` to search
 * @param composerTrimmed - Whether `contentEnd` already excludes the composer
 * @returns Index of the newest echo row, or -1 when none is in the window
 */
export function findCodexUserEchoIndex(
  lines: readonly string[],
  contentEnd: number,
  windowSize: number,
  composerTrimmed: boolean,
): number {
  let composerHandled = composerTrimmed;
  for (let i = Math.min(contentEnd, lines.length) - 1; i >= Math.max(0, contentEnd - windowSize); i--) {
    if (!CODEX_USER_ECHO_PATTERN.test(stripAnsi(lines[i]))) continue;

    const kind = readCodexGlyphRowKind(lines[i]);
    // An option row of a dialog still sitting in the scrollback.
    if (kind === 'option') continue;
    // Positively an echo: codex has settled the row and drawn its glyph dim.
    if (kind === 'transcript-echo') return i;

    // `composer` (bold glyph) or `null` (an ANSI-stripped capture, where all
    // three uses are one byte). Either could be the input box, and the input box
    // is always the bottom-most `›` row.
    if (!composerHandled) {
      composerHandled = true;
      continue;
    }
    return i;
  }
  return -1;
}
