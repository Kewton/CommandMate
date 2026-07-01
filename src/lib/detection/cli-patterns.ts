/**
 * Common CLI tool patterns for response detection
 * Shared between response-poller.ts and API routes
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type { DetectPromptOptions } from './types';
import { createLogger } from '@/lib/logger';

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
 * Codex thinking pattern
 * Matches activity indicators like "• Planning", "• Searching", etc.
 * T1.1: Extended to include "Ran" and "Deciding"
 */
export const CODEX_THINKING_PATTERN = /•\s*(Planning|Searching|Exploring|Running|Thinking|Working|Reading|Writing|Analyzing|Ran|Deciding)/m;

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
export function getCodexActiveDialog(output: string): CodexActiveDialog {
  const lines = output.split('\n');
  // Index of the bottom-most genuine input-prompt line (-1 if none).
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CODEX_GENUINE_PROMPT_LINE.test(lines[i])) {
      promptIdx = i;
      break;
    }
  }
  // Active region = lines strictly below the genuine prompt (the whole frame when
  // there is no genuine prompt). Residual dialog text above a live prompt is
  // excluded, so a dialog lingering in scrollback is never treated as active.
  const active = lines.slice(promptIdx + 1).join('\n');
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
 * OpenCode response completion pattern (Issue #379)
 * Matches the action summary line: "&#x25A3; {Action} · model" with optional timing "· Ns".
 * (U+25A3 square + action word + middle dot + model name [+ middle dot + timing]).
 * Action can be "Build", "Compaction", or other OpenCode action names.
 * Short responses may omit the timing portion (e.g., "▣ Build · qwen3.5:27b").
 * This is the primary completion signal for OpenCode [D2-002].
 */
export const OPENCODE_RESPONSE_COMPLETE = /\u25A3\s+\w+\s+\u00b7\s+\S+(?:\s+\u00b7\s+(?:[\d]+h\s*)?(?:[\d]+m\s*)?[\d.]+s)?/;

/**
 * OpenCode processing indicator pattern (Issue #379)
 * Shows "esc interrupt" in the TUI status bar during active model processing.
 * Filtered from response extraction via OPENCODE_SKIP_PATTERNS.
 */
export const OPENCODE_PROCESSING_INDICATOR = /esc interrupt/;

/**
 * OpenCode TUI selection list pattern (Issue #473)
 * Detects the fuzzy-search selection list overlay in OpenCode TUI
 * (e.g., /models, /providers, /connect commands).
 *
 * Matches header lines of selection overlays. Known headers:
 *   "              Select model                                     esc"
 *   "              Connect a provider                               esc"
 */
export const OPENCODE_SELECTION_LIST_PATTERN = /^\s*(Select\s+(model|provider)|Connect\s+a\s+provider)/m;

/**
 * Claude CLI selection list footer pattern
 * Detects Claude CLI's interactive selection prompts that require
 * arrow key navigation and Enter to select/toggle.
 *
 * Matches footer instruction lines (known variants):
 *   "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"
 *   "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel"
 *   "Enter to confirm · Esc to exit"  (/model command)
 */
export const CLAUDE_SELECTION_LIST_FOOTER = /Enter\s+to\s+(?:select\s+.*to\s+navigate|confirm\s+·\s+Esc)/;

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
 * status bar prompts, processing indicators, input prompt, and pasted text markers.
 */
export const OPENCODE_SKIP_PATTERNS: readonly RegExp[] = [
  OPENCODE_SEPARATOR_PATTERN,
  OPENCODE_LOADING_PATTERN,
  /^Build\s+/,
  OPENCODE_PROMPT_AFTER_RESPONSE,
  OPENCODE_PROCESSING_INDICATOR,
  OPENCODE_PROMPT_PATTERN,
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

/**
 * Strip ANSI escape codes from a string.
 * Optimized version at module level for performance.
 *
 * Covers:
 * - SGR sequences: ESC[Nm (colors, bold, underline, etc.)
 * - OSC sequences: ESC]...BEL (window title, hyperlinks, etc.)
 * - CSI sequences: ESC[...letter (cursor movement, erase, etc.)
 *
 * Known limitations (SEC-002):
 * - 8-bit CSI (0x9B): C1 control code form of CSI is not covered
 * - DEC private modes: ESC[?25h and similar are not covered
 * - Character set switching: ESC(0, ESC(B are not covered
 * - Some RGB color forms: ESC[38;2;r;g;bm may not be fully matched
 *
 * In practice, tmux capture-pane output rarely contains these sequences,
 * so the risk is low. Future consideration: adopt the `strip-ansi` npm package
 * for more comprehensive coverage.
 */
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\[[0-9;]*m/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_PATTERN, '');
}

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
  if (cliToolId === 'opencode') {
    return { requireDefaultIndicator: false };
  }
  // [Issue #545] Copilot prompt pattern may not use standard indicators
  if (cliToolId === 'copilot') {
    return { requireDefaultIndicator: false };
  }
  // [Issue #988] Antigravity (agy) uses the standard ">" indicator, so the
  // default (requireDefaultIndicator = true) is correct — no special case needed.
  return undefined; // Default behavior (requireDefaultIndicator = true)
}
