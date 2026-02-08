/**
 * Prompt detection for Claude CLI interactive prompts
 * Detects yes/no confirmations and other interactive prompts
 */

import type { PromptData } from '@/types/models';
import { createLogger } from './logger';

const logger = createLogger('prompt-detector');

/**
 * Prompt detection result
 */
export interface PromptDetectionResult {
  /** Whether a prompt was detected */
  isPrompt: boolean;
  /** Prompt data (if detected) */
  promptData?: PromptData;
  /** Clean content without prompt suffix */
  cleanContent: string;
}

/**
 * Options for customizing prompt detection patterns.
 * When omitted, defaults to Claude CLI patterns (backward compatible).
 *
 * Issue #193: Added to support Codex CLI multiple choice detection.
 */
export interface DetectPromptOptions {
  /**
   * Pattern for the default option indicator line.
   * Claude: /^\s*\u276F\s*(\d+)\.\s*(.+)$/ (marker)
   * Codex: /^\s*(\d+)\.\s*(.+)$/ (no special marker)
   */
  choiceIndicatorPattern?: RegExp;

  /**
   * Pattern for normal option lines (no indicator).
   * Default: /^\s*(\d+)\.\s*(.+)$/
   */
  normalOptionPattern?: RegExp;

  /**
   * Whether Layer 4 validation (at least one default indicator must exist)
   * should be enforced. Defaults to true for backward compatibility (Claude).
   *
   * Set to false for CLI tools that do not have a default-indicator concept
   * (e.g., Codex presents choices without marking a default).
   */
  requireDefaultIndicator?: boolean;
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
 * - Multiple choice (numbered list with ❯ indicator)
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
  logger.debug('detectPrompt:start', { outputLength: output.length });

  const lines = output.split('\n');
  const lastLines = lines.slice(-10).join('\n');

  // Pattern 0: Multiple choice (numbered options with ❯ indicator)
  // Example:
  // Do you want to proceed?
  // ❯ 1. Yes
  //   2. No
  //   3. Cancel
  const multipleChoiceResult = detectMultipleChoicePrompt(output, options);
  if (multipleChoiceResult.isPrompt) {
    logger.info('detectPrompt:multipleChoice', {
      isPrompt: true,
      question: multipleChoiceResult.promptData?.question,
      optionsCount: multipleChoiceResult.promptData?.options?.length,
    });
    return multipleChoiceResult;
  }

  // Pattern 1: (y/n)
  const yesNoPattern = /^(.+)\s+\(y\/n\)\s*$/m;
  const match1 = lastLines.match(yesNoPattern);

  if (match1) {
    return {
      isPrompt: true,
      promptData: {
        type: 'yes_no',
        question: match1[1].trim(),
        options: ['yes', 'no'],
        status: 'pending',
      },
      cleanContent: match1[1].trim(),
    };
  }

  // Pattern 2: [y/N] (N is default)
  const yesNoDefaultPattern = /^(.+)\s+\[y\/N\]\s*$/m;
  const match2 = lastLines.match(yesNoDefaultPattern);

  if (match2) {
    return {
      isPrompt: true,
      promptData: {
        type: 'yes_no',
        question: match2[1].trim(),
        options: ['yes', 'no'],
        status: 'pending',
        defaultOption: 'no',
      },
      cleanContent: match2[1].trim(),
    };
  }

  // Pattern 3: [Y/n] (Y is default)
  const yesDefaultPattern = /^(.+)\s+\[Y\/n\]\s*$/m;
  const match3 = lastLines.match(yesDefaultPattern);

  if (match3) {
    return {
      isPrompt: true,
      promptData: {
        type: 'yes_no',
        question: match3[1].trim(),
        options: ['yes', 'no'],
        status: 'pending',
        defaultOption: 'yes',
      },
      cleanContent: match3[1].trim(),
    };
  }

