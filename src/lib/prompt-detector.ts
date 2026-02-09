/**
 * Prompt detection for Claude CLI interactive prompts
 * Detects yes/no confirmations and other interactive prompts
 */

import type { PromptData } from '@/types/models';
import { createLogger } from './logger';

const logger = createLogger('prompt-detector');

/**
 * Options for prompt detection behavior customization.
 * Maintains prompt-detector.ts CLI tool independence (Issue #161 principle).
 *
 * [Future extension memo (SF-001)]
 * The current requireDefaultIndicator controls both Pass 1 (cursor existence check)
 * and Layer 4 (hasDefaultIndicator check) with a single flag. If a future requirement
 * arises to skip Pass 1 only or Layer 4 only per CLI tool, split into individual flags:
 *   skipPass1Gate?: boolean;   // Skip Pass 1 cursor existence check
 *   skipLayer4Gate?: boolean;  // Skip Layer 4 hasDefaultIndicator check
 * Per YAGNI, a single flag is maintained for now as no such requirement exists.
 */
export interface DetectPromptOptions {
  /**
   * Controls Pass 1 DEFAULT_OPTION_PATTERN existence check and
   * Layer 4 hasDefaultIndicator check.
   * - true (default): Marker required (existing behavior)
   * - false: Detect choices without marker (Claude Code special format)
   *
   * When false:
   * - Pass 1: Skip hasDefaultLine check entirely
   * - Layer 4: Skip hasDefaultIndicator check, require only options.length >= 2
   */
  requireDefaultIndicator?: boolean;
}

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

  // Patterns 1-4: Yes/no patterns (data-driven matching)
  for (const pattern of YES_NO_PATTERNS) {
    const match = lastLines.match(pattern.regex);
    if (match) {
      const question = match[1].trim();
      return {
        isPrompt: true,
        promptData: {
          type: 'yes_no',
          question,
          options: ['yes', 'no'],
          status: 'pending',
          ...(pattern.defaultOption !== undefined && { defaultOption: pattern.defaultOption }),
        },
        cleanContent: question,
      };
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
 * Pattern for separator lines (horizontal rules).
 * Matches lines consisting only of dash (-) or em-dash (─) characters.
 * Used to skip separator lines in question extraction and non-option line handling.
 * Anchored at both ends -- ReDoS safe (S4-001).
 */
const SEPARATOR_LINE_PATTERN = /^[-─]+$/;

/**
 * Creates a "no prompt detected" result.
 * Centralizes the repeated pattern of returning isPrompt: false with trimmed content.
 *
 * @param output - The original output text
 * @returns PromptDetectionResult with isPrompt: false
 */
function noPromptResult(output: string): PromptDetectionResult {
  return {
    isPrompt: false,
    cleanContent: output.trim(),
  };
}

/**
 * Pattern for detecting question/selection keywords in question lines.
 * CLI tools typically use these keywords in the line immediately before numbered choices.
 *
 * Keyword classification:
 *   [Observed] select, choose, pick, which, what, enter, confirm
 *     - Keywords confirmed in actual Claude Code / CLI tool prompts.
 *   [Defensive additions] how, where, type, specify, approve, accept, reject, decide, preference, option
 *     - Not yet observed in actual prompts, but commonly used in question sentences.
 *       Added defensively to reduce False Negative risk.
 *     - Slightly beyond YAGNI, but False Positive risk from these keywords is
 *       extremely low (they rarely appear in normal list headings).
 *     - Consider removing unused keywords if confirmed unnecessary in the future.
 *
 * No word boundaries (\b) used -- partial matches (e.g., "Selections:" matching "select")
 * are acceptable because such headings followed by consecutive numbered lists are
 * likely actual prompts. See design policy IC-004 for tradeoff analysis.
 *
 * Alternation-only pattern with no nested quantifiers -- ReDoS safe (SEC-S4-002).
 * The pattern consists only of OR (alternation) within a non-capturing group,
 * resulting in a linear-time structure (O(n)) with no backtracking risk.
 * Follows the 'ReDoS safe (S4-001)' annotation convention of existing patterns.
 */
const QUESTION_KEYWORD_PATTERN = /(?:select|choose|pick|which|what|how|where|enter|type|specify|confirm|approve|accept|reject|decide|preference|option)/i;

/**
 * Validates whether a question line actually asks a question or requests a selection.
 * Distinguishes normal heading lines ("Recommendations:", "Steps:", etc.) from
 * actual question lines ("Which option?", "Select a mode:", etc.).
 *
 * Control character resilience (SEC-S4-004): The line parameter is passed via
 * lines[questionEndIndex]?.trim(), so residual control characters from tmux
 * capture-pane output (8-bit CSI (0x9B), DEC private modes, etc. not fully
 * removed by stripAnsi()) may be present. However, endsWith('?') / endsWith(':')
 * inspect only the last character, and QUESTION_KEYWORD_PATTERN.test() matches
 * only English letter keywords, so residual control characters will not match
 * any pattern and the function returns false (false-safe).
 *
 * Full-width colon (U+FF1A) is intentionally not supported. Claude Code/CLI
 * prompts use ASCII colon. See design policy IC-008.
 *
 * @param line - The line to validate (trimmed)
 * @returns true if the line is a question/selection request, false otherwise
 */
function isQuestionLikeLine(line: string): boolean {
  // Empty lines are not questions
  if (line.length === 0) return false;

  // Pattern 1: Lines ending with question mark (English or full-width Japanese)
  // Full-width question mark (U+FF1F) support is a defensive measure: Claude Code/CLI
  // displays questions in English, but this covers future multi-language support
  // and third-party tool integration.
  if (line.endsWith('?') || line.endsWith('\uff1f')) return true;

  // Pattern 2: Lines ending with colon that contain a selection/input keyword
  // Examples: "Select an option:", "Choose a mode:", "Pick one:"
  if (line.endsWith(':')) {
    if (QUESTION_KEYWORD_PATTERN.test(line)) return true;
  }

  return false;
}

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
 *   - hasLeadingSpaces: Indented non-option line (label text wrapping with indentation).
 *     Excludes lines ending with '?' to prevent question lines (e.g., "  Do you want
 *     to proceed?") from being misclassified as continuation. Claude Bash tool outputs
 *     question and options with identical 2-space indentation, so this exclusion allows
 *     the question line to be recognized as questionEndIndex instead of being skipped.
 *   - isShortFragment: Short fragment (< 5 chars, e.g., filename tail)
 *   - isPathContinuation: Path string continuation (Issue #181)
 *
 * @param rawLine - Original line with indentation preserved (lines[i])
 * @param line - Trimmed line (lines[i].trim())
 * @returns true if the line should be treated as a continuation of a previous option
 */
function isContinuationLine(rawLine: string, line: string): boolean {
  // Indented non-option line.
  // Excludes lines ending with '?' or '？' (U+FF1F) because those are typically question lines
  // (e.g., "  Do you want to proceed?", "  コピーしたい対象はどれですか？") from CLI tool output
  // where both the question and options are 2-space indented. Without this exclusion,
  // the question line would be misclassified as a continuation line, causing
  // questionEndIndex to remain -1 and Layer 5 SEC-001 to block detection.
  const endsWithQuestion = line.endsWith('?') || line.endsWith('\uff1f');
  const hasLeadingSpaces = rawLine.match(/^\s{2,}[^\d]/) && !rawLine.match(/^\s*\d+\./) && !endsWithQuestion;
  // Short fragment (< 5 chars, excluding question-ending lines)
  const isShortFragment = line.length < 5 && !endsWithQuestion;
  // Path string continuation: lines starting with / or ~, or alphanumeric-only fragments (2+ chars)
  const isPathContinuation = /^[\/~]/.test(line) || (line.length >= 2 && /^[a-zA-Z0-9_-]+$/.test(line));
  return !!hasLeadingSpaces || isShortFragment || isPathContinuation;
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
function detectMultipleChoicePrompt(output: string, options?: DetectPromptOptions): PromptDetectionResult {
  // C-003: Use ?? true for readability instead of !== false double negation
  const requireDefault = options?.requireDefaultIndicator ?? true;

  const lines = output.split('\n');

  // Strip trailing empty lines (tmux terminal padding) before computing scan window.
  // tmux buffers often end with many empty padding lines that would shift the
  // scan window away from the actual prompt content.
  let effectiveEnd = lines.length;
  while (effectiveEnd > 0 && lines[effectiveEnd - 1].trim() === '') {
    effectiveEnd--;
  }

  // Calculate scan window: last 50 non-trailing-empty lines
  const scanStart = Math.max(0, effectiveEnd - 50);

  // ==========================================================================
  // Pass 1: Check for ❯ indicator existence in scan window
  // If no ❯ lines found and requireDefault is true, there is no multiple_choice prompt.
  // When requireDefault is false, skip this gate entirely to allow ❯-less detection.
  // ==========================================================================
  if (requireDefault) {
    let hasDefaultLine = false;
    for (let i = scanStart; i < effectiveEnd; i++) {
      const line = lines[i].trim();
      if (DEFAULT_OPTION_PATTERN.test(line)) {
        hasDefaultLine = true;
        break;
      }
    }

    if (!hasDefaultLine) {
      return noPromptResult(output);
    }
  }

  // ==========================================================================
  // Pass 2: Collect options (executed when Pass 1 passes or is skipped)
  // Scan from end to find options, using both patterns.
  // ==========================================================================
  const collectedOptions: Array<{ number: number; label: string; isDefault: boolean }> = [];
  let questionEndIndex = -1;

  for (let i = effectiveEnd - 1; i >= scanStart; i--) {
    const line = lines[i].trim();

    // Try DEFAULT_OPTION_PATTERN first (❯ indicator)
    const defaultMatch = line.match(DEFAULT_OPTION_PATTERN);
    if (defaultMatch) {
      const number = parseInt(defaultMatch[1], 10);
      const label = defaultMatch[2].trim();
      collectedOptions.unshift({ number, label, isDefault: true });
      continue;
    }

    // Try NORMAL_OPTION_PATTERN (no ❯ indicator)
    const normalMatch = line.match(NORMAL_OPTION_PATTERN);
    if (normalMatch) {
      const number = parseInt(normalMatch[1], 10);
      const label = normalMatch[2].trim();
      collectedOptions.unshift({ number, label, isDefault: false });
      continue;
    }

    // Non-option line handling
    if (collectedOptions.length > 0 && line && !SEPARATOR_LINE_PATTERN.test(line)) {
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
  const optionNumbers = collectedOptions.map(opt => opt.number);
  if (!isConsecutiveFromOne(optionNumbers)) {
    return noPromptResult(output);
  }

  // Layer 4: Must have at least 2 options. When requireDefault is true,
  // also require at least one option with ❯ indicator.
  const hasDefaultIndicator = collectedOptions.some(opt => opt.isDefault);
  if (collectedOptions.length < 2 || (requireDefault && !hasDefaultIndicator)) {
    return noPromptResult(output);
  }

  // Layer 5 [SEC-001]: Enhanced question line validation for requireDefaultIndicator=false.
  // When requireDefault is false, apply stricter validation to prevent false positives
  // from normal numbered lists (e.g., "Recommendations:\n1. Add tests\n2. Update docs").
  if (!requireDefault) {
    // SEC-001a: No question line found (questionEndIndex === -1) - reject.
    // Prevents generic question fallback from triggering Auto-Yes
    // on plain numbered lists that happen to be consecutive from 1.
    if (questionEndIndex === -1) {
      return noPromptResult(output);
    }

    // SEC-001b: Question line exists but is not actually a question/selection request.
    // Validates that the question line contains a question mark or a selection keyword
    // with colon, distinguishing "Select an option:" from "Recommendations:".
    const questionLine = lines[questionEndIndex]?.trim() ?? '';
    if (!isQuestionLikeLine(questionLine)) {
      return noPromptResult(output);
    }
  }

  // Extract question text
  let question = '';
  if (questionEndIndex >= 0) {
    // Get all non-empty lines from questionEndIndex up to (but not including) first option
    const questionLines: string[] = [];
    for (let i = Math.max(0, questionEndIndex - 5); i <= questionEndIndex; i++) {
      const line = lines[i].trim();
      if (line && !SEPARATOR_LINE_PATTERN.test(line)) {
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
      options: collectedOptions.map(opt => {
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
    // SEC-003: Fixed error message without user input to prevent log injection
    throw new Error('Invalid answer for multiple choice prompt. Expected a number.');
  }

  // Handle yes/no prompts
  if (normalized === 'yes' || normalized === 'y') {
    return 'y';
  }

  if (normalized === 'no' || normalized === 'n') {
    return 'n';
  }

  // SEC-003: Fixed error message without user input to prevent log injection
  throw new Error("Invalid answer for yes/no prompt. Expected 'yes', 'no', 'y', or 'n'.");
}
