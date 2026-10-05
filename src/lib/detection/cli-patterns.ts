/**
 * Common CLI tool patterns for response detection
 * Shared between response-poller.ts and API routes
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type { DetectPromptOptions } from './types';
import { createLogger } from '@/lib/logger';
import { isShellPaneCommand } from './shared/shell-pane-command';
import {
  PASTED_TEXT_PATTERN,
  PASTED_TEXT_DETECT_DELAY,
  MAX_PASTED_TEXT_RETRIES,
} from './shared/pasted-text';
import { stripBoxDrawing } from './shared/strip-box-drawing';
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

import {
  CLAUDE_THINKING_PATTERN,
  CLAUDE_PROMPT_PATTERN,
  CLAUDE_SEPARATOR_PATTERN,
} from './tools/claude/patterns';
export {
  CLAUDE_SPINNER_CHARS,
  CLAUDE_THINKING_PATTERN,
  CLAUDE_INTERRUPT_HINT_PATTERN,
  CLAUDE_PROMPT_PATTERN,
  CLAUDE_SEPARATOR_PATTERN,
  findClaudeChromeStart,
  CLAUDE_TRUST_DIALOG_PATTERN,
  resolveClaudeTrustDialogKeys,
  isClaudeTrustDialogOpen,
  CLAUDE_MODEL_OVERLAY_FOOTER_PATTERN,
  CLAUDE_SELECTION_LIST_FOOTER,
  CLAUDE_SESSION_ERROR_PATTERNS,
  CLAUDE_SESSION_ERROR_REGEX_PATTERNS,
} from './tools/claude/patterns';

import {
  GEMINI_PROMPT_PATTERN,
  GEMINI_THINKING_PATTERN,
} from './tools/gemini/patterns';
export {
  GEMINI_PROMPT_PATTERN,
  GEMINI_THINKING_PATTERN,
} from './tools/gemini/patterns';

import {
  VIBE_LOCAL_PROMPT_PATTERN,
  VIBE_LOCAL_THINKING_PATTERN,
} from './tools/vibe-local/patterns';
export {
  VIBE_LOCAL_PROMPT_PATTERN,
  VIBE_LOCAL_THINKING_PATTERN,
} from './tools/vibe-local/patterns';

import {
  COPILOT_PROMPT_PATTERN,
  COPILOT_SEPARATOR_PATTERN,
  COPILOT_THINKING_PATTERN,
  COPILOT_SKIP_PATTERNS,
} from './tools/copilot/patterns';
export {
  COPILOT_PROMPT_PATTERN,
  COPILOT_THINKING_PATTERN,
  COPILOT_WORKING_STATUS_PATTERN,
  COPILOT_IDLE_STATUS_PATTERN,
  readCopilotStatusBar,
  COPILOT_SEPARATOR_PATTERN,
  findCopilotChromeStart,
  COPILOT_BOX_ROW_PATTERN,
  COPILOT_REASONING_HEADER_PATTERN,
  COPILOT_USER_ECHO_PATTERN,
  COPILOT_TRANSCRIPT_DIVIDER_PATTERN,
  COPILOT_TOOL_VERBS,
  COPILOT_TOOL_ROW_PATTERN,
  COPILOT_TRANSCRIPT_CONTINUATION_PATTERN,
  COPILOT_BOOT_BANNER_ANCHORS,
  COPILOT_SELECTION_FOOTER_PATTERN,
  isCopilotSelectionFrame,
  COPILOT_FOLDER_TRUST_ANCHORS,
  COPILOT_FOLDER_TRUST_SESSION_OPTION_PATTERN,
  COPILOT_FOLDER_TRUST_ANSWER_KEY,
  isCopilotFolderTrustDialog,
  COPILOT_SKIP_PATTERNS,
} from './tools/copilot/patterns';
export type { CopilotStatusBarState } from './tools/copilot/patterns';

import {
  ANTIGRAVITY_PROMPT_PATTERN,
  ANTIGRAVITY_SEPARATOR_PATTERN,
  ANTIGRAVITY_THINKING_PATTERN,
  ANTIGRAVITY_SKIP_PATTERNS,
} from './tools/antigravity/patterns';
export {
  ANTIGRAVITY_COMPOSER_MODE_BANNER_SOURCE,
  ANTIGRAVITY_COMPOSER_MODE_BANNER_PATTERN,
  ANTIGRAVITY_PROMPT_PATTERN,
  ANTIGRAVITY_THINKING_PATTERN,
  ANTIGRAVITY_SEPARATOR_PATTERN,
  ANTIGRAVITY_SELECTION_LIST_PATTERN,
  ANTIGRAVITY_NAVIGATE_FOOTER_PATTERN,
  ANTIGRAVITY_NUMBERED_OPTION_PATTERN,
  ANTIGRAVITY_SWITCH_MODEL_HEADER_PATTERN,
  ANTIGRAVITY_DIALOG_BOUNDARY_PATTERN,
  ANTIGRAVITY_DIALOG_MAX_ROWS,
  ANTIGRAVITY_SURVEY_PATTERN,
  locateAntigravityDialogRegion,
  isAntigravityNumberedDialog,
  ANTIGRAVITY_SKIP_PATTERNS,
} from './tools/antigravity/patterns';
export type { AntigravityDialogRegion } from './tools/antigravity/patterns';

import {
  COMMAND_CODE_PROMPT_PATTERN,
  COMMAND_CODE_SEPARATOR_PATTERN,
  COMMAND_CODE_THINKING_PATTERN,
  COMMAND_CODE_SKIP_PATTERNS,
} from './tools/command-code/patterns';
export {
  COMMAND_CODE_SPINNER_CHARS,
  COMMAND_CODE_PROMPT_PATTERN,
  COMMAND_CODE_SEPARATOR_PATTERN,
  COMMAND_CODE_INTERRUPT_HINT_PATTERN,
  COMMAND_CODE_THINKING_PATTERN,
  COMMAND_CODE_RESPONSE_MARKER_PATTERN,
  COMMAND_CODE_COMPLETION_PATTERN,
  COMMAND_CODE_MODE_INDICATOR_PATTERN,
  COMMAND_CODE_BANNER_PATTERNS,
  COMMAND_CODE_HOOK_NOTICE_PATTERN,
  findCommandCodeChromeStart,
  COMMAND_CODE_SKIP_PATTERNS,
} from './tools/command-code/patterns';

const logger = createLogger('cli-patterns');


export { isShellPaneCommand };



export { PASTED_TEXT_PATTERN, PASTED_TEXT_DETECT_DELAY, MAX_PASTED_TEXT_RETRIES };



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
 * Per-tool detection constants, one row per CLI tool (Issue #3230).
 *
 * Typed as Record<CLIToolType, ...> so a tool added to CLI_TOOL_IDS without a row
 * here is a type error. Built once at module load; no pattern here carries the
 * `g` or `y` flag, so sharing the instances across calls keeps no state.
 * `skipPatterns` is copied on every getCliToolPatterns() call.
 */
