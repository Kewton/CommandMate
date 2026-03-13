/**
 * Prompt detection for Claude CLI interactive prompts
 * Detects yes/no confirmations and other interactive prompts
 */

import type { PromptData } from '@/types/models';
import { createLogger } from '@/lib/logger';

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
  /**
   * Complete prompt output (stripAnsi applied, truncated) - Issue #235
   * Note: "raw" does not mean ANSI escape codes are present.
   * This field holds the complete prompt output after stripAnsi() processing,
   * truncated to RAW_CONTENT_MAX_LINES / RAW_CONTENT_MAX_CHARS limits.
   * undefined when no prompt is detected.
   */
  rawContent?: string;
}

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
  // D2-001: Extract tail 50 lines for duplicate log suppression.
  // Reuse `lines` for both dedup check and yes/no pattern matching below.
  // detectMultipleChoicePrompt() has its own independent split() in its
  // own scope -- this is intentional function encapsulation [S1-004][S2-001].
  const lines = output.split('\n');
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

  // Pattern 0: Multiple choice (numbered options with ❯ indicator)
  // Example:
  // Do you want to proceed?
  // ❯ 1. Yes
  //   2. No
  //   3. Cancel
  const multipleChoiceResult = detectMultipleChoicePrompt(output, options);
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
 * Pattern for ❯ (U+276F) / ● (U+25CF) / › (U+203A) indicator lines used by CLI tools to mark the default selection.
 * Claude CLI uses ❯, Gemini CLI uses ●, Codex CLI uses › (Issue #372).
 * Used in Pass 1 (existence check) and Pass 2 (option collection) of the 2-pass detection.
 * Anchored at both ends -- ReDoS safe (S4-001).
 *
 * Uses [^\d]* between indicator and number to tolerate tmux capture-pane
 * rendering artifacts where garbage characters appear between ❯ and the
 * option number (e.g. "❯s1." instead of "❯ 1."). [^\d]* before (\d+) is
 * ReDoS safe because [^\d] cannot match digits, eliminating backtrack ambiguity.
 *
 * Uses (?:\.|\s{2,}) after the number to handle missing periods (same as
 * NORMAL_OPTION_PATTERN artifact tolerance).
 */
const DEFAULT_OPTION_PATTERN = /^\s*[\u276F\u25CF\u203A][^\d]*(\d+)(?:\.(?!\d)|\s{2,})\s*(.+)$/;

/**
 * Pattern for normal option lines (no ❯ indicator, just leading whitespace + number).
 * Only applied in Pass 2 when ❯ indicator existence is confirmed by Pass 1.
 * Anchored at both ends -- ReDoS safe (S4-001).
 *
 * Supports two formats:
 *   - Standard: "  2. Yes, and don't ask again" (number + period)
 *   - Artifact: "  2  Yes, and don't ask again" (number + 2+ spaces, no period)
 *
 * The artifact format occurs when Claude CLI's interactive menu renderer uses
 * cursor positioning to draw options, and tmux capture-pane captures the final
 * screen state where periods are overwritten by rendering artifacts.
 * The \s{2,} variant requires 2+ spaces to avoid matching casual text lines
 * that happen to start with a number followed by a single space.
 *
 * Uses [^\d]{0,3} prefix to tolerate up to 3 garbage non-digit characters
 * before the option number (e.g. "Es2" from "Esc to cancel" overlapping).
 * Limited to 3 chars to minimize false positive surface. ReDoS safe because
 * {0,3} bounds the repetition and [^\d] cannot match \d (no ambiguity).
 *
 * Uses (?:\.|\s+) (1+ spaces) instead of \s{2,} to handle garbled lines
 * where only 1 space remains between number and text (e.g. "Es2 tYes").
 * False positive protection relies on Layer 3 (consecutive from 1),
 * Layer 4 (2+ options), and Layer 5 (SEC-001 question line validation).
 */
const NORMAL_OPTION_PATTERN = /^\s*[^\d]{0,3}(\d+)(?:\.(?!\d)|\s+)\s*(.+)$/;

/**
 * Pattern for separator lines (horizontal rules).
 * Matches lines consisting only of dash (-) or em-dash (─) characters.
 * Used to skip separator lines in question extraction and non-option line handling.
 * Anchored at both ends -- ReDoS safe (S4-001).
 */
const SEPARATOR_LINE_PATTERN = /^[-─]+$/;

/**
 * Pattern for collapsed-output summary lines rendered by Codex/OpenAI TUI.
 * Example: "[… 12 lines] ctrl + a view all"
 *
 * These lines can appear between command previews and approval options. They are
 * not selectable options and must not be parsed as numbered choices.
 */
const COLLAPSED_OUTPUT_PATTERN = /^\s*\[[^\]]*\d+\s+lines?\]/i;

