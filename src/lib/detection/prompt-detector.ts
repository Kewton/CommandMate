/**
 * Prompt detection for CLI interactive prompts.
 * Main dispatcher for yes/no confirmations and multiple choice prompts.
 * Issue #575: Split into sub-modules (types.ts, prompt-detect-multiple-choice.ts).
 */

import { createLogger } from '@/lib/logger';
import {
  detectMultipleChoicePrompt,
  joinApprovalTarget,
} from './prompt-detect-multiple-choice';
import { findYesNoApprovalContextRange } from './prompt-detect-multiple-choice-approval-context';
import type { ApprovalContextReading, DetectPromptOptions, PromptDetectionResult } from './types';
import { normalizeTuiFrameForDetection } from './tui-detection-frame';
import { truncateRawContent } from './truncate-raw-content';

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
 * Yes/no pattern definitions for data-driven matching.
 * Each entry defines a regex pattern and its associated default option.
 *
 * Issue #3881 (H-4): every pattern's every match in the tail window is a
 * candidate, and the LATEST one (the lowest on the pane) is the prompt — see
 * {@link findYesNoCandidates}. Before, the patterns were tried in this order
 * and the first match of the first pattern won, so an older `(y/n)` quoted in
 * the transcript beat the live `[y/N]` under it, and the deny patterns were
 * judged against the old prompt's rows.
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
 * Where in `lines` a regex match against the joined tail window started and ended.
 *
 * The yes/no patterns are matched against the last 20 lines joined into one
 * string, so a match carries no line number of its own. Issue #1699 needs one:
 * the approval target is bounded relative to the line the prompt is actually on,
 * not relative to the bottom of the pane.
 */
function locateMatchLines(
  tailText: string,
  tailStart: number,
  match: RegExpMatchArray,
): { startLine: number; endLine: number } {
  const offset = match.index ?? 0;
  const countNewlines = (text: string): number => text.split('\n').length - 1;
  const startLine = tailStart + countNewlines(tailText.slice(0, offset));
  return { startLine, endLine: startLine + countNewlines(match[0]) };
}

/** One yes/no match in the tail window (Issue #3881, H-4). */
interface YesNoCandidate {
  match: RegExpMatchArray;
  defaultOption?: 'yes' | 'no';
  startLine: number;
  endLine: number;
}

/**
 * Every yes/no match in the tail window, oldest first (Issue #3881, H-4).
 *
 * Matched against the same joined window with the same patterns as before, so
 * a line reads as a candidate exactly when it read as a prompt before; only
 * which candidate wins changed. Sorted by the row the match ends on, then by
 * where it starts, then by pattern order (a row cannot end in two spellings,
 * so the last key only keeps the order deterministic).
 */
function findYesNoCandidates(lastLines: string, tailStart: number): YesNoCandidate[] {
  const candidates: (YesNoCandidate & { offset: number; order: number })[] = [];
  YES_NO_PATTERNS.forEach((pattern, order) => {
    const global = new RegExp(pattern.regex.source, `${pattern.regex.flags}g`);
    for (const match of lastLines.matchAll(global)) {
      const { startLine, endLine } = locateMatchLines(lastLines, tailStart, match);
      candidates.push({ match, defaultOption: pattern.defaultOption, startLine, endLine, offset: match.index ?? 0, order });
    }
  });
  candidates.sort((a, b) => a.endLine - b.endLine || a.offset - b.offset || a.order - b.order);
  return candidates;
}

/**
 * What a yes/no prompt is asking approval for (Issue #1699).
 *
 * Bounded on both sides, unlike `instructionText`: below at the prompt line
 * itself (nothing printed after the question is part of what it approves) and
 * above at the previous turn's boundary. A shell that echoes the command
 * directly above its `(y/n)` — the case the deny patterns were written for —
 * still lands inside; a command approved in an earlier turn does not.
 */
function yesNoApprovalTarget(
  lines: string[],
  tailText: string,
  tailStart: number,
  match: RegExpMatchArray,
  olderCandidates: readonly YesNoCandidate[] = [],
): YesNoApprovalBlock {
  const { startLine, endLine } = locateMatchLines(tailText, tailStart, match);
  // Issue #3881: a here-document's `> ` row at the prompt's column is not a
  // known boundary (limit 3 of #3832) — `truncated`, not complete.
  const range = findYesNoApprovalContextRange(lines, startLine, endLine + 1);
  // Issue #3881 (H-4): another yes/no prompt inside this prompt's own block
  // means the block holds two questions, and which rows the live one asks
  // about cannot be told from the screen — not the whole request either.
  const contested = olderCandidates.some(c => c.endLine >= range.start && c.endLine < startLine);
  return {
    approvalTarget: joinApprovalTarget(lines, range.start, endLine + 1),
    // Issue #3881 (H-3): whether the scan above stopped at a boundary.
    approvalContext: {
      startRow: range.start,
      endRow: endLine + 1,
      completeness: contested ? 'truncated' : range.completeness,
    },
  };
}

