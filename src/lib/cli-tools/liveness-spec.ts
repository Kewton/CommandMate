/**
 * What each tool's pane looks like when the TOOL is still there — one
 * declaration per tool (Issue #2070).
 *
 * The rule these fill in lives in `lib/detection/tool-liveness`; see
 * {@link ToolLivenessSpec} for why it is a declaration rather than seven
 * predicates. This module is the table, and it is here for the same reason
 * `./composer-spec` and `./capture-spec` are: `BaseCLITool.livenessSpec()`
 * answers from it (the §4 D4 shape, every tool may override), and the two
 * callers that must NOT instantiate a tool to ask one question — the sidebar's
 * status poll and `isSessionHealthy` — resolve through {@link resolveLivenessSpec}
 * instead.
 *
 * ## What is measured and what is not
 *
 * The frames behind claude / codex / copilot / opencode / gemini were captured
 * live on 2026-08-31 at the production 200x1000 geometry on a private tmux
 * socket, launching each tool and then quitting it, and are pinned as fixtures
 * in `tests/fixtures/tool-liveness-2070.ts`. antigravity was not installed on
 * that machine and vibe-local needs a local Ollama; both get their prompt and
 * thinking patterns from `detection/cli-patterns` like everyone else, and the
 * conservative direction of the shared rule (see step 7 of `judgeToolLiveness`)
 * is what makes an unmeasured tool safe: the worst an unrecognised frame can do
 * is answer "alive", which is the pre-#2070 behaviour.
 *
 * @module lib/cli-tools/liveness-spec
 */

import {
  ANTIGRAVITY_PROMPT_PATTERN,
  ANTIGRAVITY_SELECTION_LIST_PATTERN,
  ANTIGRAVITY_THINKING_PATTERN,
  CLAUDE_PROMPT_PATTERN,
  CLAUDE_SESSION_ERROR_PATTERNS,
  CLAUDE_SESSION_ERROR_REGEX_PATTERNS,
  CODEX_DIALOG_PATTERN,
  CODEX_PROMPT_PATTERN,
  CODEX_THINKING_PATTERN,
  COMMAND_CODE_MODE_INDICATOR_PATTERN,
  COMMAND_CODE_PROMPT_PATTERN,
  COMMAND_CODE_THINKING_PATTERN,
  COPILOT_IDLE_STATUS_PATTERN,
  COPILOT_PROMPT_PATTERN,
  COPILOT_THINKING_PATTERN,
  COPILOT_WORKING_STATUS_PATTERN,
  GEMINI_PROMPT_PATTERN,
  GEMINI_THINKING_PATTERN,
  OPENCODE_FOOTER_STATUS_PATTERN,
  OPENCODE_IDLE_COMPOSER_PATTERN,
  OPENCODE_PROMPT_AFTER_RESPONSE,
  OPENCODE_SELECTION_LIST_PATTERN,
  OPENCODE_THINKING_PATTERN,
  VIBE_LOCAL_PROMPT_PATTERN,
  VIBE_LOCAL_THINKING_PATTERN,
} from '../detection/cli-patterns';
import {
  MAX_SHELL_PROMPT_LENGTH,
  SHELL_PROMPT_ENDINGS,
  SHELL_PROMPT_LINE_PATTERNS,
} from '../detection/tool-liveness';
import type { ToolLivenessSpec } from '../../types/cli-tool-contracts';
import type { CLIToolType } from './types';

/**
 * Rows of pane tail a liveness probe asks tmux for.
 *
 * claude's number, kept for every tool. The probe reads the BOTTOM of the pane,
 * so a deeper capture buys nothing and costs the one thing that matters here:
 * more of the tool's own dead chrome inside {@link ToolLivenessSpec.aliveTailLines}'
 * reach. Fifty rows covers the composer, its borders and the footer of every
 * TUI measured (opencode's is the deepest at nine rows).
 */
export const LIVENESS_PROBE_CAPTURE_LINES = 50;

/**
 * Content rows from the bottom that {@link ToolLivenessSpec.alivePatterns} may
 * look at, for every tool but claude.
 *
 * Twelve — the same reasoning `COMPOSER_VERIFY_WINDOW_LINES` applies to a
 * different question: the composer and its chrome are the last thing on the
 * pane, and a window that reaches past them starts reading scrollback. Measured
 * floor: opencode's idle chrome is nine content rows (four box rows, the model
 * row, the bottom border, and up to three wrapped footer rows). Measured
 * ceiling: the exited codex pane of 0.149.1 puts its banner box eight rows
 * above the shell prompt and the dead trust dialog a thousand rows above that.
 */