interface CliToolPatternRow {
  promptPattern: RegExp;
  separatorPattern: RegExp;
  thinkingPattern: RegExp;
  skipPatterns: readonly RegExp[];
  /** buildDetectPromptOptions() result; undefined = default behavior (requireDefaultIndicator = true). */
  promptOptions: DetectPromptOptions | undefined;
  /** Hand the FULL frame to detectPrompt (see usesFullFramePrompt). */
  fullFramePrompt: boolean;
}

const CLI_TOOL_PATTERN_TABLE: Record<CLIToolType, CliToolPatternRow> = {
  claude: {
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
    // Full frame: their multiple-choice prompts with descriptions can exceed 15 lines: Codex
    // approval prompts with long file lists, Claude "Yes, and don't ask again for:
    // git commit -m …" options that embed full commit messages. `detectPrompt`
    // applies its own 50-line window internally.
    promptOptions: { requireDefaultIndicator: false },
    fullFramePrompt: true,
  },

  codex: {
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
    // Full frame: their multiple-choice prompts with descriptions can exceed 15 lines: Codex
    // approval prompts with long file lists, Claude "Yes, and don't ask again for:
    // git commit -m …" options that embed full commit messages. `detectPrompt`
    // applies its own 50-line window internally.
    promptOptions: undefined,
    fullFramePrompt: true,
  },

  gemini: {
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
    promptOptions: undefined,
    fullFramePrompt: false,
  },

  'vibe-local': {
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
    promptOptions: undefined,
    fullFramePrompt: false,
  },

  opencode: {
    promptPattern: OPENCODE_PROMPT_PATTERN,
    separatorPattern: OPENCODE_SEPARATOR_PATTERN,
    thinkingPattern: OPENCODE_THINKING_PATTERN,
    skipPatterns: OPENCODE_SKIP_PATTERNS,
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
    // Full frame: their multiple-choice prompts with descriptions can exceed 15 lines: Codex
    // approval prompts with long file lists, Claude "Yes, and don't ask again for:
    // git commit -m …" options that embed full commit messages. `detectPrompt`
    // applies its own 50-line window internally.
    promptOptions: { requireDefaultIndicator: false, hasNumberedDialogs: false },
    fullFramePrompt: true,
  },

  copilot: {
    promptPattern: COPILOT_PROMPT_PATTERN,
    separatorPattern: COPILOT_SEPARATOR_PATTERN,
    thinkingPattern: COPILOT_THINKING_PATTERN,
    skipPatterns: COPILOT_SKIP_PATTERNS,
    // [Issue #545] Copilot prompt pattern may not use standard indicators
    // Full frame: their multiple-choice prompts with descriptions can exceed 15 lines: Codex
    // approval prompts with long file lists, Claude "Yes, and don't ask again for:
    // git commit -m …" options that embed full commit messages. `detectPrompt`
    // applies its own 50-line window internally.
    promptOptions: { requireDefaultIndicator: false },
    fullFramePrompt: true,
  },

  antigravity: {
    promptPattern: ANTIGRAVITY_PROMPT_PATTERN,
    separatorPattern: ANTIGRAVITY_SEPARATOR_PATTERN,
    thinkingPattern: ANTIGRAVITY_THINKING_PATTERN,
    skipPatterns: ANTIGRAVITY_SKIP_PATTERNS,
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
    promptOptions: { requireDefaultIndicator: false },
    fullFramePrompt: false,
  },

  // Issue #2250: Command Code's layout is claude-shaped (inline transcript,
  // `❯` composer fenced by two full-width rules) but the constants are its
  // own. Sharing claude's would import the exact defect #2247 had to undo --
  // claude's rules carry a startup-banner reading that keys on `v\d+\.\d+`
  // and `|`, and Command Code prints its version into a `# Command Code
  // v1.40.1` row on every launch.
  'command-code': {
    promptPattern: COMMAND_CODE_PROMPT_PATTERN,
    separatorPattern: COMMAND_CODE_SEPARATOR_PATTERN,
    thinkingPattern: COMMAND_CODE_THINKING_PATTERN,
    skipPatterns: COMMAND_CODE_SKIP_PATTERNS,
    promptOptions: undefined,
    fullFramePrompt: false,
  },

  // Issue #2934: OpenCode V2's own constants (see OPENCODE_V2_* above). The
  // separator row is the same half-block rule v1 draws, so v1's pattern is
  // reused as a value; nothing of v1's is changed.
  'opencode-v2': {
    promptPattern: OPENCODE_V2_IDLE_COMPOSER_PATTERN,
    separatorPattern: OPENCODE_SEPARATOR_PATTERN,
    thinkingPattern: OPENCODE_V2_THINKING_PATTERN,
    skipPatterns: OPENCODE_V2_SKIP_PATTERNS,
    promptOptions: undefined,
    fullFramePrompt: false,
  },
};