  // Pattern 4: (yes/no)
  const yesNoFullPattern = /^(.+)\s+\(yes\/no\)\s*$/m;
  const match4 = lastLines.match(yesNoFullPattern);

  if (match4) {
    return {
      isPrompt: true,
      promptData: {
        type: 'yes_no',
        question: match4[1].trim(),
        options: ['yes', 'no'],
        status: 'pending',
      },
      cleanContent: match4[1].trim(),
    };
  }

  // Pattern 5: Approve?
  // Matches "Approve?" on its own line or at the end of a line
  const approvePattern = /^(.*?)Approve\?\s*$/m;
  const match5 = lastLines.match(approvePattern);

  if (match5) {
    const content = match5[1].trim();
    // If there's content before "Approve?", include it in the question
    const question = content ? `${content} Approve?` : 'Approve?';
    return {
      isPrompt: true,
      promptData: {
        type: 'yes_no',
        question: question,
        options: ['yes', 'no'],
        status: 'pending',
      },
      cleanContent: content || 'Approve?',
    };
  }

  // No prompt detected
  logger.debug('detectPrompt:complete', { isPrompt: false });
  return {
    isPrompt: false,
    cleanContent: output.trim(),
  };
}

/**
 * Text input patterns for multiple choice options
 * Options matching these patterns require additional text input from the user
 */
const TEXT_INPUT_PATTERNS: RegExp[] = [
  /type\s+here/i,
  /tell\s+(me|claude)/i,
  /enter\s+/i,
  /custom/i,
  /differently/i,
];

/**
 * Pattern for ❯ (U+276F) indicator lines used by Claude CLI to mark the default selection.
 * Used in Pass 1 (existence check) and Pass 2 (option collection) of the 2-pass detection.
 * Anchored at both ends -- ReDoS safe (S4-001).
 */
const DEFAULT_OPTION_PATTERN = /^\s*\u276F\s*(\d+)\.\s*(.+)$/;

/**
 * Pattern for normal option lines (no ❯ indicator, just leading whitespace + number).
 * Only applied in Pass 2 when ❯ indicator existence is confirmed by Pass 1.
 * Anchored at both ends -- ReDoS safe (S4-001).
 */
const NORMAL_OPTION_PATTERN = /^\s*(\d+)\.\s*(.+)$/;

/**
 * Defensive check: protection against future unknown false positive patterns.
 * Note: The actual false positive pattern in Issue #161 ("1. Create file\n2. Run tests")
 * IS consecutive from 1, so this validation alone does not prevent it.
 * The primary defense layers are: Layer 1 (thinking check in caller) + Layer 2 (2-pass
 * cursor detection). This function provides Layer 3 defense against future unknown
 * patterns with scattered/non-consecutive numbering.
 *
 * [S3-010] This validation assumes Claude CLI always uses consecutive numbering
 * starting from 1. If in the future Claude CLI is observed to filter choices and
 * output non-consecutive numbers (e.g., 1, 2, 4), consider relaxing this validation
 * (e.g., only check starts-from-1, remove consecutive requirement).
 */
function isConsecutiveFromOne(numbers: number[]): boolean {
  if (numbers.length === 0) return false;
  if (numbers[0] !== 1) return false;
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] !== numbers[i - 1] + 1) return false;
  }
  return true;
}

/**
 * Continuation line detection for multiline option text wrapping.
 * Detects lines that are part of a previous option's text, wrapped due to terminal width.
 *
 * Called within detectMultipleChoicePrompt() Pass 2 reverse scan, only when
 * options.length > 0 (at least one option already detected):
 *   const rawLine = lines[i];       // Original line with indentation preserved
 *   const line = lines[i].trim();   // Trimmed line
 *   if (options.length > 0 && line && !line.match(/^[-─]+$/)) {
 *     if (isContinuationLine(rawLine, line)) { continue; }
 *   }
 *
 * Each condition's responsibility:
 *   - hasLeadingSpaces: Indented non-option line (label text wrapping with indentation)
 *   - isShortFragment: Short fragment (< 5 chars, e.g., filename tail)
 *   - isPathContinuation: Path string continuation (Issue #181)
 *
 * @param rawLine - Original line with indentation preserved (lines[i])
 * @param line - Trimmed line (lines[i].trim())
 * @returns true if the line should be treated as a continuation of a previous option
 */