export const LIVENESS_ALIVE_TAIL_LINES = 12;

/**
 * The half of a spec that is the same for every tool.
 *
 * Only the patterns differ between tools; the shell does not change shape
 * because a different agent used to be running in it.
 */
const SHARED: Pick<
  ToolLivenessSpec,
  'probeCaptureLines' | 'shellPromptEndings' | 'maxShellPromptLength' | 'fatalPatterns' | 'fatalRegexPatterns'
> = {
  probeCaptureLines: LIVENESS_PROBE_CAPTURE_LINES,
  shellPromptEndings: SHELL_PROMPT_ENDINGS,
  maxShellPromptLength: MAX_SHELL_PROMPT_LENGTH,
  fatalPatterns: [],
  fatalRegexPatterns: [],
};

/**
 * The defaults every tool ADDED by Issue #2070 takes.
 *
 * Windowed alive check, the positive `user@host …` prompt forms, and — the one
 * that matters most — an unreadable frame is NOT an exit. A relaunch hangs off
 * this verdict, and "the capture threw" is not evidence that anything died.
 */
const ADDED_TOOL_DEFAULTS: Pick<
  ToolLivenessSpec,
  'aliveTailLines' | 'shellPromptPatterns' | 'unreadableIsExited'
> = {
  aliveTailLines: LIVENESS_ALIVE_TAIL_LINES,
  shellPromptPatterns: SHELL_PROMPT_LINE_PATTERNS,
  unreadableIsExited: false,
};

/**
 * Per-tool liveness declarations.
 *
 * Each tool's `alivePatterns` is its prompt-ready rule plus whatever else it
 * draws at the bottom of a pane it still owns — a dialog it is parked on, a
 * working indicator, a footer. Widening it can only ever make the verdict
 * "alive", so the list is allowed to be generous; what it must never contain is
 * a pattern the SHELL can match.
 */
