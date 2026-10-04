/**
 * Common CLI tool patterns for response detection
 * Shared between response-poller.ts and API routes
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type { DetectPromptOptions } from './types';
import { createLogger } from '@/lib/logger';
import { stripAnsi } from './ansi';
import { isShellPaneCommand } from './shared/shell-pane-command';
import {
  PASTED_TEXT_PATTERN,
  PASTED_TEXT_DETECT_DELAY,
  MAX_PASTED_TEXT_RETRIES,
} from './shared/pasted-text';
import { stripBoxDrawing } from './shared/strip-box-drawing';
import { findClaudeInputBox } from './composer-text';
import {
  CODEX_THINKING_PATTERN,
  CODEX_PROMPT_PATTERN,
  CODEX_SEPARATOR_PATTERN,
} from './tools/codex/patterns';
export {
  CODEX_THINKING_PATTERN,
  CODEX_INTERRUPT_HINT_PATTERN,
  isCodexTurnActive,
  CODEX_PROMPT_PATTERN,
  CODEX_TRUST_QUESTION_PATTERN,
  CODEX_DIALOG_PATTERN,
  CODEX_GENUINE_PROMPT_LINE,
  isCodexPromptReady,
  findCodexComposerRow,
  getCodexActiveDialog,
  CODEX_HOOKS_REVIEW_ANCHORS,
  getCodexLifecycleDialog,
  CODEX_SEPARATOR_PATTERN,
  CODEX_SELECTION_LIST_PATTERN,
  CODEX_APPROVAL_FOOTER_PATTERN,
  CODEX_FORM_SUBMIT_FOOTER_PATTERN,
  CODEX_PICKER_FOOTER_PATTERN,
  CODEX_EFFORT_PICKER_FOOTER_PATTERN,
  CODEX_PAGER_FOOTER_PATTERN,
  CODEX_STATUS_BAR_PATTERN,
  CODEX_TRAILED_STATUS_BAR_PATTERN,
  findCodexChromeStart,
  CODEX_USER_ECHO_PATTERN,
  findCodexUserEchoIndex,
} from './tools/codex/patterns';
export type { CodexActiveDialog, CodexLifecycleDialog } from './tools/codex/patterns';

import {
  OPENCODE_PROMPT_PATTERN,
  OPENCODE_THINKING_PATTERN,
  OPENCODE_SEPARATOR_PATTERN,
  OPENCODE_SKIP_PATTERNS,
} from './tools/opencode/patterns';
export {
  OPENCODE_PROMPT_PATTERN,
  OPENCODE_IDLE_COMPOSER_PATTERN,
  OPENCODE_PROMPT_AFTER_RESPONSE,
  OPENCODE_THINKING_PATTERN,
  OPENCODE_LOADING_PATTERN,
  OPENCODE_RESPONSE_COMPLETE,
  OPENCODE_TURN_COMPLETE_PATTERN,
  OPENCODE_PERMISSION_PATTERN,
  OPENCODE_PROCESSING_INDICATOR,
  OPENCODE_COMPOSER_BOTTOM_BORDER,
  OPENCODE_GUTTER_ROW_PATTERN,
  OPENCODE_USER_ECHO_PATTERN,
  OPENCODE_FOOTER_STATUS_PATTERN,
  findOpenCodeChromeStart,
  findOpenCodeUserEchoEnd,
  findOpenCodeComposerRows,
  stripOpenCodeGutter,
  OPENCODE_SELECTION_LIST_PATTERN,
  OPENCODE_SEPARATOR_PATTERN,
  OPENCODE_SKIP_PATTERNS,
} from './tools/opencode/patterns';
import {
  OPENCODE_V2_IDLE_COMPOSER_PATTERN,
  OPENCODE_V2_THINKING_PATTERN,
  OPENCODE_V2_SKIP_PATTERNS,
} from './tools/opencode-v2/patterns';
export {
  OPENCODE_V2_IDLE_COMPOSER_PATTERN,
  OPENCODE_V2_FOOTER_PATTERN,
  OPENCODE_V2_THINKING_PATTERN,
  isOpencodeV2ComposerVisible,
  OPENCODE_V2_SKIP_PATTERNS,
} from './tools/opencode-v2/patterns';

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

/** The option row of the trust dialog's cursor: `❯` (or legacy `>`) after the dialog's left padding. */
const CLAUDE_TRUST_CURSOR_ROW_PATTERN = /^\s*[>❯]\s+\S/;

/** How far the cursor row may sit from the `Yes, I trust this folder` row (the dialog has two options). */
const CLAUDE_TRUST_MAX_CURSOR_DISTANCE = 3;

/**
 * Keys that answer Claude Code's folder-trust dialog with "Yes", or null when
 * no answerable dialog is on screen (Issue #3078).
 *
 * The dialog comes in two layouts, and Enter alone is only right for one:
 *
 *   - default Yes (Issue #201 era, `tests/unit/lib/claude-session.test.ts`):
 *     ` ❯ 1. Yes, I trust this folder` / `   2. No, exit` — Enter confirms Yes.
 *   - default No (2.1.259 `tests/fixtures/chat-dialog-card-2254/claude-trust-2-1-259.txt`,
 *     2.1.287 with a permission allow-list
 *     `tests/fixtures/claude-trust-dialog-3078/allowlist-default-no-2-1-287.txt`):
 *     ` ❯ No, exit` / `   Yes, I trust this folder` — Enter EXITS Claude Code.
 *
 * So the answer is read off the screen: the distance from the cursor row to the
 * Yes row becomes that many `Up`/`Down` presses, then `Enter`. Only the last
 * dialog in the capture counts, and a dialog followed by Claude's input-box
 * separator is history in the scrollback, not an open dialog.
 *
 * @param output - ANSI-stripped pane output
 * @returns tmux key names ending in `Enter` (just `['Enter']` when the cursor is
 *   already on Yes), or null when no open dialog / no readable cursor row
 */
export function resolveClaudeTrustDialogKeys(output: string): string[] | null {
  const lines = output.split('\n');
  const yesIndex = findOpenClaudeTrustYesRow(lines);
  if (yesIndex === -1) return null;

  for (let distance = 0; distance <= CLAUDE_TRUST_MAX_CURSOR_DISTANCE; distance++) {
    for (const direction of distance === 0 ? [0] : [-1, 1]) {
      const index = yesIndex + direction * distance;
      if (index < 0 || index >= lines.length) continue;
      if (!CLAUDE_TRUST_CURSOR_ROW_PATTERN.test(lines[index])) continue;
      // Cursor above Yes → move Down; below → move Up.
      const key = direction < 0 ? 'Down' : 'Up';
      return [...Array<string>(distance).fill(key), 'Enter'];
    }
  }
  return null;
}

/**
 * Whether Claude Code's folder-trust dialog is the open screen (Issue #3078).
 *
 * The dialog's cursor row (` ❯ No, exit`) has the prompt glyph, so the start
 * wait asks this before CLAUDE_PROMPT_PATTERN rather than reading the dialog as
 * a ready prompt.
 *
 * @param output - ANSI-stripped pane output
 */
export function isClaudeTrustDialogOpen(output: string): boolean {
  return findOpenClaudeTrustYesRow(output.split('\n')) !== -1;
}

export { isShellPaneCommand };

/** Row of the last `Yes, I trust this folder`, or -1 when absent or already answered. */
function findOpenClaudeTrustYesRow(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!CLAUDE_TRUST_DIALOG_PATTERN.test(lines[i])) continue;
    // Claude's input box (separator rows) drawn below it: the dialog is scrollback.
    return lines.slice(i + 1).some((line) => CLAUDE_SEPARATOR_PATTERN.test(line)) ? -1 : i;
  }
  return -1;
}


