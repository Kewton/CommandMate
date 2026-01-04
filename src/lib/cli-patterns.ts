/**
 * Common CLI tool patterns for response detection
 * Shared between response-poller.ts and API routes
 */

import type { CLIToolType } from './cli-tools/types';

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
 */
export const CLAUDE_THINKING_PATTERN = new RegExp(
  `[${CLAUDE_SPINNER_CHARS.join('')}]\\s*\\S+…|to interrupt\\)`,
  'm'
);

/**
 * Codex thinking pattern
 * Matches activity indicators like "• Planning", "• Searching", etc.
 */
export const CODEX_THINKING_PATTERN = /•\s*(Planning|Searching|Exploring|Running|Thinking|Working|Reading|Writing|Analyzing)/m;

/**
 * Claude prompt pattern (waiting for input)
 */
export const CLAUDE_PROMPT_PATTERN = /^>\s*$/m;

/**
 * Claude separator pattern
 */
export const CLAUDE_SEPARATOR_PATTERN = /^─{10,}$/m;

/**
 * Codex prompt pattern
 */
export const CODEX_PROMPT_PATTERN = /^›\s+.+/m;

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
  switch (cliToolId) {
    case 'claude':
      return CLAUDE_THINKING_PATTERN.test(content);
    case 'codex':
      return CODEX_THINKING_PATTERN.test(content);
    case 'gemini':
      // Gemini doesn't have a thinking indicator in one-shot mode
      return false;
    default:
      return CLAUDE_THINKING_PATTERN.test(content);
  }
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
          /^>\s*$/, // Prompt line
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
 * Strip ANSI escape codes from a string
 * Optimized version at module level for performance
 */
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\[[0-9;]*m/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_PATTERN, '');
}
