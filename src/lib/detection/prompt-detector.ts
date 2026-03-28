/**
 * Prompt detection for CLI interactive prompts.
 * Main dispatcher for yes/no confirmations and multiple choice prompts.
 * Issue #575: Split into sub-modules (types.ts, prompt-detect-multiple-choice.ts).
 */

import { createLogger } from '@/lib/logger';
import { detectMultipleChoicePrompt } from './prompt-detect-multiple-choice';
import type { DetectPromptOptions, PromptDetectionResult } from './types';

// Re-export types for backward compatibility (existing import paths)
export type { DetectPromptOptions, PromptDetectionResult } from './types';

const logger = createLogger('prompt-detector');

/**
 * Last output tail used for duplicate log suppression.
 * Only the last 50 lines of the output are compared.
 * This is a performance optimization to reduce log I/O -- it does NOT
 * affect detectPrompt()'s return value in any way.
 *
 * Uses pure module-scope (not globalThis) since Hot Reload reset is
 * acceptable for log-only caching. Same pattern as ip-restriction.ts
 * module-scope cache. [S2-004]
 *
 * @internal
 */
let lastOutputTail: string | null = null;

/**
 * Maximum number of lines to retain in rawContent.
 * Tail lines are preserved (instruction text typically appears just before the prompt).
 * @see truncateRawContent
 */
const RAW_CONTENT_MAX_LINES = 200;

/**
 * Maximum number of characters to retain in rawContent.
 * Tail characters are preserved.
 * @see truncateRawContent
 */
const RAW_CONTENT_MAX_CHARS = 5000;

/**
 * Truncate raw content to fit within size limits.
 * Preserves the tail (end) of the content since instruction text
 * typically appears just before the prompt at the end of output.
 *
 * Security: No regular expressions used -- no ReDoS risk. [SF-S4-002]
 * String.split('\n') and String.slice() are literal string operations only.
 *
 * @param content - The content to truncate
 * @returns Truncated content (last RAW_CONTENT_MAX_LINES lines, max RAW_CONTENT_MAX_CHARS characters)
 */
function truncateRawContent(content: string): string {
  const lines = content.split('\n');
  const truncatedLines = lines.length > RAW_CONTENT_MAX_LINES
    ? lines.slice(-RAW_CONTENT_MAX_LINES)
    : lines;
  let result = truncatedLines.join('\n');
  if (result.length > RAW_CONTENT_MAX_CHARS) {
    result = result.slice(-RAW_CONTENT_MAX_CHARS);
  }
  return result;
}

/**
 * Yes/no pattern definitions for data-driven matching.
 * Each entry defines a regex pattern and its associated default option.
 * Patterns are evaluated in order; the first match wins.
 *
 * Pattern format:
 *   - regex: Must have a capture group (1) for the question text
 *   - defaultOption: 'yes', 'no', or undefined (no default)
 */
const YES_NO_PATTERNS: ReadonlyArray<{
  regex: RegExp;
  defaultOption?: 'yes' | 'no';
}> = [
  // (y/n) - no default
  { regex: /^(.+)\s+\(y\/n\)\s*$/m },
  // [y/N] - default no
  { regex: /^(.+)\s+\[y\/N\]\s*$/m, defaultOption: 'no' },
  // [Y/n] - default yes
  { regex: /^(.+)\s+\[Y\/n\]\s*$/m, defaultOption: 'yes' },
  // (yes/no) - no default
  { regex: /^(.+)\s+\(yes\/no\)\s*$/m },
];

/**
 * Creates a yes/no prompt detection result.
 * Centralizes the repeated construction of yes_no PromptDetectionResult objects
 * used by both YES_NO_PATTERNS matching and Approve pattern matching.
 *
 * @param question - The question text
 * @param cleanContent - The clean content string
 * @param rawContent - The raw content string (last 20 lines, trimmed)
 * @param defaultOption - Optional default option ('yes' or 'no')
 * @returns PromptDetectionResult with isPrompt: true and yes_no prompt data
 */
function yesNoPromptResult(
  question: string,
  cleanContent: string,
  rawContent: string,
  defaultOption?: 'yes' | 'no',
): PromptDetectionResult {
  return {
    isPrompt: true,
    promptData: {
      type: 'yes_no',
      question,
      options: ['yes', 'no'],
      status: 'pending',
      ...(defaultOption !== undefined && { defaultOption }),
      instructionText: rawContent,
    },
    cleanContent,
    rawContent,
  };
}