export { PASTED_TEXT_PATTERN, PASTED_TEXT_DETECT_DELAY, MAX_PASTED_TEXT_RETRIES };

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
 *   "←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel"
 *     (/effort slider footer as of Claude Code v2.1.257 — Issue #3052; before
 *      2.1.257 it was "Enter to confirm · Esc to cancel")
 *
 * The /effort branch keys on "Enter to confirm · s for this session only" rather
 * than "←/→ to adjust": the `s` hint is unique to the pickers (the trust dialog's
 * "Enter to confirm · Esc to cancel" and approval dialogs never carry it), and
 * keeping the match under the `Enter to` prefix leaves the pattern a single
 * linear alternation. Linear, no nested quantifiers — ReDoS safe.
 *
 * The "set as default" branch lets status-detector classify the `/model` overlay
 * as a Claude selection list (NavigationButtons + ESC hatch, hasActivePrompt=false)
 * once detectPrompt() no longer reports it as a prompt (see
 * CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN).
 */
export const CLAUDE_SELECTION_LIST_FOOTER = /Enter\s+to\s+(?:select\s+.*to\s+navigate|confirm\s+·\s+(?:Esc|s\s+for\s+this\s+session\s+only)|set\s+as\s+default)/;

/**
 * The OpenCode V2 dialog title row and its reader (Issue #2971) live in a
 * browser-safe leaf since Issue #2983, because the chat surface's dialog card
 * reads the same row to decide whether v2's model keys may close the dialog
 * first. Re-exported here so every server-side caller keeps one import site.
 */
export {
  OPENCODE_V2_DIALOG_TITLE_PATTERN,
  findOpencodeV2DialogTitle,
} from './tools/opencode-v2/dialog-title';

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
 *
 * Issue #1897: the bare words `Generating` and `Processing` were dropped. This
 * constant is also a member of {@link COPILOT_SKIP_PATTERNS}, so every
 * alternative here doubles as a "delete this line from the saved response" rule
 * and as the tail-window liveness test in `extractResponse`. Those two words are
 * ordinary English -- a reply whose last line reads "Processing complete." had
 * the line deleted AND pinned the turn to "still thinking" for as long as it was
 * on screen, so the response was never saved at all. The remaining alternatives
 * are all glyph- or punctuation-shaped and cannot occur in prose by accident.
 * Nothing is lost as a running signal either: #1885 measured 0 matches for this
 * whole pattern across 44 live generating frames of copilot 1.0.80, whose turn
 * state is read from the status bar by {@link readCopilotStatusBar} instead.
 */
