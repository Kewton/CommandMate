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
export function detectPrompt(output: string): PromptDetectionResult {
  logger.debug('detectPrompt:start', { outputLength: output.length });

  const lines = output.split('\n');
  const lastLines = lines.slice(-10).join('\n');

  // Pattern 0: Multiple choice (numbered options with ❯ indicator)
  // Example:
  // Do you want to proceed?
  // ❯ 1. Yes
  //   2. No
  //   3. Cancel
  const multipleChoiceResult = detectMultipleChoicePrompt(output);
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
 * Detect multiple choice prompts (numbered list with ❯ indicator)
 *
 * This function scans the output from bottom to top looking for numbered options
 * with a selection indicator (❯). It requires at least 2 options and a default
 * indicator to be considered a valid prompt.
 *
 * Example:
 * Do you want to proceed?
 * ❯ 1. Yes
 *   2. No
 *   3. Cancel
 *
 * @param output - The tmux output to analyze (typically captured from tmux pane)
 * @returns Detection result with prompt data if a valid multiple choice prompt is found
 */
function detectMultipleChoicePrompt(output: string): PromptDetectionResult {
  const lines = output.split('\n');

  // Look for lines that match the pattern: [optional leading spaces] [❯ or spaces] [number]. [text]
  // Note: ANSI codes sometimes cause spaces to be lost after stripping, so we use \s* instead of \s+
  const optionPattern = /^\s*([❯ ]\s*)?(\d+)\.\s*(.+)$/;
  const options: Array<{ number: number; label: string; isDefault: boolean }> = [];

  let questionEndIndex = -1;
  let firstOptionIndex = -1;

  // Scan from the end to find options
  // Increased from 20 to 50 to handle multi-line wrapped options
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 50; i--) {
    const line = lines[i].trim();
    const rawLine = lines[i]; // Keep original indentation for checking
    const match = line.match(optionPattern);

    if (match) {
      const hasDefault = Boolean(match[1] && match[1].includes('❯'));
      const number = parseInt(match[2], 10);
      const label = match[3].trim();

      // Insert at beginning since we're scanning backwards
      options.unshift({ number, label, isDefault: hasDefault });

      if (firstOptionIndex === -1) {
        firstOptionIndex = i;
      }
    } else if (options.length > 0 && line && !line.match(/^[-─]+$/)) {
      // Check if this is a continuation line (indented line between options)
      // Continuation lines typically start with spaces (like "  work/github...")
      // Also treat very short lines (< 5 chars) as potential word-wrap fragments
      const hasLeadingSpaces = rawLine.match(/^\s{2,}[^\d]/) && !rawLine.match(/^\s*\d+\./);
      const isShortFragment = line.length < 5 && !line.endsWith('?');
      const isContinuationLine = hasLeadingSpaces || isShortFragment;

      if (isContinuationLine) {
        // Skip continuation lines and continue scanning for more options
        continue;
      }

      // Found a non-empty, non-separator line before options - likely the question
      questionEndIndex = i;
      break;
    }
  }

  // Must have at least 2 options AND at least one with ❯ indicator to be considered a prompt
  const hasDefaultIndicator = options.some(opt => opt.isDefault);
  if (options.length < 2 || !hasDefaultIndicator) {
    return {
      isPrompt: false,
      cleanContent: output.trim(),
    };
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
    throw new Error(`Invalid answer for multiple choice: ${answer}. Expected a number.`);
  }

  // Handle yes/no prompts
  if (normalized === 'yes' || normalized === 'y') {
    return 'y';
  }

  if (normalized === 'no' || normalized === 'n') {
    return 'n';
  }

  throw new Error(`Invalid answer: ${answer}. Expected 'yes', 'no', 'y', or 'n'.`);
}