/**
 * Codex/OpenAI TUI confirmation footer shown beneath interactive choices.
 * When this footer is present, numbered options form an active prompt even if
 * the default cursor marker is missing from the capture output.
 */
const CONFIRMATION_FOOTER_PATTERN = /press\s+enter\s+to\s+confirm\s+or\s+esc\s+to\s+cancel/i;

/**
 * Maximum number of lines to scan upward from questionEndIndex
 * when the questionEndIndex line itself is not a question-like line.
 *
 * Design rationale (IC-256-001):
 * - model selection prompts have 1-2 lines between "Select model" and first option
 * - multi-line question wrapping typically produces 2-3 continuation lines
 * - value of 3 covers these cases while minimizing False Positive surface
 *
 * [SF-002] Change guidelines:
 * - Increase this value ONLY if real-world prompts are discovered where
 *   the question line is more than 3 lines above questionEndIndex
 * - Before increasing, verify that the new value does not cause
 *   T11h-T11m False Positive tests to fail
 * - Consider that larger values increase the False Positive surface area
 * - If increasing beyond 5, consider whether the detection approach
 *   itself needs to be redesigned (e.g., pattern-based instead of scan-based)
 * - Document the specific prompt pattern that necessitated the change
 *
 * @see Issue #256: multiple_choice prompt detection improvement
 */
const QUESTION_SCAN_RANGE = 3;

/**
 * Maximum consecutive continuation lines allowed between options and question.
 * Issue #372: Codex TUI indents all output with 2 spaces, causing isContinuationLine()
 * to match body text lines indefinitely. Without this limit, the scanner would traverse
 * through the entire command output, picking up numbered lists as false options.
 */
const MAX_CONTINUATION_LINES = 5;

/**
 * Maximum continuation lines for deeply indented wrapped option text.
 * Codex approval prompts can wrap long "don't ask again..." labels across many
 * lines with 5+ spaces of indentation. Allow a wider window for those cases
 * without relaxing the 2-space body-text safeguard above.
 */
const MAX_DEEP_INDENT_CONTINUATION_LINES = 12;

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

  // Pattern 1: Lines containing question mark anywhere (English '?' or full-width U+FF1F).
  // This covers both:
  //   - Lines ending with '?' (standard question format)
  //   - Lines with '?' mid-line (Issue #256: multi-line question wrapping where '?'
  //     appears mid-line due to terminal width causing the question text to wrap)
  //
  // Full-width question mark (U+FF1F) support is a defensive measure: Claude Code/CLI
  // displays questions in English, but this covers future multi-language support
  // and third-party tool integration.
  //
  // [SF-001] Scope constraints:
  // - The mid-line '?' detection is effective without False Positive risk only within
  //   SEC-001b guard context (questionEndIndex vicinity and upward scan range).
  // - isQuestionLikeLine() is currently module-private (no export).
  // - If this function is exported for external use in the future, consider:
  //   (a) Providing a stricter variant (e.g., isStrictQuestionLikeLine()) without mid-line match
  //   (b) Separating mid-line match into a SEC-001b-specific helper function
  //   (c) Adding URL exclusion logic (/[?&]\w+=/.test(line) to exclude)
  if (line.includes('?') || line.includes('\uff1f')) return true;

  // Pattern 2: Lines containing a selection/input keyword.
  // Detects both colon-terminated (e.g., "Select an option:", "Choose a mode:") and
  // non-colon forms (e.g., "Select model") used by CLI prompts (Issue #256).
  //
  // [SF-001] Scope constraints apply:
  // - Effective without False Positive risk only within SEC-001b guard context.
  // - T11h-T11m False Positive lines do not contain QUESTION_KEYWORD_PATTERN keywords.
  // - If this function is exported, consider restricting this pattern to SEC-001b context.
  if (QUESTION_KEYWORD_PATTERN.test(line)) return true;

  return false;
}