export const COPILOT_THINKING_PATTERN = /[\u2800-\u28FF]|\(Esc to cancel|Reasoning\s+[■▪▮]|\.\.\.\s+Thinking/;

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

/** How far above the bottom row copilot's closing rule may sit. */
const COPILOT_STATUS_BAR_MAX_ROWS = 2;

/** How many rows copilot's composer may span before the block stops looking like chrome. */
const COPILOT_COMPOSER_MAX_ROWS = 40;

/**
 * One of the two rows that fence copilot's composer.
 *
 * Two renderings of one thing, because copilot redrew its composer between the
 * builds this file is measured against (Issue #2269):
 *
 *  - **1.0.80** fences it with a full-width horizontal rule, `─` to the pane's
 *    width, above and below.
 *  - **1.0.82** fences it with a half-block frame instead: `╻` (U+257B) followed
 *    by `▄` to the pane's width above, `╹` (U+2579) followed by `▀` below.
 *
 * The corner glyph is REQUIRED on the 1.0.82 forms and that is load-bearing, not
 * decoration. 1.0.82 also boxes the echoed user prompt in the transcript between
 * two dividers of the same half blocks — `tests/unit/lib/detection/fixtures/
 * copilot-live-2269/turn-complete.txt` rows 10 and 12 — and those carry no
 * corner. Accepting a bare `▄`/`▀` run here would let the newest echo's box be
 * read as the composer, which would put `findCopilotChromeStart` ~985 rows too
 * high and delete the reply along with the chrome.
 */
const COPILOT_RULE_ROW = /^(?:─{10,}|╻▄{10,}|╹▀{10,})$/;

/**
 * copilot's composer glyph, at the pane's own indent.
 *
 * `>` is the legacy spelling, `❯` is 1.0.80's. 1.0.82 draws no prompt glyph in
 * the composer at all: the row is the frame's left edge, `┃` (U+2503), and the
 * operator's text follows it (`copilot-live-2269/boot-idle.txt` row 998 is the
 * bare glyph on an empty composer). `┃` is safe to accept here even though the
 * reasoning block's rows also start with a vertical — that one is `│` (U+2502,
 * {@link COPILOT_BOX_ROW_PATTERN}) — and in any case this test is only ever
 * applied to the single row between two fence rows, never to a window.
 */
const COPILOT_COMPOSER_GLYPH = /^ {0,2}[>❯┃]/;

/**
 * Locate the start of copilot CLI's bottom-pinned chrome within a captured pane
 * (Issue #1897).
 *
 * copilot 1.0.80 runs on the alternate screen and reserves the last five rows of
 * the pane. Measured at the production 200x1000 geometry
 * (`tests/unit/lib/detection/fixtures/copilot-live-1885/`), with the transcript
 * ~970 rows above and nothing but padding in between:
 *
 *     <cwd> [⎇ <branch>]                    Session: N AIC used
 *     ────────────────────  ← opening rule
 *     ❯ <composer>
 *     ────────────────────  ← closing rule
 *      ◉ Working · 1.5 KiB esc interrupt          GPT-5.6 Terra  ← status bar
 *
 * Issue #2269 re-measured the same five rows on 1.0.82, where the fence and the
 * composer are drawn differently but the layout is unchanged:
 *
 *     <cwd>                                          Session: N AIC used
 *     ╻▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  ← opening frame
 *     ┃<composer>
 *     ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀  ← closing frame
 *      ← open sidebar · / commands · ? help · tab next tab   GPT-5.6 Terra
 *
 * Both spellings live in {@link COPILOT_RULE_ROW} and
 * {@link COPILOT_COMPOSER_GLYPH}; the search below is unchanged. Until they were
 * added this function returned -1 on every 1.0.82 frame, `contentEnd` fell back
 * to the whole pane, and the saved reply opened with 199 `▀` and ended with the
 * `← open sidebar …` footer -- #2269's headline symptom.
 *
 * The boundary is found structurally -- closing rule, opening rule, composer
 * glyph -- and never by matching the status bar's wording. That is the same
 * reasoning {@link findClaudeChromeStart} records (#1289) plus the measurement
 * behind {@link COPILOT_WORKING_STATUS_PATTERN}: copilot will print its own
 * status-bar vocabulary as body text when asked to
 * (`status-vocabulary-in-response.txt` holds ` ● Working esc interrupt` as a
 * reply), so a vocabulary rule strong enough to delete the real bar also deletes
 * that reply. Position is the only thing that separates them.
 *
 * Without this trim the bar is transcript as far as every consumer is concerned:
 * it reached the TUI accumulator on every poll and was saved to History as the
 * agent's answer (#1897's headline symptom, ` Working esc interrupt GPT-5.6
 * Terra`), and its spinner glyph and byte counter change on every tick, so it
 * also defeats the content dedup the alternate-screen tools rely on (#1268).
 *
 * @param lines - Captured pane rows, ANSI-bearing or not; trailing blanks tolerated
 * @returns Index of the first chrome row, or -1 when the pane carries no chrome
 *   (a permission dialog draws its box over the whole bottom of the pane, so
 *   there is no composer and no bar -- those frames return -1 and are left to
 *   `detectPrompt`, exactly as {@link readCopilotStatusBar} leaves them)
 */
export function findCopilotChromeStart(lines: readonly string[]): number {
  const isRule = (line: string): boolean => COPILOT_RULE_ROW.test(stripAnsi(line).trim());

  let lastRow = lines.length - 1;
  while (lastRow >= 0 && stripAnsi(lines[lastRow]).trim() === '') lastRow--;
  if (lastRow < 0) return -1;

  let closingRule = -1;
  for (let i = lastRow; i >= Math.max(0, lastRow - COPILOT_STATUS_BAR_MAX_ROWS); i--) {
    if (isRule(lines[i])) {
      closingRule = i;
      break;
    }
  }
  if (closingRule < 0) return -1;

  let openingRule = -1;
  for (let i = closingRule - 1; i >= Math.max(0, closingRule - COPILOT_COMPOSER_MAX_ROWS); i--) {
    if (isRule(lines[i])) {
      openingRule = i;
      break;
    }
  }
  if (openingRule < 0) return -1;

  // Confirm the fenced rows are the composer rather than a reply that happens to
  // sit between two horizontal rules.
  if (!COPILOT_COMPOSER_GLYPH.test(stripAnsi(lines[openingRule + 1] ?? ''))) return -1;

  // The row above the opening rule is copilot's cwd/branch/session header, which
  // an overlay (the `/model` picker) replaces with a blank rather than with
  // transcript -- measured on all five non-dialog fixtures.
  return Math.max(0, openingRule - 1);
}

/**
 * A row copilot draws as part of a box or a collapsed reasoning block
 * (Issue #1897).
 *
 * 1.0.80 renders the model's private reasoning as a `⌄ Thought for 41s` header
 * followed by rows that each begin `│ `, and draws dialogs inside `╭─╮`/`╰─╯`
 * frames. {@link COPILOT_SKIP_PATTERNS} already carries a `[╭╮╰╯│]` rule, but
 * `normalizeCopilotLine` deletes every U+2500..U+257F glyph *before* the skip
 * patterns are applied, so by the time that rule runs the row it is meant to
 * catch reads as ordinary prose -- which is how the TUI accumulator came to save
 * copilot's chain-of-thought as the reply. Matched against the ANSI-stripped row,
 * before normalisation.
 *
 * `─` is deliberately absent: a rule row is {@link COPILOT_SEPARATOR_PATTERN}'s
 * job, and `── heading ──` is content.
 */
export const COPILOT_BOX_ROW_PATTERN = /^\s*[│└╰╭╮╯├┤┬┴┼]/;

/**
 * copilot's collapsed-section header (Issue #1897).
 *
 * Measured on 1.0.80: `⌄ Thinking…` while the reasoning block is live, replaced
 * by `⌄ Thought for 41s` once the turn moves on. Anchored on the `⌄` disclosure
 * glyph rather than on the words, because "Thinking…" also occurs as body text
 * -- `status-vocabulary-in-response.txt` contains exactly that row as a reply,
 * and it must survive cleaning.
 */
export const COPILOT_REASONING_HEADER_PATTERN = /^\s*⌄\s/;

/**
 * copilot's echo of the operator's own prompt in the transcript (Issue #1897).
 *
 * 1.0.80 draws every transcript row at the pane's one-column indent -- ` ❯ Reply
 * with exactly the word: pong` -- while the composer at the bottom of the pane is
 * at column 0. The bare `^[>❯]` form therefore never matched the echo, so
 * `resolveExtractionStartIndex`'s copilot branch found no anchor, fell back to
 * line 0, and handed the launch banner to the cleaner as the turn's reply.
 *
 * Bounded to two leading spaces rather than `\s*` so a quoted `> …` line inside a
 * reply cannot be mistaken for a new turn boundary.
 */
export const COPILOT_USER_ECHO_PATTERN = /^ {0,2}[>❯]\s+\S/;

/**
 * One of the half-block dividers copilot 1.0.82 boxes a transcript row with
 * (Issue #2269).
 *
 * 1.0.80 drew the echoed prompt as a single bare ` ❯ <text>` row. 1.0.82 draws
 * a full-width `▄` run above it and a full-width `▀` run below it
 * (`copilot-live-2269/turn-complete.txt` rows 10 and 12):
 *
 *      ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
 *       ❯ Reply with exactly the word: uat-run1   00:27
 *      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 *      ● uat-run1
 *
 * {@link COPILOT_SKIP_PATTERNS}' `/[█▘▝▖▗▔▄▌▐]/` rule already dropped the `▄`
 * row. `▀` (U+2580) was not in that class, so the row BELOW the echo survived --
 * and extraction starts one row past the echo, which made a wall of 199 `▀` the
 * first line of every saved 1.0.82 reply.
 *
 * Deliberately not "add `▀` to that character class": this requires a run of ten
 * or more and nothing else on the row, so a reply that happens to use a single
 * half block as a glyph is untouched. The optional leading corner accepts the
 * composer's own fence rows (`╻▄…` / `╹▀…`) as well, which is defence in depth
 * only -- {@link findCopilotChromeStart} cuts those structurally, and this rule
 * is what stops them reaching History if a future build moves the fence again.
 */
export const COPILOT_TRANSCRIPT_DIVIDER_PATTERN = /^\s*[╻╹]?[▀▄]{10,}\s*$/;

/**
 * The verbs copilot prints on a tool row, as a regex alternation source.
 *
 * One list, shared by {@link COPILOT_TOOL_ROW_PATTERN} here and by
 * `COPILOT_TOOL_ACTION_PATTERN` in `response-cleaner.ts`: the two match the same
 * vocabulary behind different markers, and a verb added to one and not the other
 * is a leak nothing fails on.
 *
 * `Asked user` / `Asking user` are Issue #2269's addition. copilot answers a
 * prompt it cannot act on by calling its ask-user tool, and the row it leaves in
 * the transcript (`● Asked user What would you like me to help with?`, measured
 * in `copilot-live-2269/turn-oneword-echo-askuser.txt`) was being saved as the
 * agent's reply -- the "launch screen as the answer" the Issue reports.
 */
export const COPILOT_TOOL_VERBS =
  'Get|Read|Run|Search|Write|Edit|Delete|List|Create|Fetch|Explore|Execute|Install|Asked user|Asking user|Model changed to:';

/**
 * copilot 1.0.82's tool row, whose marker is a file-type badge (Issue #2269).
 *
 * 1.0.80 drew every tool row as `● <Verb> …` and `COPILOT_TOOL_ACTION_PATTERN`
 * reads exactly that. 1.0.82 puts a short badge for the file the tool touched in
 * front of the verb instead, and only falls back to `●` for a type it has no
 * badge for. Measured verbatim over
 * `copilot-live-2269/turn-tool-badges.txt` and `turn-tool-rows.txt`:
 *
 *     / Search "a.ts" 1 file found
 *     MD Read note.md L1:1 (1 line read)
 *     TS Read a.ts 1 line read
 *     PY Read c.py 1 line read
 *     {} Read b.json 1 line read
 *     ● Read d.txt 1 line read          ← plain text keeps the 1.0.80 marker
 *
 * So the badge is `/`, `{}`, or two to four upper-case characters. Two is the
 * floor on purpose: a one-character class would also match the pronoun in an
 * English sentence ("I Read the file"), and no measured badge is one character.
 * `●` is left to `COPILOT_TOOL_ACTION_PATTERN`, which is the rule that already
 * owns it -- copilot's own prose is `● <text>` too (`● done`, `● 対象ファイルを
 * 確認して内容を読み込みます。`), and only the verb list separates the two.
 *
 * The `$` badge is absent for the same reason: `$ Shell Print requested text 2
 * lines…` opens a BLOCK whose command rows follow, which is
 * `COPILOT_TOOL_INVOCATION_PATTERN`'s job, and `Shell` is not in the verb list
 * anyway.
 *
 * No /g flag (S4-5: would make test() stateful). No quantifier nested inside
 * another (SEC4-001: ReDoS safe).
 */
export const COPILOT_TOOL_ROW_PATTERN = new RegExp(
  `^\\s*(?:\\/|\\{\\}|[A-Z][A-Z0-9+#]{1,3})\\s+(?:${COPILOT_TOOL_VERBS})[\\s:]`,
);

/**
 * A wrapped continuation of the copilot transcript row above it (Issue #1897).
 *
 * Marker rows (` ❯ `, ` ● `, ` $ `, ` ⌄ `) carry one leading space; the rows they
 * wrap onto are indented further and carry no marker, and a blank row separates
 * one block from the next (measured on 1.0.80 at 200x1000). Used to walk past the
 * tail of a long *user* prompt so the extracted reply does not open with the
 * second half of the operator's own question.
 */
export const COPILOT_TRANSCRIPT_CONTINUATION_PATTERN = /^ {2,}\S/;

/**
 * Rows that only copilot's first-launch screen draws (Issue #1897).
 *
 * The launch screen is a complete, idle frame: the composer is drawn, the status
 * bar shows key hints, and nothing about it says "no turn has happened yet". So
 * `extractResponse` classified it as a finished response and History opened with
 * the banner as the agent's first message -- before the operator's first prompt.
 *
 * These anchors are only ever consulted for a frame that carries no echoed user
 * prompt at all (see the copilot banner guard in `extractResponse`), which is
 * what keeps a reply that quotes any of this wording from being suppressed.
 */
export const COPILOT_BOOT_BANNER_ANCHORS: readonly RegExp[] = [
  /No copilot-instructions\.md found/,
  /Copilot uses AI, so always check for mistakes\./,
  /Copilot v\d[\w.]*\s+uses AI/,
  /^\s*(?:●\s+)?GitHub Copilot\s+v\d/m,
  /^\s*(?:●\s+)?Tip:\s*\//m,
  /Describe a task to get started/,
  /Prefer a visual workspace\?/,
  // Issue #2269: copilot's greeting for a prompt it cannot act on. It arrives
  // through the ask-user tool, so the row that reaches the transcript is
  // `● Asked user Hi — what would you like to work on?` and the dialog's own
  // body repeats the question. Both are chrome for a turn that produced no
  // answer, and the operator saw the greeting saved as the agent's reply.
  /what would you like to work on\?/i,
] as const;

/**
 * The key-hint footer copilot draws under a picker, matched one ROW at a time
 * (Issue #547; rewritten against live 1.0.80 frames by Issue #1895).
 *
 * The pattern this replaced --
 * `/Search\s+\w+\.\.\.|Select\s+Model|to (?:navigate|select).*Enter to (?:select|confirm)/`
 * -- matched **none** of the eleven pickers 1.0.80 opens (measured; the frames
 * are in `tests/unit/lib/detection/fixtures/copilot-picker-1895/`, and #1885 /
 * #1886 / #1913 reached the same result independently). `/model` renders
 * `❯  Search models…` with U+2026 rather than three periods, no picker carries
 * the words `Select Model`, and every footer spells its verbs in lower case.
 *
 * What all eleven footers do share is the shape of a key-hint bar: `·`-separated
 * hints carrying either arrow-key navigation or a lower-case dismiss verb.
 * Measured verbatim, bottom-most first:
 *
 *   /model       ↑/↓ to navigate · ←/→ reasoning effort · tab context window ·
 *                shift+tab group: recommended · enter to select · esc to cancel
 *   /agent       n new agent · ? learn more · esc cancel
 *   /theme       ↑/↓ to navigate · enter to select · esc to cancel
 *   /permissions 1-2 to select · ↑/↓ to navigate · enter to confirm · esc to cancel
 *   /skills      ↑/↓ to navigate · enter to toggle · esc to close
 *   /mcp         ↑/↓ to select · enter to show · a to add · esc to close
 *   /settings    / search · ↑/↓ navigate · tab switch scope · enter edit ·
 *                ctrl+r reset · ctrl+e editor · esc close
 *   /statusline  ↑/↓ nav · enter toggle · esc close
 *   /subagents   ↑/↓ to navigate · space on/off · r reset · enter to select · esc to cancel
 *   /resume      / search · ↑/↓ navigate · enter select · ←/→ switch tabs · r refresh ·
 *                x delete · s sort:relevance · esc cancel
 *   /session     / search · ↑/↓ navigate · enter open · n new · tab switch tabs · a filter:all
 *
 * Neither half of the alternation is universal -- `/agent` has no list to walk
 * so it prints no `↑/↓`, and `/session` offers no `esc` -- but every footer has
 * one of them, so the union covers 11/11 while each individual disjunct stays
 * specific enough to be worth requiring. The slash in `↑/↓` is optional only as
 * a rewording tolerance: the synthetic frames pinned since Issue #547 spell it
 * `↑↓`, and whether copilot ever drew it that way is not something this Issue
 * measured. Every 1.0.80 footer above has the slash.
 *
 * Three deliberate narrowings keep this off ordinary text:
 *  - the `·` lookahead, so a sentence such as "press esc to cancel" is not a
 *    footer unless it is also a hint bar;
 *  - lower case, which is what 1.0.80 draws. `(Esc to cancel · 2.3 KiB)` -- the
 *    capitalised spelling in {@link COPILOT_THINKING_PATTERN} -- is a *progress*
 *    row, and it would otherwise satisfy both halves of this pattern;
 *  - `cancel|close` only, so the status bar's `esc interrupt`
 *    ({@link COPILOT_WORKING_STATUS_PATTERN}) is not a footer either.
 *
 * The narrowings are defence in depth; the load-bearing guard is positional and
 * lives in {@link isCopilotSelectionFrame} -- copilot's own answer text can and
 * does contain these exact rows (`picker-vocabulary-in-response.txt` is a live
 * frame of it), so no window-scoped match on this vocabulary can be safe.
 *
 * No /g flag (S4-5: would make test() stateful). `[^\n]*` cannot cross a row and
 * no quantifier is nested inside another (SEC4-001: ReDoS safe).
 */
export const COPILOT_SELECTION_FOOTER_PATTERN =
  /^(?=[^\n]*·)[^\n]*(?:↑\/?↓|\besc\s+(?:to\s+)?(?:cancel|close)\b)/m;

/**
 * How many non-blank rows up from the bottom of the pane may carry the footer.
 *
 * Nine of the eleven pickers put it on the bottom row itself; `/agent` and
 * `/subagents` draw their panel with a closing full-width rule underneath it,
 * which puts the footer two non-blank rows up. Three is that measurement plus
 * one row of slack -- deliberately far short of a window that could reach the
 * transcript, which on the production 200x1000 geometry sits ~950 rows above.
 */
const COPILOT_SELECTION_FOOTER_SCAN_ROWS = 3;

/**
 * Whether the pane is sitting on one of copilot's pickers (Issue #1895).
 *
 * Takes the whole frame rather than a window for the same reason
 * {@link readCopilotStatusBar} does: the evidence is positional, and a call site
 * cannot be trusted to preserve "near the bottom of the pane" on its own. Two
 * facts, both measured on 1.0.80, make the position sufficient:
 *
 *  - **A picker replaces copilot's chrome.** In the idle and generating states
 *    the bottom five rows are cwd / rule / composer / rule / status bar; while a
 *    picker is up, none of them are drawn. So a frame whose bottom row is a
 *    status bar is not a picker, whatever its transcript says -- which is the
 *    whole of the false-positive half of Issue #1895. `detectSessionStatus`
 *    reads the same row for the running verdict at step 0.5, so checking it
 *    first here also fixes the order between the two branches: the status bar
 *    wins, and the picker branch only speaks when copilot has taken it away.
 *  - **An answerable dialog is drawn inside a box; a picker is not.** The
 *    folder-trust and permission dialogs wear the same lower-case
 *    `↑/↓ to navigate · enter to select · esc to cancel` footer, but every one of
 *    their rows reads `│ … │` and the bottom row is `╰─…─╯`. Skipping boxed rows
 *    keeps those on the prompt branch, where they belong: they are the agent
 *    blocked on the human (`hasActivePrompt: true`, exit 10 for `wait`), not a
 *    list the operator opened.
 *
 * @param contentLines - Frame rows, ANSI already stripped, in pane order
 * @returns True when the bottom of the pane is a picker's key-hint footer
 */
export function isCopilotSelectionFrame(contentLines: readonly string[]): boolean {
  if (readCopilotStatusBar(contentLines) !== null) return false;

  let scanned = 0;
  for (let i = contentLines.length - 1; i >= 0; i--) {
    const row = contentLines[i];
    const trimmed = row.trim();
    if (trimmed === '') continue;
    if (++scanned > COPILOT_SELECTION_FOOTER_SCAN_ROWS) break;
    // A boxed row belongs to a dialog, not a picker (see above).
    if (trimmed.startsWith('│') || trimmed.endsWith('│')) continue;
    if (COPILOT_SELECTION_FOOTER_PATTERN.test(row)) return true;
  }
  return false;
}

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
  // Issue #1895 replaced COPILOT_SELECTION_LIST_PATTERN with the row-scoped
  // picker footer; the vocabulary it carried (`Search \w+...` / `Select Model`)
  // is copilot's prose, not its chrome.
  COPILOT_SELECTION_FOOTER_PATTERN,
  // Collapsed reasoning header (Issue #1897): "⌄ Thinking…" / "⌄ Thought for 41s"
  COPILOT_REASONING_HEADER_PATTERN,
  // 1.0.82's transcript dividers and badge-marked tool rows (Issue #2269)
  COPILOT_TRANSCRIPT_DIVIDER_PATTERN,
  COPILOT_TOOL_ROW_PATTERN,
  // Issue #2269: the anchored box-row rule, so the raw-row consumer agrees with
  // the accumulator. `[╭╮╰╯│]` below is unanchored and omits `└`, which is the
  // glyph copilot opens a detail row with (`   └ Enable all permissions (tools,
  // paths, and URLs)` under the launch screen's tip). `normalizeCopilotLine`
  // deletes every U+2500..U+257F glyph, so by the time the skip patterns run in
  // `cleanCopilotResponse` that row reads as prose -- which is how the ONE row
  // of the 1.0.82 launch screen that no other rule caught became the agent's
  // first reply. `extractCopilotContentLines` already tests this pattern before
  // normalising (#1897); adding it here is what gives `extractResponse`, which
  // never normalises, the same answer.
  COPILOT_BOX_ROW_PATTERN,
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
  // Tip/hint lines. Issue #2269 added the `●` marker: 1.0.82 draws the launch
  // screen's tip as `● Tip: /allow-all`, and `cleanCopilotResponse` strips the
  // bullet only AFTER the skip patterns have run, so the bare form never
  // matched and the tip was the one banner row that reached History.
  /^\s*(?:●\s+)?Tip:\s*\//,
  // Issue #2269: copilot's own tab bar, the top row of every 1.0.82 frame. It is
  // the second banner row the launch screen leaked (the logo, the disclaimer and
  // the tip's `└ …` detail row are all caught by the glyph rules above), and
  // between them they are the whole difference between "the launch screen cleans
  // to nothing and cannot be saved" and "History opens with the banner". Spelled
  // out in full rather than as a keyword so a reply that mentions one of these
  // words is untouched.
  /^\s*Current\s+Sessions\s+Issues\s+Pull requests\s+Gists\s*$/,
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
 * The banner agy paints INTO its empty input box while a non-default permission
 * mode is on (Issue #2592).
 *
 * Measured on agy 1.2.4 in the #2592 UAT
 * (`tests/fixtures/agent-mode-2592/antigravity-{accept-edits,plan}.txt`, row 18,
 * between the box's two rules):
 *
 *   `> Accept-edits mode: file edits auto-approved (shift+tab to cycle)`
 *   `> Plan mode: research & plan only (shift+tab to cycle)`
 *
 * It takes the place of the bare `>` an empty box shows in default — it is a
 * placeholder, not typed text — so a reader that only accepts the bare glyph
 * reads an idle accept-edits / plan pane as "no input box at all". Before this
 * pattern existed that is exactly what happened: the status detector fell through
 * to its `default` floor (`running` + `isUnclassifiedActive`), `commandmate ls`
 * showed a resting agent as running, `wait` never completed, and
 * `isAntigravityReady` refused every send. #2592 made those two modes one click
 * away, so the hole had to close with it.
 *
 * The structure is matched rather than the two sentences: `<Name> mode: <text>
 * (shift+tab to cycle)`, anchored on the key hint agy ends every banner with, so
 * a third mode needs no edit here. What stays out is anything a user could have
 * typed into the box — the trailing hint is the part nobody types.
 *
 * Whole-row, no `/g`, no nested quantifiers (`[^\n]*` is followed by a literal).
 */
export const ANTIGRAVITY_COMPOSER_MODE_BANNER_SOURCE =
  '>[^\\S\\n]+[A-Z][A-Za-z-]*[^\\S\\n]mode:[^\\n]*\\(shift\\+tab to cycle\\)[^\\S\\n]*';

/** {@link ANTIGRAVITY_COMPOSER_MODE_BANNER_SOURCE} as a single-row pattern. */
export const ANTIGRAVITY_COMPOSER_MODE_BANNER_PATTERN = new RegExp(
  `^${ANTIGRAVITY_COMPOSER_MODE_BANNER_SOURCE}$`,
  'm',
);

/**
 * Antigravity (agy) interactive REPL prompt pattern (Issue #988)
 * agy shows a bare ">" input box line when waiting for user input. The input box
 * is always rendered (even while generating), so prompt presence alone does not
 * mean "ready" — running vs idle is resolved together with the thinking pattern /
 * footer status bar in status-detector.ts. (Confirmed on machine: line is "> ".)
 *
 * Issue #2592: or the mode banner that replaces the bare glyph in an EMPTY box
 * while accept-edits / plan is on ({@link ANTIGRAVITY_COMPOSER_MODE_BANNER_PATTERN}).
 * Every consumer of this pattern is asking "is agy's input box drawn and empty?"
 * — the idle rule in `detection/tools/antigravity/detect.ts`, the survey guard
 * beside it, `isAntigravityReady` (the send gate) and the liveness probe — and
 * the answer does not depend on the permission mode, so the banner is folded in
 * here once rather than at each of them.
 */
export const ANTIGRAVITY_PROMPT_PATTERN = new RegExp(
  `^(?:>\\s*|${ANTIGRAVITY_COMPOSER_MODE_BANNER_SOURCE})$`,
  'm',
);

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
 * The `↑/↓ Navigate` hint agy draws under every arrow-key screen it owns
 * (Issue #2364; measured on agy 1.1.27, pane 200x1000, 2026-09-06).
 *
 * The same token {@link ANTIGRAVITY_SELECTION_LIST_PATTERN} matches, split out
 * because the numbered-dialog reader anchors on THIS row and reads upward from
 * it. It is the one thing all four measured agy dialogs share — the `Do you want
 * to proceed?` command menu, the `Allow creation of this file?` file menu, the
 * folder-trust screen and the `/model` picker all end on it — while the words
 * after it differ on every one (`tab Amend · f full diff`, `tab Amend · ctrl+g
 * edit/expand command`, `enter Confirm`, `←/→ Effort  enter Select`).
 */
export const ANTIGRAVITY_NAVIGATE_FOOTER_PATTERN = /↑\/↓\s*Navigate/;

/**
 * One numbered option row of agy's dialogs: `> 1. Yes`, `  4. No`,
 * `  2. No, deny creation`.
 *
 * The `>` gutter marks the highlighted row and is optional, because only one
 * of the rows carries it.
 */
export const ANTIGRAVITY_NUMBERED_OPTION_PATTERN = /^\s*>?\s*\d+\.\s+\S/m;

/**
 * The header of agy's `/model` picker (Issue #995).
 *
 * Kept as its own exclusion even though the picker's rows already fail the
 * numbered-row test: the Issue #2364 rule is written as "footer + numbered rows
 * + NOT the Switch Model picker", and the picker is the one agy screen whose
 * misreading has a measured cost (#995: NavigationButtons vanished).
 */
export const ANTIGRAVITY_SWITCH_MODEL_HEADER_PATTERN = /^\s*Switch Model\s*$/;

/**
 * A row that ends the dialog block when reading UPWARD from the footer
 * (Issue #2364).
 *
 * Everything agy draws above its own dialog panel carries one of these:
 *
 *  - a horizontal rule (the turn separator, the input-box border, or the rule
 *    under the `Command` / `Create file` panel header);
 *  - a `>`-prefixed row that is not a numbered option — the echoed user prompt,
 *    the bare composer, the highlighted row of an UNNUMBERED picker (`> Gemini
 *    3.8 Flash`, `> Yes, I trust this folder`) or of the slash-command popup
 *    (`> /add-dir  Add a directory …`);
 *  - a `●` tool-call row, a `⎿` tool-result row or a `▸ Thought for …` row.
 *
 * Bounding the block at the nearest one is what keeps a numbered list in the
 * MODEL'S PROSE, sitting in the transcript above an open picker or popup, from
 * being adopted as that screen's options. Wrapped option labels never start
 * with any of these on the measured frames: agy prints the command text inside
 * the quotes of `… commands that start with '<cmd>'`, indented under the row
 * that opened it.
 *
 * `stripBoxDrawing` blanks the rule rows before the response poller's copy of
 * the frame reaches this rule; the `●` / `>` rows survive it, so the block is
 * bounded the same way on both paths.
 */
export const ANTIGRAVITY_DIALOG_BOUNDARY_PATTERN = /^\s*(?:─{3,}\s*$|[●⎿▸]|>(?!\s*\d+\.\s+\S))/;

/**
 * How many rows above the `↑/↓ Navigate` footer the dialog block may reach.
 *
 * The tallest measured frame (`dialog-bash-wrapped.txt`: header, rule,
 * `Requesting permission for:`, a four-row command, the question and four
 * options of which two wrap onto three rows each) spans 18 rows; the cap leaves
 * room for a longer command without letting a boundary-free frame drag the
 * whole transcript into the block.
 */
export const ANTIGRAVITY_DIALOG_MAX_ROWS = 60;

/**
 * agy's post-answer survey row (Issue #2364).
 *
 * Drawn once, in place of the composer, after some tool decisions:
 *
 * ```
 *  How's the CLI experience so far? Help us improve:
 *  [1] Good  [2] Fine  [3] Bad  [0] Skip
 *
 * ? for shortcuts …
 * ```
 *
 * Every option sits on ONE row in `[N] label` form and the screen takes a
 * typed digit, not the arrow keys; there is no `↑/↓ Navigate` footer and no bare
 * `>` composer, so before this pattern existed the frame reached the `default`
 * floor — `running`, with the chat surface showing "generating" over a screen
 * that was waiting for a keypress. Anchored to the whole row.
 */
export const ANTIGRAVITY_SURVEY_PATTERN = /^\s*\[1\]\s*Good\s+\[2\]\s*Fine\s+\[3\]\s*Bad\s+\[0\]\s*Skip\s*$/m;

/** Where agy's dialog block sits on a frame — see {@link locateAntigravityDialogRegion}. */
export interface AntigravityDialogRegion {
  /** Index of the first row that may belong to the dialog (just below the nearest boundary). */
  readonly start: number;
  /** Index of the `↑/↓ Navigate` footer row. */
  readonly footer: number;
}

/**
 * Find the rows between the last boundary and the last `↑/↓ Navigate` footer
 * (Issue #2364).
 *
 * The footer is searched from the bottom, so an older dialog still in the
 * scrollback above a newer one is never the one read. Returns null when the
 * frame has no footer at all.
 *
 * Also null when agy's input box is drawn BELOW that footer (Issue #2845): agy
 * paints no `>` composer while a dialog is open — the dialog takes its place —
 * so a footer with a composer under it is the model's reply quoting a dialog,
 * or a dialog left in the scrollback, not a screen waiting for a keypress. It is
 * the same reading `isAntigravitySurveyOpen` gives the survey row (#2364), and
 * the composer is recognised by the same {@link ANTIGRAVITY_PROMPT_PATTERN}.
 *
 * @param lines - ANSI-stripped rows, box drawing optional
 */
export function locateAntigravityDialogRegion(lines: readonly string[]): AntigravityDialogRegion | null {
  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ANTIGRAVITY_NAVIGATE_FOOTER_PATTERN.test(lines[i])) {
      footer = i;
      break;
    }
  }
  if (footer < 0) return null;
  for (let i = footer + 1; i < lines.length; i++) {
    if (ANTIGRAVITY_PROMPT_PATTERN.test(lines[i])) return null;
  }

  const floor = Math.max(0, footer - ANTIGRAVITY_DIALOG_MAX_ROWS);
  let start = floor;
  for (let i = footer - 1; i >= floor; i--) {
    if (ANTIGRAVITY_DIALOG_BOUNDARY_PATTERN.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  return { start, footer };
}

/**
 * Is this frame one of agy's NUMBERED dialogs rather than one of its
 * arrow-key-only pickers? (Issue #2270, re-measured by Issue #2364)
 *
 * Both kinds of screen share the `↑/↓ Navigate` footer that
 * {@link ANTIGRAVITY_SELECTION_LIST_PATTERN} matches, which is why #997 could
 * widen that pattern to cover the permission menu — and why the menu then
 * resolved as `antigravity_selection_list`, `hasActivePrompt: false`. On the
 * chat surface that reads as "a selection list is open, drive it from the
 * terminal": the arrow buttons can only Enter the highlighted option 1, so
 * options 2-4 became unreachable, while the poller and the push notification
 * described the very same frame as a `multiple_choice` prompt.
 *
 * #2270 told the two apart by the question line, `Do you want to proceed?`,
 * because that was the one dialog it had measured. #2364 measured a second one
 * — agy 1.1.27's file-creation menu asks `Allow creation of this file?` above
 * `1. Yes, allow creation` / `2. No, deny creation` — and it fell straight back
 * into the selection-list reading. So the rule is now about the STRUCTURE the
 * dialogs share and the pickers lack:
 *
 *  - the `↑/↓ Navigate` footer,
 *  - at least two `N. label` rows between the nearest boundary row and that
 *    footer ({@link ANTIGRAVITY_DIALOG_BOUNDARY_PATTERN}), and
 *  - no `Switch Model` header in that region.
 *
 * The Switch Model picker, the folder-trust screen and the slash-command popup
 * all draw unnumbered rows (`> Gemini 3.8 Flash`, `> Yes, I trust this folder`,
 * `> /add-dir …`), so they keep the #995 reading — and because a `>` row that
 * is not numbered is itself a boundary, a numbered list in the transcript above
 * one of them cannot be counted.
 *
 * True here means "hand the frame to the agy dialog reader"
 * (`tools/antigravity/dialog.ts`), never "this is a prompt": a frame that
 * passes this test and still fails to read is published as an unclassified
 * frame, not as a selection list and never as "generating".
 *
 * Callers pass the same text they hand {@link ANTIGRAVITY_SELECTION_LIST_PATTERN}.
 */
export function isAntigravityNumberedDialog(text: string): boolean {
  const lines = text.split('\n');
  const region = locateAntigravityDialogRegion(lines);
  if (region === null) return false;

  let numberedRows = 0;
  for (let i = region.start; i < region.footer; i++) {
    const line = lines[i];
    if (ANTIGRAVITY_SWITCH_MODEL_HEADER_PATTERN.test(line)) return false;
    if (ANTIGRAVITY_NUMBERED_OPTION_PATTERN.test(line)) numberedRows++;
  }
  return numberedRows >= 2;
}

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
 * Command Code status-line spinner glyphs (Issue #2250).
 *
 * The complete `getWaveSymbol` frame set, read off the shipped bundle
 * (`command-code@1.40.1`, `dist/cli.mjs`):
 * `["·","○","◇","☆","✧","☆","◇","○","⌘"]` — six distinct glyphs, cycled.
 *
 * Deliberately NOT folded into {@link CLAUDE_SPINNER_CHARS}. Command Code marks
 * every assistant message with `⠶` (U+2836, see
 * {@link COMMAND_CODE_RESPONSE_MARKER_PATTERN}); adding that braille glyph to a
 * shared spinner class would make each reply's own first row read as "still
 * generating", and adding these glyphs to claude's class would do the same to
 * any claude reply that opens with `·`.
 */
export const COMMAND_CODE_SPINNER_CHARS = ['·', '○', '◇', '☆', '✧', '⌘'] as const;

/**
 * Command Code composer / dialog-cursor prompt pattern (Issue #2250).
 *
 * `❯` (U+276F) only — the ASCII `>` claude also accepts is not a glyph Command
 * Code 1.40.1 draws, and accepting it here would make every shell prompt and
 * every quoted diff line in a reply look like a composer.
 *
 * The row is drawn in two places, which is why prompt presence alone is not
 * "ready": the bottom-pinned composer (`❯ Ask your question...` between two
 * full-width rules) and the highlighted option of a permission dialog
 * (`❯ 1. Yes`). Completion is resolved structurally instead — see
 * {@link findCommandCodeChromeStart}.
 */
export const COMMAND_CODE_PROMPT_PATTERN = /^❯(\s*$|\s+\S)/m;

/**
 * Command Code separator pattern (Issue #2250).
 *
 * Full-pane runs of U+2500 fence the composer above and below, and one more is
 * drawn above a permission dialog. Measured at 200 columns on every fixture in
 * `tests/fixtures/command-code-live-2250/`.
 */
export const COMMAND_CODE_SEPARATOR_PATTERN = /^─{10,}$/m;

/**
 * Command Code status-line "esc to interrupt" hint (Issue #2250).
 *
 * The `Status` component renders `esc  to interrupt  •  <elapsed>  •  ↓ <tokens>`
 * only in its `"all"` layout, i.e. at a terminal width of 72 columns or more
 * (read off the bundle's `layoutMode` ladder; CommandMate panes are 200 wide, so
 * production always takes that branch). Below 42 columns the whole tail is
 * dropped and only the spinner + verb remain — which is why
 * {@link COMMAND_CODE_THINKING_PATTERN} keeps the spinner branch as well.
 */
export const COMMAND_CODE_INTERRUPT_HINT_PATTERN = /esc to interrupt/;

/**
 * Command Code thinking/processing pattern (Issue #2250).
 *
 * Three measured alternatives:
 *
 *  1. the status row — a spinner glyph, then a single word ending in `…`
 *     (`⌘ Planning…`, `· Synthesizing…`; the bundle's verb table is 74
 *     single-word entries, all capitalised, but the class is left case-agnostic
 *     because the `status` prop is not restricted to that table). Anchored at
 *     the start of the line with only leading spaces allowed, so the `·` in the
 *     banner's
 *     `# models: … · taste-1` row and in the idle footer's
 *     `? for shortcuts · taste on` cannot reach it;
 *  2. `✻ Thinking…` — the reasoning block's header WHILE it streams. It becomes
 *     `✻ Thought for 1 second [ctrl+o to expand]` once the block is closed, and
 *     that past-tense form must NOT match: it sits in the transcript of every
 *     finished turn (`turn-version.txt`);
 *  3. {@link COMMAND_CODE_INTERRUPT_HINT_PATTERN}, unanchored, for the same
 *     reason claude's pattern carries it.
 */
export const COMMAND_CODE_THINKING_PATTERN = new RegExp(
  `^[^\\S\\n]*[${COMMAND_CODE_SPINNER_CHARS.join('')}][^\\S\\n]+[A-Za-z]+…` +
    `|^[^\\S\\n]*✻ Thinking…` +
    `|${COMMAND_CODE_INTERRUPT_HINT_PATTERN.source}`,
  'm'
);

/**
 * Command Code assistant-message marker (Issue #2250).
 *
 * `⠶` (U+2836) at column 0, one space, then the reply. Fixed, not a spinner
 * frame: the bundle declares it as `Ct() ? "⠶" : "#"`, i.e. one constant with an
 * ASCII fallback for terminals without unicode support. That answers 親 Issue
 * #2249's 未確定事項 1 — the glyph does not rotate — and it is also why the `#`
 * fallback is deliberately NOT matched here: on such a terminal it is
 * indistinguishable from the `# Command Code v1.40.1` banner rows.
 *
 * Continuation rows of a multi-line reply are indented by two spaces (the marker
 * is one column wide and the body box carries `marginLeft: 1`).
 */
export const COMMAND_CODE_RESPONSE_MARKER_PATTERN = /^⠶(?:\s|$)/;

/**
 * Command Code turn-completion marker (Issue #2250).
 *
 * **Advisory only — never require it to declare a turn finished.** Two measured
 * reasons: `WorkedDurationNote` renders nothing for a turn under 1000 ms, and
 * the row belongs to the live turn's UI rather than to the transcript — it is
 * present in `turn-version.txt` and GONE from `dialog-create-file.txt`, which is
 * the same pane one prompt later.
 */
export const COMMAND_CODE_COMPLETION_PATTERN = /^[^\S\n]*✻ Worked for /m;

/**
 * Command Code footer mode indicator (Issue #2250).
 *
 * The row under the composer's closing rule. `? for shortcuts` is only the
 * DEFAULT-mode spelling: the bundle's `ModeIndicator` swaps it for a mode banner
 * in the other four permission modes, so a rule that keys on `? for shortcuts`
 * alone would stop recognising an idle pane the moment the operator pressed
 * shift+tab. All five spellings are listed.
 */
export const COMMAND_CODE_MODE_INDICATOR_PATTERN =
  /\?\s+for\s+shortcuts|»\s+accept edits on|»\s+permission bypass on|»\s+don't-ask on|^[^\S\n]*plan mode\s/m;

/**
 * Command Code startup banner rows (Issue #2250).
 *
 * The three-row header under the block-art logo — `# Command Code v1.40.1`,
 * `# models: …`, `# <cwd>` — plus the logo itself.
 *
 * The version row matches the tool's own NAME and version together, which is the
 * shape #2247 had to retreat to on claude: a bare `v\d+\.\d+` matched any reply
 * that mentioned a release, and the turn was silently dropped. Nothing here
 * matches a bare version string, a `│` table glyph, or a `Tip:` line.
 */
export const COMMAND_CODE_BANNER_PATTERNS: readonly RegExp[] = [
  /^#\s+Command Code v\d/, // Name + version, together
  /^#\s+models:\s/, // Model line
  /^#\s+[~/]/, // Working-directory line
  /^[^\S\n]*[█▀▄▌▐]{3,}/, // Block-art logo rows
] as const;

/**
 * Command Code hook notice row (Issue #2250).
 *
 * `◼ Ran 1 session start hook` — emitted into the transcript when SessionStart
 * hooks fire, so it lands ABOVE the first user echo and is chrome, not a reply.
 * Measured on a hooks-enabled 1.40.1 pane while capturing #2249's evidence.
 * Command Code's hook wiring itself is Phase B (#2251); this row only has to be
 * kept out of History.
 */
export const COMMAND_CODE_HOOK_NOTICE_PATTERN = /^[^\S\n]*◼\s+Ran\s+\d+\s+.*hooks?\b/;

/** How far above the last row Command Code's footer row may sit. */
const COMMAND_CODE_FOOTER_MAX_ROWS = 4;

/** How many rows the composer may span before the block stops looking like chrome. */
const COMMAND_CODE_INPUT_BOX_MAX_ROWS = 40;

/**
 * Locate the start of Command Code's bottom-pinned chrome within a captured pane.
 *
 * Command Code is inline-rendered, so its transcript grows downwards and the
 * last four rows of a settled pane are always the same four (measured on
 * `boot-idle.txt`, `turn-version.txt` and `turn-tool-write.txt`):
 *
 * ```text
 * ────────────────────  ← opening rule
 * ❯ Ask your question…  ← composer (one row per wrapped line)
 * ────────────────────  ← closing rule
 *   ? for shortcuts · taste on
 * ```
 *
 * Everything from the opening rule down is terminal furniture. Two things go
 * wrong if it reaches the extractor, and both are regressions this repository
 * has already paid for once: the composer's placeholder is drawn with the same
 * `❯ <text>` shape as a transcript echo, so the turn anchor lands on the FOOTER
 * and the reply extracts as empty (#1289); and the footer row is repainted while
 * the pane sits idle, so keeping it re-hashes the saved response on every poll
 * tick (#1268 / #1289).
 *
 * Structural, like the three readers next to it, and for the reason spelled out
 * on `findClaudeChromeStart`: the hint strings belong to Command Code and a rule
 * that matches them stops working the moment they are reworded. `-1` is the
 * honest answer for a frame with no composer at all — while a permission dialog
 * is up the whole block is replaced by the dialog, which the caller resolves on
 * the prompt path instead.
 *
 * @param lines - Captured pane lines, ANSI-bearing or not; trailing blanks tolerated
 * @returns Index of the opening rule, or -1 when no composer block is present
 */
export function findCommandCodeChromeStart(lines: string[]): number {
  const isSeparator = (line: string | undefined): boolean =>
    /^─{10,}$/.test(stripAnsi(line ?? '').trimEnd());

  let lastRow = lines.length - 1;
  while (lastRow >= 0 && lines[lastRow].trim() === '') lastRow--;
  if (lastRow < 0) return -1;

  // The closing rule sits just above the mode-indicator row.
  let closingSeparator = -1;
  for (let i = lastRow; i >= Math.max(0, lastRow - COMMAND_CODE_FOOTER_MAX_ROWS); i--) {
    if (isSeparator(lines[i])) {
      closingSeparator = i;
      break;
    }
  }
  if (closingSeparator < 0) return -1;

  // Walk up over the composer rows to the opening rule.
  let openingSeparator = -1;
  for (let i = closingSeparator - 1; i >= Math.max(0, closingSeparator - COMMAND_CODE_INPUT_BOX_MAX_ROWS); i--) {
    if (isSeparator(lines[i])) {
      openingSeparator = i;
      break;
    }
  }
  if (openingSeparator < 0) return -1;

  // Confirm the fenced rows are the composer and not a reply that happens to
  // contain two horizontal rules.
  if (!/^❯/.test(stripAnsi(lines[openingSeparator + 1] ?? ''))) return -1;

  return openingSeparator;
}

/**
 * Command Code skip patterns for response cleaning (Issue #2250).
 *
 * The dedicated cleaner Issue #2250 item 8 asks for: the startup banner, the
 * hook notice, the reasoning and turn summaries (`✻ Thought for` / `✻ Worked
 * for`), the composer, the rules and the footer.
 *
 * Nothing here touches the reply body or a tool block: `⠶ <text>`, ` WRITE
 * [probe.txt]`, ` └  Created probe.txt (1 line)` and `     1 │ hello` all
 * survive (`turn-tool-write.txt`). In particular there is no `^\s*│` rule — the
 * one codex carries — because Command Code renders file previews with it.
 */
export const COMMAND_CODE_SKIP_PATTERNS: readonly RegExp[] = [
  /^─{10,}$/, // Composer rules and the dialog's rule
  /^❯\s*$/, // Bare composer row
  /^❯\s+Ask your question\.\.\./, // Composer placeholder
  COMMAND_CODE_MODE_INDICATOR_PATTERN, // Footer mode indicator
  COMMAND_CODE_THINKING_PATTERN, // Status row
  /^[^\S\n]*✻\s+(?:Worked|Thought)\s+for\b/, // Turn / reasoning summaries
  COMMAND_CODE_HOOK_NOTICE_PATTERN, // "◼ Ran N session start hook"
  ...COMMAND_CODE_BANNER_PATTERNS, // Startup banner
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
    case 'command-code':
      result = COMMAND_CODE_THINKING_PATTERN.test(content);
      break;
    case 'opencode-v2':
      result = OPENCODE_V2_THINKING_PATTERN.test(content);
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

    // Issue #2250: Command Code's layout is claude-shaped (inline transcript,
    // `❯` composer fenced by two full-width rules) but the constants are its
    // own. Sharing claude's would import the exact defect #2247 had to undo --
    // claude's rules carry a startup-banner reading that keys on `v\d+\.\d+`
    // and `|`, and Command Code prints its version into a `# Command Code
    // v1.40.1` row on every launch.
    case 'command-code':
      return {
        promptPattern: COMMAND_CODE_PROMPT_PATTERN,
        separatorPattern: COMMAND_CODE_SEPARATOR_PATTERN,
        thinkingPattern: COMMAND_CODE_THINKING_PATTERN,
        skipPatterns: [...COMMAND_CODE_SKIP_PATTERNS],
      };

    // Issue #2934: OpenCode V2's own constants (see OPENCODE_V2_* above). The
    // separator row is the same half-block rule v1 draws, so v1's pattern is
    // reused as a value; nothing of v1's is changed.
    case 'opencode-v2':
      return {
        promptPattern: OPENCODE_V2_IDLE_COMPOSER_PATTERN,
        separatorPattern: OPENCODE_SEPARATOR_PATTERN,
        thinkingPattern: OPENCODE_V2_THINKING_PATTERN,
        skipPatterns: [...OPENCODE_V2_SKIP_PATTERNS],
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

export { stripBoxDrawing };

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
  //
  // [Issue #2364] The `↑/↓ Navigate` dialogs themselves no longer reach
  // `detectPrompt` on either production path: `tools/antigravity/detect.ts`
  // (status) and `detectPromptWithOptions` (response poller) both read them
  // with `detectAntigravityNumberedDialogPrompt` first, because the generic
  // multiple-choice pass reads one row per option and agy wraps a long command
  // across several rows of one label. What this setting still serves is every
  // OTHER numbered agy screen — `/feedback`'s `1-6 Select & Continue` menu is
  // the measured one — which the generic pass reads as before.
  if (cliToolId === 'antigravity') {
    return { requireDefaultIndicator: false };
  }
  return undefined; // Default behavior (requireDefaultIndicator = true)
}