/**
 * The table's own row for an id, or undefined. The table is a plain object, so a
 * name such as 'constructor' or '__proto__' must not reach Object.prototype.
 */
function ownRowFor(cliToolId: string): CliToolPatternRow | undefined {
  return Object.prototype.hasOwnProperty.call(CLI_TOOL_PATTERN_TABLE, cliToolId)
    ? CLI_TOOL_PATTERN_TABLE[cliToolId as CLIToolType]
    : undefined;
}

/**
 * Row for a tool id. An id outside CLI_TOOL_IDS (possible at runtime) falls back
 * to claude's row, as the former `default` branches did.
 */
function patternRowFor(cliToolId: CLIToolType): CliToolPatternRow {
  return ownRowFor(cliToolId) ?? CLI_TOOL_PATTERN_TABLE.claude;
}

/**
 * Detect if CLI tool is showing "thinking" indicator
 */
export function detectThinking(cliToolId: CLIToolType, content: string): boolean {
  const log = logger.withContext({ cliToolId });
  log.debug('detectThinking:check', { contentLength: content.length });

  const result = patternRowFor(cliToolId).thinkingPattern.test(content);

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
  const row = patternRowFor(cliToolId);
  return {
    promptPattern: row.promptPattern,
    separatorPattern: row.separatorPattern,
    thinkingPattern: row.thinkingPattern,
    skipPatterns: [...row.skipPatterns],
  };
}

// ANSI primitives live in a dependency-free leaf module so client components can
// reuse the same tested pattern without pulling this file's server-only imports
// (logger/db) into the browser bundle. Re-exported here for existing importers.
export { stripAnsi, extractAnsiSequences } from './ansi';

export { stripBoxDrawing };


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
  // Fresh object per call (callers may mutate); an id outside the table yields undefined.
  const options = ownRowFor(cliToolId)?.promptOptions;
  return options === undefined ? undefined : { ...options };
}

/**
 * Whether a tool hands the FULL frame to `detectPrompt` instead of the 15-line tail.
 * An id outside the table answers false.
 */
export function usesFullFramePrompt(cliToolId: string): boolean {
  return ownRowFor(cliToolId)?.fullFramePrompt ?? false;
}