/**
 * Detect if output contains an interactive prompt
 *
 * Supports the following patterns:
 * - (y/n)
 * - [y/N] (N is default)
 * - [Y/n] (Y is default)
 * - (yes/no)
 * - Approve?
 * - Multiple choice (numbered list with indicator)
 *
 * @param output - The tmux output to analyze
 * @returns Detection result
 *
 * @example
 * ```typescript
 * const result = detectPrompt('Do you want to proceed? (y/n)');
 * // result.isPrompt === true
 * // result.promptData.question === 'Do you want to proceed?'
 * ```
 */
export function detectPrompt(output: string, options?: DetectPromptOptions): PromptDetectionResult {
  // D2-001: Extract tail 50 lines for duplicate log suppression.
  // Reuse `lines` for both dedup check and yes/no pattern matching below.
  // detectMultipleChoicePrompt() has its own independent split() in its
  // own scope -- this is intentional function encapsulation [S1-004][S2-001].
  // Issue #499 Item 4: Use precomputedLines when provided to avoid redundant split.
  const lines = options?.precomputedLines ?? output.split('\n');
  const tailForDedup = lines.slice(-50).join('\n');
  const isDuplicate = tailForDedup === lastOutputTail;

  // D2-002: Only log on new (non-duplicate) output [S1-001 SRP tradeoff:
  // dedup logic is inlined here because it needs direct access to output.
  // If log suppression grows complex (e.g., per-worktree cache), extract
  // to shouldSuppressLog(output): boolean helper.]
  if (!isDuplicate) {
    logger.debug('detectPrompt:start', { outputLength: output.length });
  }

  // D2-003: Update cache (affects logging only, never return values)
  lastOutputTail = tailForDedup;

  // [SF-003] [MF-S2-001] Expanded from 10 to 20 lines for rawContent coverage
  const lastLines = lines.slice(-20).join('\n');

  // Pattern 0: Multiple choice (numbered options with indicator)
  // Example:
  // Do you want to proceed?
  // ❯ 1. Yes
  //   2. No
  //   3. Cancel
  const multipleChoiceResult = detectMultipleChoicePrompt(output, options, truncateRawContent);
  if (multipleChoiceResult.isPrompt) {
    // D2-004: Suppress duplicate multipleChoice info log
    if (!isDuplicate) {
      logger.info('detectPrompt:multipleChoice', {
        isPrompt: true,
        question: multipleChoiceResult.promptData?.question,
        optionsCount: multipleChoiceResult.promptData?.options?.length,
      });
    }
    return multipleChoiceResult;
  }

  // Patterns 1-4: Yes/no patterns (data-driven matching)
  const trimmedLastLines = lastLines.trim();
  for (const pattern of YES_NO_PATTERNS) {
    const match = lastLines.match(pattern.regex);
    if (match) {
      const question = match[1].trim();
      return yesNoPromptResult(question, question, trimmedLastLines, pattern.defaultOption);
    }
  }

  // Pattern 5: Approve?
  // Matches "Approve?" on its own line or at the end of a line
  const approvePattern = /^(.*?)Approve\?\s*$/m;
  const approveMatch = lastLines.match(approvePattern);

  if (approveMatch) {
    const content = approveMatch[1].trim();
    // If there's content before "Approve?", include it in the question
    const question = content ? `${content} Approve?` : 'Approve?';
    return yesNoPromptResult(question, content || 'Approve?', trimmedLastLines);
  }

  // No prompt detected
  // D2-005: Suppress duplicate complete log
  if (!isDuplicate) {
    logger.debug('detectPrompt:complete', { isPrompt: false });
  }
  return {
    isPrompt: false,
    cleanContent: output.trim(),
  };
}

// Re-export getAnswerInput from prompt-answer-input.ts (Issue #479: file split)
export { getAnswerInput } from '../prompt-answer-input';

/**
 * Reset the duplicate log suppression cache.
 * Intended for test isolation only.
 * @internal
 */
export function resetDetectPromptCache(): void {
  lastOutputTail = null;
}
