/**
 * Claude Code's own detection patterns (Issue #1927).
 *
 * What comes first is what Issue #1927 had to measure to give Claude a §4 D1
 * idle rule, plus the provenance of that measurement. Below `VERIFIED_AGAINST`
 * are the Claude patterns Issue #3217 moved here from `cli-patterns.ts`, which
 * keeps the per-tool table and re-exports their public names.
 *
 * ## Why Claude needed a new rule at all
 *
 * The design policy's first draft said Claude already had a completion marker
 * (`⏺` plus the composer). It does not: `⏺` is one of `CLAUDE_SPINNER_CHARS`,
 * i.e. a RUNNING signal, and the composer `❯` is drawn throughout a turn. So the
 * pre-#1927 route to `ready` was the generic `promptPattern` matching a composer
 * row that is on screen during generation too — the "absence of a negative"
 * §4 D1 forbids and #1885 reported for copilot.
 *
 * ## What was measured (claude-cli 2.1.240, 200x1000 pane, 2026-08-23)
 *
 * The bottom status row is NOT the answer here, unlike copilot's. Measured
 * across all four permission modes, idle and generating:
 *
 * | mode         | idle                                              | generating                                                       |
 * |--------------|---------------------------------------------------|------------------------------------------------------------------|
 * | manual       | `⏸ manual mode on · ? for shortcuts · ⇥ for agents` | `⏸ manual mode on · esc to interrupt · ⇥ for agents`             |
 * | auto         | `⏵⏵ auto mode on (shift+tab to cycle) · ⇥ for agents` | `⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ⇥ for agents` |
 * | plan         | `⏸ plan mode on (shift+tab to cycle) · ⇥ for agents` | —                                                                |
 * | accept edits | `⏵⏵ accept edits on (shift+tab to cycle) · ⇥ for agents` | —                                                            |
 *
 * In auto mode the row is byte-identical either side of `esc to interrupt`, so
 * an idle allowlist built from it would vouch for a generating frame. The row
 * discriminates in exactly one direction — `esc to interrupt` means busy — which
 * is `CLAUDE_INTERRUPT_HINT_PATTERN`'s job and not an idle rule.
 *
 * The transcript IS the answer. Every completed turn measured ends with a
 * duration-bearing marker as the last transcript row:
 *
 *   `✻ Brewed for 14s`   `✻ Baked for 20s`   `✻ Sautéed for 4s`
 *   `✻ Cooked for 8s · 5 messages hidden (/focus to show)`
 *
 * while a running turn ends with response prose, a tool result, or the
 * present-participle form of the same row — `✻ Manifesting… (3s · thinking with
 * xhigh effort)`, `· Enchanting… (5s · …)` — which carries no `for <duration>`.
 * The duration is what makes it evidence rather than decoration, the same
 * argument #1893 used to make opencode's `▣ … · 2.3s` duration mandatory.
 */

import { findClaudeInputBox } from '../../composer-text';

/**
 * Claude's turn-completion marker: a spinner glyph, a verb, and a duration.
 *
 * The glyph rotates through `CLAUDE_SPINNER_CHARS` while a turn runs and settles
 * on `✻` when it ends, so the glyph is NOT the discriminator and the whole set
 * is accepted here. The discriminator is `for <duration>` in the past tense:
 * the in-flight row is `<Verb>… (Ns · …)`, whose ellipsis and parenthetical the
 * pattern cannot match.
 *
 * `\d+m\s*` covers the minute form of a long turn. No `/g` (keeps `.test()`
 * stateless) and no nested quantifiers (ReDoS-safe).
 */
export const CLAUDE_TURN_COMPLETE_PATTERN =
  /^\s*[✻✽✶✢✳⦿◉●·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\S+\s+for\s+(?:\d+m\s*)?\d+(?:\.\d+)?s(?:\s|$|\s*·)/;

/**
 * Claude's startup banner — the top edge of a session that has not run a turn.
 *
 * `╭─── Claude Code v2.1.240 ───…╮`. Paired with
 * {@link CLAUDE_TRANSCRIPT_USER_TURN_PATTERN} below it, this is the positive
 * form of §4 D1 決定 1 item 4 ("未開始"): the banner says the frame still shows
 * the start of the session, and the absence of a user turn UNDER a visible start
 * is a statement about the whole session rather than about what scrolled off.
 */
export const CLAUDE_BANNER_PATTERN = /^\s*╭─+\s*Claude Code v/;

/**
 * A user turn in the transcript: `❯ <text>` outside the composer box.
 *
 * Claude echoes every submitted message this way. Callers must exclude the
 * composer rows before scanning, since the composer wears the same glyph — see
 * `findClaudeInputBox`.
 */
export const CLAUDE_TRANSCRIPT_USER_TURN_PATTERN = /^\s*[>❯]\s+\S/;

/**
 * The right-aligned model/effort chip Claude draws directly above its input box.
 *
 * `◍ xhigh · /effort` / `● high · /effort`. It is chrome, not transcript, so the
 * walk that looks for the transcript tail has to step over it — without this the
 * tail of every frame that shows the chip is the chip itself and no completion
 * marker is ever reached. Anchored on the trailing `· /effort` because the glyph
 * varies with the reasoning level.
 */
export const CLAUDE_EFFORT_CHIP_PATTERN = /·\s*\/effort\s*$/;

/**
 * Which build these rules were read off.
 *
 * The value itself lives in `../verified-against` so §4 D2's staleness probe can
 * read every tool's stamp as data (Issue #1929); it is re-exported here so a
 * reader of these patterns still finds it next to them.
 */
export { CLAUDE_VERIFIED_AGAINST as VERIFIED_AGAINST } from '../verified-against';

/**
 * The Claude blocks moved out of `../../cli-patterns.ts` (Issue #3217 I-7).
 * `cli-patterns.ts` re-exports every public name.
 */

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

/** Row of the last `Yes, I trust this folder`, or -1 when absent or already answered. */
function findOpenClaudeTrustYesRow(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!CLAUDE_TRUST_DIALOG_PATTERN.test(lines[i])) continue;
    // Claude's input box (separator rows) drawn below it: the dialog is scrollback.
    return lines.slice(i + 1).some((line) => CLAUDE_SEPARATOR_PATTERN.test(line)) ? -1 : i;
  }
  return -1;
}

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