const LIVENESS_SPECS: Record<CLIToolType, ToolLivenessSpec> = {
  /**
   * claude's is `isSessionHealthy`, unchanged, expressed as a declaration.
   *
   * Three fields carry that history and are claude's alone: `aliveTailLines:
   * null` (the check has always tested the whole frame), `shellPromptPatterns:
   * []` (the length gate and the endings are the whole rule), and
   * `unreadableIsExited: true` (an empty pane and a capture that threw have
   * both meant "unhealthy" since it was written). Issue #2070's acceptance
   * condition is that claude's verdicts do not move, so none of the three may be
   * "improved" here — a change would have to be its own Issue, with its own
   * measurements.
   */
  claude: {
    ...SHARED,
    alivePatterns: [CLAUDE_PROMPT_PATTERN],
    aliveTailLines: null,
    shellPromptPatterns: [],
    unreadableIsExited: true,
    fatalPatterns: CLAUDE_SESSION_ERROR_PATTERNS,
    fatalRegexPatterns: CLAUDE_SESSION_ERROR_REGEX_PATTERNS,
  },

  /**
   * codex 0.149.1, the tool the Issue was reported against.
   *
   * `CODEX_PROMPT_PATTERN` (`^›`) is the composer AND the selected row of every
   * numbered dialog, which is exactly the width wanted here: a pane parked on
   * the trust / update / hooks-review dialog is a pane codex still owns.
   * `CODEX_DIALOG_PATTERN` adds the dialogs whose selected row has scrolled out
   * of the window, and the thinking pattern covers a turn in flight.
   *
   * Not `isCodexPromptReady`: that function answers "may I type into this?",
   * which is a stricter question and false for every dialog above.
   */
  codex: {
    ...SHARED,
    ...ADDED_TOOL_DEFAULTS,
    alivePatterns: [CODEX_PROMPT_PATTERN, CODEX_DIALOG_PATTERN, CODEX_THINKING_PATTERN],
  },

  /**
   * copilot 1.0.80.
   *
   * `COPILOT_PROMPT_PATTERN` is `^[>❯]\s`, which also matches the starship /
   * pure / agnoster shell prompt (#1907 measured exactly that). Left in
   * deliberately: it makes the verdict fail SAFE on those prompts — copilot is
   * reported alive and nothing is relaunched — where dropping it would let a
   * live composer be read as a shell.
   */
  copilot: {
    ...SHARED,
    ...ADDED_TOOL_DEFAULTS,
    alivePatterns: [
      COPILOT_PROMPT_PATTERN,
      COPILOT_IDLE_STATUS_PATTERN,
      COPILOT_WORKING_STATUS_PATTERN,
      COPILOT_THINKING_PATTERN,
    ],
  },

  /**
   * opencode 1.18.23.
   *
   * `Ask anything...` is the HOME screen only — the composer of an opencode
   * that has answered one turn is a bare gutter — so the placeholder cannot
   * carry this on its own. The footer does: `OPENCODE_FOOTER_STATUS_PATTERN`
   * (`8.9K (1%) · $`) is drawn on every frame after the first turn, and
   * `OPENCODE_PROMPT_AFTER_RESPONSE` (`tab agents  ctrl+p commands`) on the
   * frames before it. Both verified against
   * `tests/fixtures/opencode-live-2049/{boot,two-turn}-idle-11822.txt`.
   */
  opencode: {
    ...SHARED,
    ...ADDED_TOOL_DEFAULTS,
    alivePatterns: [
      OPENCODE_IDLE_COMPOSER_PATTERN,
      OPENCODE_PROMPT_AFTER_RESPONSE,
      OPENCODE_FOOTER_STATUS_PATTERN,
      OPENCODE_SELECTION_LIST_PATTERN,
      OPENCODE_THINKING_PATTERN,
    ],
  },

  /**
   * gemini 0.55.1.
   *
   * The composer and the braille spinner. gemini draws its dialogs inside a
   * full-width rounded box, and box rows are deliberately NOT an alive pattern:
   * gemini prints its session summary in the same box on the way OUT, so the
   * exited pane still carries `╰────╯` two rows above the shell prompt
   * (measured 2026-08-31). The length gate is what keeps a live gemini dialog
   * alive — its rows are 200 columns wide.
   */
  gemini: {
    ...SHARED,
    ...ADDED_TOOL_DEFAULTS,
    alivePatterns: [GEMINI_PROMPT_PATTERN, GEMINI_THINKING_PATTERN],
  },

  /** antigravity — patterns from `cli-patterns`; no live frames (not installed). */
  antigravity: {
    ...SHARED,
    ...ADDED_TOOL_DEFAULTS,
    alivePatterns: [
      ANTIGRAVITY_PROMPT_PATTERN,
      ANTIGRAVITY_SELECTION_LIST_PATTERN,
      ANTIGRAVITY_THINKING_PATTERN,
    ],
  },

  /**
   * Command Code 1.40.1 — measured live at 200x1000 (Issue #2250).
   *
   * The composer glyph, the footer's mode indicator and the status row. The
   * footer is included as well as the composer because the two are drawn in the
   * same block and a frame carrying either one is a frame Command Code owns;
   * neither can be matched by a shell prompt, which is the only property this
   * list has to keep.
   */
  'command-code': {
    ...SHARED,
    ...ADDED_TOOL_DEFAULTS,
    alivePatterns: [
      COMMAND_CODE_PROMPT_PATTERN,
      COMMAND_CODE_MODE_INDICATOR_PATTERN,
      COMMAND_CODE_THINKING_PATTERN,
    ],
  },

  /** vibe-local — patterns from `cli-patterns`; no live frames (needs Ollama). */
  'vibe-local': {
    ...SHARED,
    ...ADDED_TOOL_DEFAULTS,
    alivePatterns: [VIBE_LOCAL_PROMPT_PATTERN, VIBE_LOCAL_THINKING_PATTERN],
  },
};

/**
 * The liveness declaration for a CLI tool.
 *
 * @param cliToolId - CLI tool identifier
 * @returns That tool's {@link ToolLivenessSpec}; claude's for an id outside
 *   `CLI_TOOL_IDS` (a JavaScript caller or a cast). claude's is the
 *   conservative fallback in the direction that matters: it is the one spec
 *   whose verdicts have been in production since long before this Issue.
 */
export function resolveLivenessSpec(cliToolId: CLIToolType): ToolLivenessSpec {
  return LIVENESS_SPECS[cliToolId] ?? LIVENESS_SPECS.claude;
}
