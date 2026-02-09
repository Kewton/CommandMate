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
 * Architecture note (SF-001 tradeoff):
 * This module returns StatusDetectionResult which intentionally does NOT include
 * PromptDetectionResult.promptData. Callers that need promptData (e.g.,
 * current-output/route.ts) must call detectPrompt() separately, resulting in
 * detectPrompt() being invoked twice: once inside detectSessionStatus() and once
 * by the caller. This controlled DRY violation is accepted because:
 *   - StatusDetectionResult maintains SRP (status + confidence, not prompt details)
 *   - Exposing promptData would couple status detection to prompt data shape changes
 *   - detectPrompt() is lightweight (regex-based, no I/O), so the cost is negligible
 */

import { stripAnsi, detectThinking, getCliToolPatterns, buildDetectPromptOptions } from './cli-patterns';
import { detectPrompt } from './prompt-detector';
import type { CLIToolType } from './cli-tools/types';

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
   * Whether an active interactive prompt (y/n, multiple choice) was detected
   * in the last STATUS_CHECK_LINE_COUNT (15) lines.
   *
   * Used by callers as the source of truth for isPromptWaiting (SF-004).
   * Does NOT expose internal PromptDetectionResult details (encapsulation).
   * Callers needing promptData must call detectPrompt() separately (SF-001).
   */
  hasActivePrompt: boolean;
}

/**
 * Number of lines from the end to check for prompt and input indicators
 * @constant
 */
const STATUS_CHECK_LINE_COUNT: number = 15;

/**
 * Number of lines from the end to check for thinking indicators.
 * Thinking indicators (spinner + activity text) only appear in the most recent lines.
 * A small window prevents completed thinking summaries (e.g., "Churned for 41s")
 * in scrollback from being falsely detected as active thinking (Issue #188 root cause).
 *
 * SF-002 naming rationale: Named STATUS_THINKING_LINE_COUNT (not THINKING_CHECK_LINE_COUNT)
 * to avoid naming collision with auto-yes-manager.ts. Three related constants exist:
 *
 * | Constant                          | Value | Module              | Purpose                          |
 * |-----------------------------------|-------|---------------------|----------------------------------|
 * | STATUS_THINKING_LINE_COUNT        |   5   | status-detector.ts  | UI status display (accuracy)     |
 * | RESPONSE_THINKING_TAIL_LINE_COUNT |   5   | response-poller.ts  | Response extraction tail check   |
 * | THINKING_CHECK_LINE_COUNT         |  50   | auto-yes-manager.ts | Auto-Yes safety (wider window)   |
 *
 * The UI constants (5) use a narrow window for precision. The Auto-Yes constant (50)
 * uses a wider window that matches detectMultipleChoicePrompt's scan range, prioritizing
 * safety over precision (Issue #191).
 *
 * @constant
 */
const STATUS_THINKING_LINE_COUNT: number = 5;

/**
 * Time threshold (in ms) for considering output as "stale"
 * If no new output for this duration, assume processing is complete
 * @constant
 */
const STALE_OUTPUT_THRESHOLD_MS: number = 5000;

/**
 * Detect session status with confidence level
 *
 * Priority order:
 * 1. Interactive prompt (yes/no, multiple choice) -> waiting
 * 2. Thinking indicator (spinner, progress) -> running
 * 3. Input prompt (>, ❯, ›, $, %) -> ready
 * 4. No recent output (>5s) -> ready (low confidence)
 * 5. Default -> running (low confidence)
 *
 * @param output - Raw tmux output (including ANSI escape codes).
 *                 This function handles ANSI stripping internally.
 * @param cliToolId - CLI tool identifier for pattern selection (CLIToolType: 'claude' | 'codex' | 'gemini').
 * @param lastOutputTimestamp - Optional timestamp (Date) for time-based heuristic.
 * @returns Detection result with status, confidence, reason, and hasActivePrompt
 */
export function detectSessionStatus(
  output: string,
  cliToolId: CLIToolType,
  lastOutputTimestamp?: Date
): StatusDetectionResult {
  // Strip ANSI codes and get last N lines for analysis
  const cleanOutput = stripAnsi(output);
  const lines = cleanOutput.split('\n');
  // Strip trailing empty lines (tmux terminal padding) before windowing.
  // tmux buffers often end with many empty padding lines that would otherwise
  // fill the entire detection window, hiding the actual prompt/status content.
  let lastNonEmptyIndex = lines.length - 1;
  while (lastNonEmptyIndex >= 0 && lines[lastNonEmptyIndex].trim() === '') {
    lastNonEmptyIndex--;
  }
  const contentLines = lines.slice(0, lastNonEmptyIndex + 1);
  const lastLines = contentLines.slice(-STATUS_CHECK_LINE_COUNT).join('\n');
  // DR-003: Separate thinking detection window (5 lines) from prompt detection window (15 lines)
  const thinkingLines = contentLines.slice(-STATUS_THINKING_LINE_COUNT).join('\n');

  // 1. Interactive prompt detection (highest priority)
  // This includes yes/no prompts, multiple choice, and approval prompts
  const promptOptions = buildDetectPromptOptions(cliToolId);
  const promptDetection = detectPrompt(lastLines, promptOptions);
  if (promptDetection.isPrompt) {
    return {
      status: 'waiting',
      confidence: 'high',
      reason: 'prompt_detected',
      hasActivePrompt: true,
    };
  }

  // 2. Thinking indicator detection - STATUS_THINKING_LINE_COUNT window (narrower)
  // CLI tool is actively processing (shows spinner, "Planning...", etc.)
  if (detectThinking(cliToolId, thinkingLines)) {
    return {
      status: 'running',
      confidence: 'high',
      reason: 'thinking_indicator',
      hasActivePrompt: false,
    };
  }

  // 3. Input prompt detection
  // CLI tool is waiting for user input (shows >, ❯, ›, $, %, etc.)
  const { promptPattern } = getCliToolPatterns(cliToolId);
  if (promptPattern.test(lastLines)) {
    return {
      status: 'ready',
      confidence: 'high',
      reason: 'input_prompt',
      hasActivePrompt: false,
    };
  }

  // 4. Time-based heuristic
  // If no new output for >5 seconds, assume processing is complete
  if (lastOutputTimestamp) {
    const elapsed = Date.now() - lastOutputTimestamp.getTime();
    if (elapsed > STALE_OUTPUT_THRESHOLD_MS) {
      return {
        status: 'ready',
        confidence: 'low',
        reason: 'no_recent_output',
        hasActivePrompt: false,
      };
    }
  }

  // 5. Default: assume running with low confidence
  // This is a safe default when we cannot determine the state
  return {
    status: 'running',
    confidence: 'low',
    reason: 'default',
    hasActivePrompt: false,
  };
}
