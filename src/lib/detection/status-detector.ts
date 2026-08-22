/**
 * Session status detection for CLI tools.
 * Issue #54: Improved status detection with confidence levels.
 * Issue #188: Thinking indicator false detection fix (windowed detection).
 *
 * This module provides reliable session status detection by:
 * 1. Checking for interactive prompts (yes/no, multiple choice)
 * 2. Checking for thinking/processing indicators (windowed to last N lines)
 * 3. Checking for input prompts (ready for user input)
 * 4. Using time-based heuristics when patterns don't match
 *
 * Architecture note (Issue #408: SF-001 resolved):
 * Previously, this module returned StatusDetectionResult without
 * PromptDetectionResult (SF-001 tradeoff). Callers needing promptData
 * had to call detectPrompt() separately, resulting in a controlled DRY violation.
 *
 * Issue #408 resolved this by adding a required promptDetection field to
 * StatusDetectionResult. The SRP concern was mitigated by:
 *   - Callers not needing promptData can simply ignore the field
 *   - PromptDetectionResult being a stable type with low change frequency
 *
 * Future guideline (DR1-002): If PromptDetectionResult gains high-frequency
 * changes or large structural modifications, consider re-evaluating this
 * coupling via a minimal DTO/projection type.
 */

import { STATUS_REASON } from './status-reason';
import { normalizeFrame } from './tools/frame';
import { getToolStatusDetector } from './tools/registry';
import type { PromptDetectionResult } from './prompt-detector';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { StatusEvidence } from '@/lib/session/status-evidence';

/**
 * Session status types
 */
export type SessionStatus = 'idle' | 'ready' | 'running' | 'waiting';

/**
 * Status confidence levels
 * - high: Pattern clearly detected
 * - low: Heuristic-based determination
 */
export type StatusConfidence = 'high' | 'low';

/**
 * Status detection result
 */
export interface StatusDetectionResult {
  /** Detected session status */
  status: SessionStatus;
  /** Confidence level of the detection */
  confidence: StatusConfidence;
  /** Reason for the detection (for debugging) */
  reason: string;
  /**
   * Whether an active interactive prompt (y/n, multiple choice) was detected.
   * Issue #235: Uses full output (detectPrompt's internal 50-line window)
   * instead of STATUS_CHECK_LINE_COUNT (15) lines to support long prompts
   * like AskUserQuestion format with option descriptions.
   *
   * Used by callers as the source of truth for isPromptWaiting (SF-004).
   */
  hasActivePrompt: boolean;

  /**
   * Issue #408: Prompt detection result from internal detectPrompt() call.
   * Required field (DR1-001) - callers that need promptData can access it
   * directly without a second detectPrompt() call.
   * Required so that future return path additions are caught by the compiler
   * (defense-in-depth).
   *
   * Contains the full PromptDetectionResult including:
   * - isPrompt: boolean (always matches hasActivePrompt)
   * - promptData?: PromptData (question, options, type etc.)
   * - cleanContent: string
   * - rawContent?: string (truncated, Issue #235)
   *
   * Design guarantee: When status === 'running' && reason === 'thinking_indicator',
   * promptDetection.isPrompt is always false (prompt detection has higher priority
   * than thinking detection in the internal priority order).
   */
  promptDetection: PromptDetectionResult;

  /**
   * Whether {@link status} rests on something positive (Issue #1927, §4 D1 決定 2).
   *
   * `'positive'` — a completion marker, a running indicator, a parsed dialog, a
   * selection list, or a tool-specific idle rule said so. `'none'` — nothing on
   * the frame could be read either way and the status is a fallback.
   *
   * This is the field the whole D1 rework turns on, and it lives HERE rather
   * than beside the consumers because only the detector knows which rule
   * produced the verdict. Before #1927 the reading was reconstructed downstream
   * from `(status, reason)` by `deriveScraperEvidence`, which worked only while
   * "reason X always means evidence Y" held — it stops holding the moment
   * `input_prompt` becomes positive for one tool and not for another, which is
   * exactly what the §4 D1 tool-by-tool rollout does.
   *
   * `current-output-builder` and `worktree-status-helper` publish it as
   * `statusEvidence`, and both derive `isUnclassifiedActive` from
   * `evidence === 'none'`.
   */
  evidence: StatusEvidence;
}

export { STATUS_REASON } from './status-reason';

/**
 * Set of STATUS_REASON values that indicate a selection list is active.
 * Used by current-output/route.ts to determine if NavigationButtons should be shown.
 * Replaces OR-chain approach for extensibility (DR1-004).
 *
 * @see STATUS_REASON
 */
