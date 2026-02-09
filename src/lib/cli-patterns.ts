/**
 * Common CLI tool patterns for response detection
 * Shared between response-poller.ts and API routes
 */

import type { CLIToolType } from './cli-tools/types';
import type { DetectPromptOptions } from './prompt-detector';
import { createLogger } from './logger';

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
 * Alternative 2: "esc to interrupt" status bar text (Issue #XXX)
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
 * Codex separator pattern
 */
export const CODEX_SEPARATOR_PATTERN = /^─.*Worked for.*─+$/m;

/**
 * Gemini shell prompt pattern
 */
export const GEMINI_PROMPT_PATTERN = /^(%|\$|.*@.*[%$#])\s*$/m;

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
      // Gemini doesn't have a thinking indicator in one-shot mode
      result = false;
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
        ],
      };

    case 'gemini':
      return {
        promptPattern: GEMINI_PROMPT_PATTERN,
        separatorPattern: /^gemini\s+--\s+/m,
        thinkingPattern: /(?!)/m, // Never matches - one-shot execution
        skipPatterns: [
          /^gemini\s+--\s+/, // Command line itself
          GEMINI_PROMPT_PATTERN, // Shell prompt lines
          /^\s*$/, // Empty lines
        ],
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
 * Build DetectPromptOptions for a given CLI tool.
 * Centralizes cliToolId-to-options mapping logic (DRY - MF-001).
 *
 * prompt-detector.ts remains CLI tool independent (Issue #161 principle);
 * this function lives in cli-patterns.ts which already depends on CLIToolType.
 *
 * [Future extension memo (C-002)]
 * If CLI tool count grows significantly (currently 3), consider migrating
 * to a CLIToolConfig registry pattern where tool-specific settings
 * (including promptDetectionOptions) are managed in a Record<CLIToolType, CLIToolConfig>.
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
  return undefined; // Default behavior (requireDefaultIndicator = true)
}
