/**
 * Prompt detection for Claude CLI interactive prompts
 * Detects yes/no confirmations and other interactive prompts
 */

import type { PromptData } from '@/types/models';

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
  return {
    isPrompt: false,
    cleanContent: output.trim(),
  };
}

/**
 * Detect multiple choice prompts (numbered list with ❯ indicator)
 *
 * Example:
 * Do you want to proceed?
 * ❯ 1. Yes
 *   2. No
 *   3. Cancel
 *
 * @param output - The tmux output to analyze
 * @returns Detection result
 */
function detectMultipleChoicePrompt(output: string): PromptDetectionResult {
  const lines = output.split('\n');

  // Look for lines that match the pattern: [❯ or spaces] [number]. [text]
  const optionPattern = /^([❯ ]\s*)?(\d+)\.\s+(.+)$/;
  const options: Array<{ number: number; label: string; isDefault: boolean }> = [];

  let questionEndIndex = -1;
  let firstOptionIndex = -1;

  // Scan from the end to find options
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 20; i--) {
    const line = lines[i].trim();
    const match = line.match(optionPattern);

    if (match) {
      const hasDefault = match[1] && match[1].includes('❯');
      const number = parseInt(match[2], 10);
      const label = match[3].trim();

      // Insert at beginning since we're scanning backwards
      options.unshift({ number, label, isDefault: hasDefault });

      if (firstOptionIndex === -1) {
        firstOptionIndex = i;
      }
    } else if (options.length > 0 && line && !line.match(/^[-─]+$/)) {
      // Found a non-empty, non-separator line before options - likely the question
      questionEndIndex = i;
      break;
    }
  }

  // Must have at least 2 options to be considered a multiple choice prompt
  if (options.length < 2) {
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
      options: options.map(opt => ({
        number: opt.number,
        label: opt.label,
        isDefault: opt.isDefault,
      })),
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
