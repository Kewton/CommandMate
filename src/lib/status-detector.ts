/**
 * Session status detection for CLI tools
 * Issue #54: Improved status detection with confidence levels
 *
 * This module provides more reliable session status detection by:
 * 1. Checking for interactive prompts (yes/no, multiple choice)
 * 2. Checking for thinking/processing indicators
 * 3. Checking for input prompts (ready for user input)
 * 4. Using time-based heuristics when patterns don't match
 */

import { stripAnsi, detectThinking, getCliToolPatterns } from './cli-patterns';
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
   * in the last N lines. Used by callers for stale prompt cleanup logic.
   * Does NOT expose internal PromptDetectionResult details (encapsulation).
   */
  hasActivePrompt: boolean;
}

/**
 * Number of lines from the end to check for status indicators
 * @constant
 */
const STATUS_CHECK_LINE_COUNT: number = 15;

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
  const lastLines = lines.slice(-STATUS_CHECK_LINE_COUNT).join('\n');

  // 1. Interactive prompt detection (highest priority)
  // This includes yes/no prompts, multiple choice, and approval prompts
  const promptDetection = detectPrompt(lastLines);
  if (promptDetection.isPrompt) {
    return {
      status: 'waiting',
      confidence: 'high',
      reason: 'prompt_detected',
      hasActivePrompt: true,
    };
  }

  // 2. Thinking indicator detection
  // CLI tool is actively processing (shows spinner, "Planning...", etc.)
  if (detectThinking(cliToolId, lastLines)) {
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