function isContinuationLine(rawLine: string, line: string): boolean {
  // Indented non-option line
  const hasLeadingSpaces = rawLine.match(/^\s{2,}[^\d]/) && !rawLine.match(/^\s*\d+\./);
  // Short fragment (< 5 chars, excluding question-ending lines)
  const isShortFragment = line.length < 5 && !line.endsWith('?');
  // Path string continuation: lines starting with / or ~, or alphanumeric-only fragments (2+ chars)
  const isPathContinuation = /^[\/~]/.test(line) || (line.length >= 2 && /^[a-zA-Z0-9_-]+$/.test(line));
  return !!(hasLeadingSpaces) || isShortFragment || isPathContinuation;
}

/**
 * Detect multiple choice prompts (numbered list with ❯ indicator)
 *
 * Uses a 2-pass detection approach (Issue #161):
 * - Pass 1: Scan 50-line window for ❯ indicator lines (defaultOptionPattern).
 *   If no ❯ lines found, immediately return isPrompt: false.
 * - Pass 2: Only if ❯ was found, re-scan collecting options using both
 *   defaultOptionPattern (isDefault=true) and normalOptionPattern (isDefault=false).
 *
 * This prevents normal numbered lists from being accumulated in the options array.
 *
 * Example of valid prompt:
 * Do you want to proceed?
 * ❯ 1. Yes
 *   2. No
 *   3. Cancel
 *
 * @param output - The tmux output to analyze (typically captured from tmux pane)
 * @returns Detection result with prompt data if a valid multiple choice prompt is found
 */
