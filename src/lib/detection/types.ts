/** Shared type definitions for prompt detection modules. */

import type { PromptData } from '@/types/models';

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

  /**
   * Whether this CLI's OWN dialogs are ever answerable by typing a number
   * (Issue #1896). Default `true` -- every tool keeps the existing behaviour
   * unless it opts out.
   *
   * `false` says something measured about the tool, not about the frame: this
   * CLI renders no dialog that a typed number drives, so a `1. / 2. / 3.` block
   * on its pane is transcript by construction and
   * {@link detectMultipleChoicePrompt} must not report it as a prompt.
   *
   * This is design rule D1 decision 4
   * (`docs/design/multi-agent-state-architecture.md` §4): Auto-Yes may fire only
   * on a POSITIVELY detected tool dialog, never on the generic numbered-list
   * inference alone. Auto-Yes calls `detectPrompt` directly
   * (`auto-yes-poller.ts` -> `detectAndRespondToPrompt`), so this option is the
   * only place that can gate both it and `detectSessionStatus` at once.
   *
   * Set for `opencode` only. See {@link buildDetectPromptOptions} for the
   * measurement behind it.
   */
  hasNumberedDialogs?: boolean;

  /**
   * Pre-computed lines from output.split('\n').
   * When provided, detectPrompt() reuses these lines instead of performing
   * a redundant split('\n') on the output string.
   *
   * Issue #499 Item 4: Performance optimization to avoid duplicate split operations
   * when the caller has already split the output for other purposes.
   *
   * Note: This only applies to detectPrompt() itself. detectMultipleChoicePrompt()
   * maintains its own independent split for function encapsulation (DR1-001).
   */
  precomputedLines?: string[];
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