/**
 * Search upward from a given line index to find a question-like line.
 * Skips empty lines and separator lines (horizontal rules).
 *
 * This function is used by SEC-001b guard to find a question line above
 * questionEndIndex when the questionEndIndex line itself is not a question-like line.
 * This handles cases where the question text wraps across multiple lines or
 * where description lines appear between the question and the numbered options.
 *
 * @param lines - Array of output lines
 * @param startIndex - Starting line index (exclusive, searches startIndex-1 and above)
 * @param scanRange - Maximum number of lines to scan upward (must be >= 0, clamped to MAX_SCAN_RANGE=10)
 * @param lowerBound - Minimum line index (inclusive, scan will not go below this)
 * @returns true if a question-like line is found within the scan range
 *
 * @see IC-256-002: SEC-001b upward scan implementation
 * @see SF-003: Function extraction for readability
 * @see SF-S4-001: scanRange input validation (defensive clamping)
 *
 * ReDoS safe: Uses SEPARATOR_LINE_PATTERN (existing ReDoS safe pattern) and
 * isQuestionLikeLine() (literal character checks + simple alternation pattern).
 * No new regex patterns introduced. (C-S4-001)
 */
function findQuestionLineInRange(
  lines: string[],
  startIndex: number,
  scanRange: number,
  lowerBound: number
): boolean {
  // [SF-S4-001] Defensive input validation: clamp scanRange to safe bounds.
  // Currently only called with QUESTION_SCAN_RANGE=3, but guards against
  // future misuse if the function is refactored or exported.
  const safeScanRange = Math.min(Math.max(scanRange, 0), 10);
  const scanLimit = Math.max(lowerBound, startIndex - safeScanRange);
  for (let i = startIndex - 1; i >= scanLimit; i--) {
    const candidateLine = lines[i]?.trim() ?? '';
    // Skip empty lines and separator lines (horizontal rules)
    if (!candidateLine || SEPARATOR_LINE_PATTERN.test(candidateLine)) continue;
    if (isQuestionLikeLine(candidateLine)) {
      return true;
    }
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
 * [S3-010] Allows at most one single gap (e.g., [1, 3]) to handle tmux capture-pane
 * rendering artifacts where one option line becomes too garbled to parse. Claude CLI
 * prompts typically have 2-4 options, so missing 1 option is a realistic artifact
 * scenario. Constraints:
 *   - Must start from 1
 *   - Strictly increasing
 *   - Each step gap must be 1 or 2 (no skipping 2+ options at once)
 *   - At most 1 gap allowed total (rejects [1, 3, 5] which has 2 gaps)
 */
function isConsecutiveFromOne(numbers: number[]): boolean {
  if (numbers.length === 0) return false;
  if (numbers[0] !== 1) return false;
  let gapCount = 0;
  for (let i = 1; i < numbers.length; i++) {
    const gap = numbers[i] - numbers[i - 1];
    if (gap < 1 || gap > 2) return false;
    if (gap === 2) gapCount++;
    if (gapCount > 1) return false;
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
  // Lines ending with '?' or full-width '？' (U+FF1F) are typically question lines
  // (e.g., "  Do you want to proceed?", "  コピーしたい対象はどれですか？") from CLI tool output
  // where both the question and options are 2-space indented. These must NOT be
  // treated as continuation lines, otherwise questionEndIndex remains -1 and
  // Layer 5 SEC-001 blocks detection.
  const endsWithQuestion = line.endsWith('?') || line.endsWith('\uff1f');

  // Check 1: Indented non-option line (label text wrapping with indentation).
  // Must have 2+ leading spaces, not start with a number (option line), and not end with '?'.
  if (!endsWithQuestion && /^\s{2,}[^\d]/.test(rawLine) && !/^\s*\d+\./.test(rawLine)) {
    return true;
  }

  // Check 2: Short fragment (< 5 chars, e.g., filename tail).
  // Excludes question-ending lines to prevent misclassifying short questions.
  if (line.length < 5 && !endsWithQuestion) {
    return true;
  }

  // Check 3: Path string continuation (Issue #181).
  // Lines starting with / or ~, or alphanumeric-only fragments (2+ chars).
  if (/^[\/~]/.test(line) || (line.length >= 2 && /^[a-zA-Z0-9_-]+$/.test(line))) {
    return true;
  }

  return false;
}

/**
 * Extract question text from the lines around questionEndIndex.
 * Collects non-empty, non-separator lines from up to 5 lines before questionEndIndex
 * through questionEndIndex itself, joining them with spaces.
 *
 * @param lines - Array of output lines
 * @param questionEndIndex - Index of the last line before options, or -1 if not found
 * @returns Extracted question text, or generic fallback if questionEndIndex is -1
 */
function extractQuestionText(lines: string[], questionEndIndex: number): string {
  if (questionEndIndex < 0) {
    return 'Please select an option:';
  }

  const questionLines: string[] = [];
  for (let i = Math.max(0, questionEndIndex - 5); i <= questionEndIndex; i++) {
    const line = lines[i].trim();
    if (line && !SEPARATOR_LINE_PATTERN.test(line)) {
      questionLines.push(line);
    }
  }
  return questionLines.join(' ');
}

/**
 * Extract instruction text for the prompt block.
 * Captures the complete AskUserQuestion block including context before the question,
 * option descriptions, and navigation hints.
 *
 * @param lines - Array of output lines
 * @param questionEndIndex - Index of the last line before options, or -1 if not found
 * @param effectiveEnd - End index of non-trailing-empty lines
 * @returns Instruction text string, or undefined if no question line found
 */
function extractInstructionText(
  lines: string[],
  questionEndIndex: number,
  effectiveEnd: number,
): string | undefined {
  if (questionEndIndex < 0) {
    return undefined;
  }

  const contextStart = Math.max(0, questionEndIndex - 19);
  const blockLines = lines.slice(contextStart, effectiveEnd)
    .map(l => l.trimEnd());
  const joined = blockLines.join('\n').trim();
  return joined.length > 0 ? joined : undefined;
}

/**
 * Build the final PromptDetectionResult for a multiple choice prompt.
 * Maps collected options to the output format, checking each option for
 * text input requirements using TEXT_INPUT_PATTERNS.
 *
 * @param question - Extracted question text
 * @param collectedOptions - Options collected during Pass 2 scanning
 * @param instructionText - Instruction text for the prompt block
 * @param output - Original output text (used for rawContent truncation)
 * @returns PromptDetectionResult with isPrompt: true and multiple_choice data
 */
function buildMultipleChoiceResult(
  question: string,
  collectedOptions: ReadonlyArray<{ number: number; label: string; isDefault: boolean }>,
  instructionText: string | undefined,
  output: string,
): PromptDetectionResult {
  return {
    isPrompt: true,
    promptData: {
      type: 'multiple_choice',
      question: question.trim(),
      options: collectedOptions.map(opt => {
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
      instructionText,
    },
    cleanContent: question.trim(),
    rawContent: truncateRawContent(output.trim()),  // Issue #235: complete prompt output (truncated) [MF-001]
  };
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
  const scanWindow = lines.slice(scanStart, effectiveEnd);
  const hasConfirmationFooter = scanWindow.some((rawLine) => CONFIRMATION_FOOTER_PATTERN.test(rawLine.trim()));

  // ==========================================================================
  // Pass 1: Check for ❯ indicator existence in scan window
  // If no ❯ lines found and requireDefault is true, there is no multiple_choice prompt.
  // When requireDefault is false, skip this gate entirely to allow ❯-less detection.
  // ==========================================================================
  if (requireDefault) {
    let hasDefaultLine = false;
    for (const rawLine of scanWindow) {
      const line = rawLine.trim();
      if (DEFAULT_OPTION_PATTERN.test(line)) {
        hasDefaultLine = true;
        break;
      }
    }

    if (!hasDefaultLine && !hasConfirmationFooter) {
      return noPromptResult(output);
    }
  }

  // ==========================================================================
  // Pass 2: Collect options (executed when Pass 1 passes or is skipped)
  // Scan from end to find options, using both patterns.
  // ==========================================================================
  const collectedOptions: Array<{ number: number; label: string; isDefault: boolean }> = [];
  let questionEndIndex = -1;
  let continuationLineCount = 0;

  for (let i = effectiveEnd - 1; i >= scanStart; i--) {
    const line = lines[i].trim();

    // Collapsed preview markers like "[… 12 lines] ctrl + a view all" are
    // metadata, not selectable options. Skip them before option parsing to
    // avoid misclassifying "12" as an option number.
    if (COLLAPSED_OUTPUT_PATTERN.test(line)) {
      continuationLineCount++;
      continue;
    }

    // Try DEFAULT_OPTION_PATTERN first (❯ indicator)
    const defaultMatch = line.match(DEFAULT_OPTION_PATTERN);
    if (defaultMatch) {
      const number = parseInt(defaultMatch[1], 10);
      if (number <= 20) {
        const label = defaultMatch[2].trim();
        collectedOptions.unshift({ number, label, isDefault: true });
        continuationLineCount = 0;
        continue;
      }
    }

    // Try NORMAL_OPTION_PATTERN (no ❯ indicator)
    const normalMatch = line.match(NORMAL_OPTION_PATTERN);
    if (normalMatch) {
      const number = parseInt(normalMatch[1], 10);
      // Skip unreasonably large option numbers (e.g., "[… 373 lines]" from Codex
      // collapsed output matches as option 373). CLI prompts never exceed 20 options.
      if (number > 20) {
        // Treat as non-option line
      } else {
        const label = normalMatch[2].trim();
        collectedOptions.unshift({ number, label, isDefault: false });
        continuationLineCount = 0;
        continue;
      }
    }

    // [Issue #287 Bug3] User input prompt barrier:
    // When no options have been collected yet and the line starts with ❯ (U+276F)
    // but did NOT match DEFAULT_OPTION_PATTERN above, this line is a Claude Code
    // user input prompt (e.g., "❯ 1", "❯ /command") or idle prompt ("❯").
    // Anything above this line in the scrollback is historical conversation text,
    // not an active prompt. Stop scanning to prevent false positives.
    if (collectedOptions.length === 0 && (line.startsWith('\u276F') || line.startsWith('\u25CF') || line.startsWith('\u203A'))) {
      return noPromptResult(output);
    }

    // Non-option line handling
    if (collectedOptions.length > 0 && line && !SEPARATOR_LINE_PATTERN.test(line)) {
      const rawLine = lines[i]; // Original line with indentation preserved

      // [Issue #460] For deeply indented lines (4+ leading spaces), check
      // continuation BEFORE question keywords. These are option description
      // lines (e.g., "     Let Gemini CLI decide the best model...") that may
      // contain keywords like "decide" or "select" but are NOT question lines.
      // The 2-space "  Select model" case (Issue #256) is excluded by the 4+ threshold.
      const isDeepIndent = /^\s{4,}/.test(rawLine);
      if (isDeepIndent && isContinuationLine(rawLine, line)) {
        continuationLineCount++;
        if (continuationLineCount > MAX_DEEP_INDENT_CONTINUATION_LINES) {
          questionEndIndex = i;
          break;
        }
        continue;
      }

      // [MF-001 / Issue #256] Check if line is a question-like line BEFORE
      // continuation check. This preserves isContinuationLine()'s SRP by not
      // mixing question detection into it. Without this pre-check, indented
      // question lines (e.g., "  Select model") could be misclassified as
      // continuation lines by isContinuationLine()'s hasLeadingSpaces check.
      //
      // [SF-S4-003] Both this pre-check and SEC-001b upward scan use the same
      // isQuestionLikeLine() function intentionally (DRY). If a question line is
      // caught here, SEC-001b upward scan is not needed (questionEndIndex line
      // itself passes isQuestionLikeLine()).
      if (isQuestionLikeLine(line)) {
        questionEndIndex = i;
        break;
      }

      // Check if this is a continuation line (indented line between options,
      // or path/filename fragments from terminal width wrapping - Issue #181)
      if (isContinuationLine(rawLine, line)) {
        continuationLineCount++;
        const maxContinuationLines = /^\s{4,}/.test(rawLine)
          ? MAX_DEEP_INDENT_CONTINUATION_LINES
          : MAX_CONTINUATION_LINES;
        // Issue #372: Codex TUI indents all output with 2 spaces, causing
        // every line to match isContinuationLine(). Limit the scan distance
        // to prevent traversing into body text where numbered lists would be
        // collected as false options.
        if (continuationLineCount > maxContinuationLines) {
          questionEndIndex = i;
          break;
        }
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
  const allowMissingDefaultIndicator = requireDefault && hasConfirmationFooter;
  if (collectedOptions.length < 2 || (requireDefault && !hasDefaultIndicator && !allowMissingDefaultIndicator)) {
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
    //
    // [Issue #256] Enhanced with upward scan via findQuestionLineInRange() (SF-003).
    // When questionEndIndex line itself is not a question-like line, scan upward
    // within QUESTION_SCAN_RANGE to find a question line above it. This handles:
    // - Multi-line question wrapping where ? is on a line above questionEndIndex
    // - Model selection prompts where "Select model" is above description lines
    const questionLine = lines[questionEndIndex]?.trim() ?? '';
    if (!isQuestionLikeLine(questionLine)) {
      // Upward scan: look for a question-like line above questionEndIndex
      if (!findQuestionLineInRange(lines, questionEndIndex, QUESTION_SCAN_RANGE, scanStart)) {
        return noPromptResult(output);
      }
    }
  }

  const question = extractQuestionText(lines, questionEndIndex);
  const instructionText = extractInstructionText(lines, questionEndIndex, effectiveEnd);

  return buildMultipleChoiceResult(question, collectedOptions, instructionText, output);
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