function detectMultipleChoicePrompt(output: string, opts?: DetectPromptOptions): PromptDetectionResult {
  const lines = output.split('\n');

  // Parameterized patterns (Issue #193)
  const indicatorPattern = opts?.choiceIndicatorPattern ?? DEFAULT_OPTION_PATTERN;
  const normalPattern = opts?.normalOptionPattern ?? NORMAL_OPTION_PATTERN;
  const requireDefault = opts?.requireDefaultIndicator ?? true;

  // Calculate scan window: last 50 lines
  const scanStart = Math.max(0, lines.length - 50);

  // ==========================================================================
  // Pass 1: Check for indicator existence in scan window
  // If no indicator lines found and requireDefaultIndicator=true,
  // there is no multiple_choice prompt.
  // When requireDefaultIndicator=false, skip this early-exit check
  // since the indicator pattern may match all options.
  // ==========================================================================
  let hasDefaultLine = false;
  for (let i = scanStart; i < lines.length; i++) {
    const line = lines[i].trim();
    if (indicatorPattern.test(line)) {
      hasDefaultLine = true;
      break;
    }
  }

  if (!hasDefaultLine) {
    return {
      isPrompt: false,
      cleanContent: output.trim(),
    };
  }

  // ==========================================================================
  // Pass 2: Collect options (only executed when indicator was found in Pass 1)
  // Scan from end to find options, using both patterns.
  // ==========================================================================
  const options: Array<{ number: number; label: string; isDefault: boolean }> = [];
  let questionEndIndex = -1;

  for (let i = lines.length - 1; i >= scanStart; i--) {
    const line = lines[i].trim();

    // Try indicator pattern first (e.g., ❯ indicator for Claude)
    const defaultMatch = line.match(indicatorPattern);
    if (defaultMatch) {
      const number = parseInt(defaultMatch[1], 10);
      const label = defaultMatch[2].trim();
      options.unshift({ number, label, isDefault: true });
      continue;
    }

    // Try normal pattern (no indicator)
    const normalMatch = line.match(normalPattern);
    if (normalMatch) {
      const number = parseInt(normalMatch[1], 10);
      const label = normalMatch[2].trim();
      options.unshift({ number, label, isDefault: false });
      continue;
    }

    // Non-option line handling
    if (options.length > 0 && line && !line.match(/^[-─]+$/)) {
      // Check if this is a continuation line (indented line between options,
      // or path/filename fragments from terminal width wrapping - Issue #181)
      const rawLine = lines[i]; // Original line with indentation preserved
      if (isContinuationLine(rawLine, line)) {
        // Skip continuation lines and continue scanning for more options
        continue;
      }

      // Found a non-empty, non-separator line before options - likely the question
      questionEndIndex = i;
      break;
    }
  }

  // Layer 3: Consecutive number validation (defensive measure)
  const optionNumbers = options.map(opt => opt.number);
  if (!isConsecutiveFromOne(optionNumbers)) {
    return {
      isPrompt: false,
      cleanContent: output.trim(),
    };
  }

  // Layer 4a: Must have at least 2 options
  if (options.length < 2) {
    return {
      isPrompt: false,
      cleanContent: output.trim(),
    };
  }

  // Layer 4b: Require at least one default indicator (Issue #193: conditional)
  // When requireDefaultIndicator=false (e.g., Codex), skip this check
  if (requireDefault) {
    const hasDefaultIndicator = options.some(opt => opt.isDefault);
    if (!hasDefaultIndicator) {
      return {
        isPrompt: false,
        cleanContent: output.trim(),
      };
    }
  }

  // Extract question text
  let question = '';
  if (questionEndIndex >= 0) {
    // Get all non-empty lines from questionEndIndex up to (but not including) first option
    const questionLines: string[] = [];
    for (let i = Math.max(0, questionEndIndex - 5); i <= questionEndIndex; i++) {
      const line = lines[i].trim();
      if (line && !line.match(/^[-─]+$/)) {
        questionLines.push(line);
      }
    }
    question = questionLines.join(' ');
  } else {
    // No clear question found - use a generic one
    question = 'Please select an option:';
  }

  return {
    isPrompt: true,
    promptData: {
      type: 'multiple_choice',
      question: question.trim(),
      options: options.map(opt => {
        // Check if this option requires text input using module-level patterns
        const requiresTextInput = TEXT_INPUT_PATTERNS.some(pattern =>
          pattern.test(opt.label)
        );

        return {
          number: opt.number,
          label: opt.label,
          isDefault: opt.isDefault,
          requiresTextInput,
        };
      }),
      status: 'pending',
    },
    cleanContent: question.trim(),
  };
}

/**
 * Get tmux input string for an answer
 *
 * @param answer - User's answer ('yes', 'no', 'y', 'n', or number for multiple choice)
 * @param promptType - Type of prompt (defaults to 'yes_no')
 * @returns tmux input string ('y', 'n', or the number as string)
 * @throws Error if answer is invalid
 *
 * @example
 * ```typescript
 * getAnswerInput('yes'); // => 'y'
 * getAnswerInput('no');  // => 'n'
 * getAnswerInput('Y');   // => 'y'
 * getAnswerInput('1', 'multiple_choice'); // => '1'
 * ```
 */
export function getAnswerInput(answer: string, promptType: string = 'yes_no'): string {
  const normalized = answer.toLowerCase().trim();

  // Handle multiple choice - just return the number
  if (promptType === 'multiple_choice') {
    // Validate it's a number
    if (/^\d+$/.test(normalized)) {
      return normalized;
    }
    throw new Error('Invalid answer for multiple choice prompt. Expected a number.');
  }

  // Handle yes/no prompts
  if (normalized === 'yes' || normalized === 'y') {
    return 'y';
  }

  if (normalized === 'no' || normalized === 'n') {
    return 'n';
  }

  throw new Error("Invalid answer for yes/no prompt. Expected 'yes', 'no', 'y', or 'n'.");
}