export const SELECTION_LIST_REASONS = new Set<string>([
  STATUS_REASON.OPENCODE_SELECTION_LIST,
  // Issue #1893: opencode's permission dialog is a horizontal button strip that
  // only ←/→ + Enter drive — typing an option number does nothing (measured on
  // 1.18.21), so it is a `menu`, not something `respond <id> N` can answer.
  STATUS_REASON.OPENCODE_PERMISSION_PROMPT,
  STATUS_REASON.CLAUDE_SELECTION_LIST,
  STATUS_REASON.COPILOT_SELECTION_LIST,
  STATUS_REASON.CODEX_SELECTION_LIST,
  // Issue #1017: Codex pager/edit-previous mode also drives NavigationButtons.
  STATUS_REASON.CODEX_PAGER,
  // Issue #1829: the hooks review screens have no numbered options — `t` and
  // `esc` are the only ways out, and NavigationButtons is how a human sends them.
  STATUS_REASON.CODEX_HOOKS_REVIEW,
  STATUS_REASON.ANTIGRAVITY_SELECTION_LIST,
]);

/**
 * The `running` reasons that mean "the agent is producing output right now"
 * (Issue #1912).
 *
 * `current-output-builder` derives `thinking` / `isGenerating` from this, and it
 * was a single `=== THINKING_INDICATOR` comparison until opencode grew a second
 * one: branch A of the opencode block answers `opencode_processing_indicator`
 * for the footer that reads `esc interrupt`, which is opencode's ONLY signal
 * while it is between the submitted prompt and the first transcript row. A
 * scraper-only session (no hooks) therefore showed no thinking indicator in
 * `MessageList` for exactly the stretch where one is wanted.
 *
 * `DEFAULT` is deliberately absent: it is the "output changed recently" fallback
 * and says nothing about the agent having announced itself, so promoting it
 * would light the indicator on any repainting frame.
 *
 * @see STATUS_REASON
 */
export const GENERATING_REASONS = new Set<string>([
  STATUS_REASON.THINKING_INDICATOR,
  STATUS_REASON.OPENCODE_PROCESSING_INDICATOR,
]);

/**
 * Whether a detection result describes an agent that is actively generating.
 *
 * Both halves matter: the reason alone is not enough because a stale frame can
 * carry a `running` reason after the status has degraded to `ready`.
 */
export function isGeneratingStatus(result: {
  status: SessionStatus;
  reason: string;
}): boolean {
  return result.status === 'running' && GENERATING_REASONS.has(result.reason);
}


/**
 * Number of lines from the end to check for prompt and input indicators.
 *
 * Re-exported from `tools/frame.ts`, where Issue #1927 moved the definition so
 * the tool modules and the shared chain read one constant. Kept exported here
 * because it was published from this module first and is imported by name
 * elsewhere.
 */
export { STATUS_CHECK_LINE_COUNT } from './tools/frame';

/**
 * Detect session status with confidence level.
 *
 * Since Issue #1927 this is a facade: it normalises the frame once and hands it
 * to the tool's own {@link ToolStatusDetector}, which runs the priority chain in
 * `tools/run-detection.ts`. The signature, the return shape and every verdict a
 * tool can reach are unchanged by that move; what the split buys is a place to
 * state, per tool, what counts as evidence (§4 D1 / D2).
 *
 * Priority order (see `tools/run-detection.ts` for the full commentary):
 * 1. Tool-specific pre-prompt branches (pickers, pagers, status bars)
 * 2. Interactive prompt (yes/no, multiple choice) -> waiting
 * 3. Thinking indicator (spinner, progress) -> running
 * 4. Tool-specific running / completion markers
 * 5. Input prompt (>, ❯, ›, $, %) -> ready, with per-tool idle evidence
 * 6. No recent output (>5s) -> running, evidence none (Issue #1927; was `ready`)
 * 7. Floor -> running, evidence none (`unknown_frame` / `default`)
 *
 * @param output - Raw tmux output (including ANSI escape codes).
 *                 This function handles ANSI stripping internally.
 * @param cliToolId - CLI tool identifier for pattern selection (CLIToolType).
 * @param lastOutputTimestamp - Optional timestamp (Date) for time-based heuristic.
 * @returns Detection result with status, confidence, reason, hasActivePrompt, evidence and promptDetection
 */
export function detectSessionStatus(
  output: string,
  cliToolId: CLIToolType,
  lastOutputTimestamp?: Date
): StatusDetectionResult {
  const frame = normalizeFrame(output);
  const verdict = getToolStatusDetector(cliToolId).detect(frame, { lastOutputTimestamp });
  return {
    status: verdict.status,
    confidence: verdict.confidence,
    reason: verdict.reason,
    hasActivePrompt: verdict.hasActivePrompt,
    evidence: verdict.evidence,
    // Every chain exit carries one; the fallback keeps the required field
    // total rather than letting a future branch publish `undefined` into a
    // payload that has always had it (Issue #408's defense-in-depth).
    promptDetection: verdict.promptDetection ?? { isPrompt: false, cleanContent: frame.clean },
  };
}
