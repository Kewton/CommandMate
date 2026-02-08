/**
 * Common CLI tool patterns for response detection
 * Shared between response-poller.ts and API routes
 */

import type { CLIToolType } from './cli-tools/types';
import { createLogger } from './logger';
import { detectPrompt } from './prompt-detector';
import type { DetectPromptOptions, PromptDetectionResult } from './prompt-detector';

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
 */
export const CLAUDE_THINKING_PATTERN = new RegExp(
  `[${CLAUDE_SPINNER_CHARS.join('')}]\\s+.+…|to interrupt\\)`,
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

// =============================================================================
// Issue #193: Choice detection patterns for CLI tools
// =============================================================================

/**
 * Claude CLI choice indicator pattern: ❯ (U+276F) marker followed by number.
 * Same as DEFAULT_OPTION_PATTERN in prompt-detector.ts.
 * Anchored at both ends -- ReDoS safe (S4-001).
 */
export const CLAUDE_CHOICE_INDICATOR_PATTERN = /^\s*\u276F\s*(\d+)\.\s*(.+)$/;

/**
 * Claude CLI normal option pattern (no ❯ indicator).
 * Same as NORMAL_OPTION_PATTERN in prompt-detector.ts.
 * Anchored at both ends -- ReDoS safe (S4-001).
 */
export const CLAUDE_CHOICE_NORMAL_PATTERN = /^\s*(\d+)\.\s*(.+)$/;

/**
 * Codex CLI choice indicator pattern.
 * Codex has no special marker; all options use the same numbered format.
 * Anchored at both ends -- ReDoS safe (S4-001).
 */
export const CODEX_CHOICE_INDICATOR_PATTERN = /^\s*(\d+)\.\s*(.+)$/;

/**
 * Codex CLI normal option pattern (same as indicator since no marker).
 * Anchored at both ends -- ReDoS safe (S4-001).
 */
export const CODEX_CHOICE_NORMAL_PATTERN = /^\s*(\d+)\.\s*(.+)$/;

/**
 * Get choice detection patterns for a CLI tool.
 * Used by callers to pass to detectPrompt() options.
 *
 * Claude patterns are returned explicitly (not as empty object)
 * to make behavior self-documenting at the call site.
 */
export function getChoiceDetectionPatterns(cliToolId: CLIToolType): DetectPromptOptions {
  switch (cliToolId) {
    case 'claude':
      return {
        choiceIndicatorPattern: CLAUDE_CHOICE_INDICATOR_PATTERN,
        normalOptionPattern: CLAUDE_CHOICE_NORMAL_PATTERN,
        requireDefaultIndicator: true,
      };
    case 'codex':
      return {
        choiceIndicatorPattern: CODEX_CHOICE_INDICATOR_PATTERN,
        normalOptionPattern: CODEX_CHOICE_NORMAL_PATTERN,
        requireDefaultIndicator: false,
      };
    default:
      return {
        choiceIndicatorPattern: CLAUDE_CHOICE_INDICATOR_PATTERN,
        normalOptionPattern: CLAUDE_CHOICE_NORMAL_PATTERN,
        requireDefaultIndicator: true,
      };
  }
}

/**
 * Convenience wrapper: detect prompts using CLI-tool-specific patterns.
 *
 * Encapsulates getChoiceDetectionPatterns() + detectPrompt() into a single call
 * to reduce DRY violations across 5+ call sites.
 *
 * @param cleanOutput - ANSI-stripped output text (caller must call stripAnsi first)
 * @param cliToolId - CLI tool type
 * @returns PromptDetectionResult
 */
export function detectPromptForCli(
  cleanOutput: string,
  cliToolId: CLIToolType
): PromptDetectionResult {
  const options = getChoiceDetectionPatterns(cliToolId);
  return detectPrompt(cleanOutput, options);
}

/**
 * Strip ANSI escape codes from a string
 * Optimized version at module level for performance
 */
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\[[0-9;]*m/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_PATTERN, '');
}