/** What {@link yesNoApprovalTarget} read (Issue #3881). */
interface YesNoApprovalBlock {
  approvalTarget: string | undefined;
  approvalContext: ApprovalContextReading;
}

/**
 * Creates a yes/no prompt detection result.
 * Centralizes the repeated construction of yes_no PromptDetectionResult objects
 * used by both YES_NO_PATTERNS matching and Approve pattern matching.
 *
 * @param question - The question text
 * @param cleanContent - The clean content string
 * @param rawContent - The raw content string (last 20 lines, trimmed)
 * @param approvalBlock - Issue #1699 deny-match surface for this prompt, and
 *   (Issue #3881) the rows it was cut from and whether its top is a boundary
 * @param defaultOption - Optional default option ('yes' or 'no')
 * @returns PromptDetectionResult with isPrompt: true and yes_no prompt data
 */
function yesNoPromptResult(
  question: string,
  cleanContent: string,
  rawContent: string,
  { approvalTarget, approvalContext }: YesNoApprovalBlock,
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
      // Issue #235: the wide window, for the human reading PromptPanel.
      instructionText: rawContent,
      // Issue #1699: the narrow one, for machine judgement. Keeping the two
      // apart is the whole fix — the wide window is a scrollback view and a
      // deny pattern matched against it fires on turns that are already done.
      ...(approvalTarget !== undefined && { approvalTarget }),
      // Issue #3881 (H-3): a target the line cap cut short is not the whole
      // request, and the resolver must not take a deny miss on it as a pass.
      ...(approvalTarget !== undefined && approvalContext.completeness === 'truncated' && {
        approvalTargetCompleteness: 'truncated' as const,
      }),
    },
    cleanContent,
    rawContent,
    approvalContext,
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
  const detectionOutput = normalizeTuiFrameForDetection(output);
  // D2-001: Extract tail 50 lines for duplicate log suppression.
  // Reuse `lines` for both dedup check and yes/no pattern matching below.
  // detectMultipleChoicePrompt() has its own independent split() in its
  // own scope -- this is intentional function encapsulation [S1-004][S2-001].
  // Issue #499 Item 4: Use precomputedLines when provided to avoid redundant split.
  const lines = detectionOutput === output && options?.precomputedLines
    ? options.precomputedLines
    : detectionOutput.split('\n');
  const tailForDedup = lines.slice(-50).join('\n');
  const isDuplicate = tailForDedup === lastOutputTail;

  // D2-002: Only log on new (non-duplicate) output [S1-001 SRP tradeoff:
  // dedup logic is inlined here because it needs direct access to output.
  // If log suppression grows complex (e.g., per-worktree cache), extract
  // to shouldSuppressLog(output): boolean helper.]
  if (!isDuplicate) {
    logger.debug('detectPrompt:start', { outputLength: detectionOutput.length });
  }

  // D2-003: Update cache (affects logging only, never return values)
  lastOutputTail = tailForDedup;

  // [SF-003] [MF-S2-001] Expanded from 10 to 20 lines for rawContent coverage
  const lastLines = lines.slice(-20).join('\n');
  // Absolute index of lastLines[0] in `lines`, so a match inside the joined tail
  // can be mapped back to a line number (Issue #1699).
  const tailStart = Math.max(0, lines.length - 20);

  // Pattern 0: Multiple choice (numbered options with indicator)
  // Example:
  // Do you want to proceed?
  // ❯ 1. Yes
  //   2. No
  //   3. Cancel
  const multipleChoiceResult = detectMultipleChoicePrompt(detectionOutput, options, truncateRawContent);
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

  // Patterns 1-4: Yes/no patterns (data-driven matching). Issue #3881 (H-4):
  // the latest candidate in the window, not the first pattern's first match.
  const trimmedLastLines = lastLines.trim();
  const yesNoCandidates = findYesNoCandidates(lastLines, tailStart);
  const live = yesNoCandidates[yesNoCandidates.length - 1];
  if (live) {
    const question = live.match[1].trim();
    return yesNoPromptResult(
      question,
      question,
      trimmedLastLines,
      yesNoApprovalTarget(lines, lastLines, tailStart, live.match, yesNoCandidates.slice(0, -1)),
      live.defaultOption,
    );
  }

  // Pattern 5: Approve?
  // Matches "Approve?" on its own line or at the end of a line
  // Issue #3881 (H-4): the latest one in the window, like the patterns above.
  const approvePattern = /^(.*?)Approve\?\s*$/gm;
  const approveMatch = [...lastLines.matchAll(approvePattern)].pop();

  if (approveMatch) {
    const content = approveMatch[1].trim();
    // If there's content before "Approve?", include it in the question
    const question = content ? `${content} Approve?` : 'Approve?';
    return yesNoPromptResult(
      question,
      content || 'Approve?',
      trimmedLastLines,
      yesNoApprovalTarget(lines, lastLines, tailStart, approveMatch),
    );
  }

  // No prompt detected
  // D2-005: Suppress duplicate complete log
  if (!isDuplicate) {
    logger.debug('detectPrompt:complete', { isPrompt: false });
  }
  return {
    isPrompt: false,
    cleanContent: detectionOutput.trim(),
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
