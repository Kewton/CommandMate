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

import { stripAnsi, stripBoxDrawing, detectThinking, getCliToolPatterns, buildDetectPromptOptions, OPENCODE_RESPONSE_COMPLETE, OPENCODE_PROCESSING_INDICATOR, OPENCODE_SELECTION_LIST_PATTERN, CLAUDE_SELECTION_LIST_FOOTER, COPILOT_SELECTION_LIST_PATTERN, CODEX_PROMPT_PATTERN, CODEX_SELECTION_LIST_PATTERN } from './cli-patterns';
import { detectPrompt } from './prompt-detector';
import type { PromptDetectionResult } from './prompt-detector';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { THINKING_TAIL_LINE_COUNT } from '@/config/thinking-constants';

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
}

/**
 * Number of lines from the end to check for prompt and input indicators
 * @constant
 */
const STATUS_CHECK_LINE_COUNT: number = 15;

// THINKING_TAIL_LINE_COUNT imported from @/config/thinking-constants (Issue #575)
// Previously THINKING_TAIL_LINE_COUNT = 5 (local constant)
// See also: THINKING_CHECK_LINE_COUNT (50) in auto-yes-manager.ts (wider window for safety)

/**
 * Reason string constants for StatusDetectionResult.reason.
 * Shared between status-detector.ts and current-output/route.ts to prevent typos (DR2-003).
 */
export const STATUS_REASON = {
  PROMPT_DETECTED: 'prompt_detected',
  THINKING_INDICATOR: 'thinking_indicator',
  OPENCODE_PROCESSING_INDICATOR: 'opencode_processing_indicator',
  OPENCODE_SELECTION_LIST: 'opencode_selection_list',
  CLAUDE_SELECTION_LIST: 'claude_selection_list',
  COPILOT_SELECTION_LIST: 'copilot_selection_list',
  CODEX_SELECTION_LIST: 'codex_selection_list',
  OPENCODE_RESPONSE_COMPLETE: 'opencode_response_complete',
  INPUT_PROMPT: 'input_prompt',
  NO_RECENT_OUTPUT: 'no_recent_output',
  DEFAULT: 'default',
} as const;

/**
 * Set of STATUS_REASON values that indicate a selection list is active.
 * Used by current-output/route.ts to determine if NavigationButtons should be shown.
 * Replaces OR-chain approach for extensibility (DR1-004).
 *
 * @see STATUS_REASON
 */
export const SELECTION_LIST_REASONS = new Set<string>([
  STATUS_REASON.OPENCODE_SELECTION_LIST,
  STATUS_REASON.CLAUDE_SELECTION_LIST,
  STATUS_REASON.COPILOT_SELECTION_LIST,
  STATUS_REASON.CODEX_SELECTION_LIST,
]);

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
 * @param cliToolId - CLI tool identifier for pattern selection (CLIToolType).
 * @param lastOutputTimestamp - Optional timestamp (Date) for time-based heuristic.
 * @returns Detection result with status, confidence, reason, hasActivePrompt, and promptDetection
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
  const thinkingLines = contentLines.slice(-THINKING_TAIL_LINE_COUNT).join('\n');

  // 0. Copilot: selection list detection BEFORE thinking detection
  // COPILOT_THINKING_PATTERN includes "Reasoning\s+[■▪▮]" which matches the
  // "Reasoning ■■■ medium" UI element shown in /model selection lists.
  // Without this early check, the selection list would be misdetected as thinking.
  // However, yes/no prompts also contain "to navigate · Enter to select" footer,
  // so we must check detectPrompt first — if a prompt is detected, it takes priority
  // over selection list (prompts show PromptPanel with Yes/No buttons).
  const copilotSelectionWindow = contentLines.slice(-30).join('\n');
  if (cliToolId === 'copilot' && COPILOT_SELECTION_LIST_PATTERN.test(copilotSelectionWindow)) {
    const promptOptions = buildDetectPromptOptions(cliToolId);
    const promptDetection = detectPrompt(stripBoxDrawing(cleanOutput), promptOptions);
    if (promptDetection.isPrompt) {
      // Distinguish yes/no prompts (2-3 options, e.g., "Do you want to run this command?")
      // from ask_user multi-select prompts (4+ options). Yes/no prompts should show
      // PromptPanel with buttons; ask_user prompts need NavigationButtons for ↑↓ selection.
      const optionsCount = promptDetection.promptData?.options?.length ?? 0;
      if (optionsCount <= 3) {
        return {
          status: 'waiting',
          confidence: 'high',
          reason: 'prompt_detected',
          hasActivePrompt: true,
          promptDetection,
        };
      }
      // 4+ options: treat as selection list (NavigationButtons)
    }
    return {
      status: 'waiting',
      confidence: 'high',
      reason: STATUS_REASON.COPILOT_SELECTION_LIST,
      hasActivePrompt: false,
      promptDetection,
    };
  }

  // 0.5. Copilot: thinking detection BEFORE prompt detection (Issue #547)
  // Copilot CLI keeps the "❯" prompt visible even during processing,
  // so prompt detection would always match first. Check thinking first for copilot.
  // Uses last 15 lines (not 5) because copilot shows action log lines above prompt.
  const copilotThinkingWindow = contentLines.slice(-STATUS_CHECK_LINE_COUNT).join('\n');
  if (cliToolId === 'copilot' && detectThinking(cliToolId, copilotThinkingWindow)) {
    const promptOptions = buildDetectPromptOptions(cliToolId);
    const promptDetection = detectPrompt(stripBoxDrawing(cleanOutput), promptOptions);
    return {
      status: 'running',
      confidence: 'high',
      reason: 'thinking_indicator',
      hasActivePrompt: false,
      promptDetection,
    };
  }

  // 1. Interactive prompt detection (highest priority)
  // This includes yes/no prompts, multiple choice, and approval prompts
  const promptOptions = buildDetectPromptOptions(cliToolId);
  // Apply stripBoxDrawing() for Gemini CLI and OpenCode TUI compatibility:
  // Gemini wraps prompts in box-drawing characters (╭╮╰╯│─) which prevent
  // detectPrompt() from recognizing the prompt content.
  // OpenCode TUI uses ┃ borders and █ scrollbar that need stripping.
  // For OpenCode, Codex, and Claude, use full cleanOutput instead of lastLines
  // (15-line window) because their multiple-choice prompts with descriptions
  // can exceed 15 lines. Examples: Codex approval prompts with long file lists,
  // Claude "Yes, and don't ask again for: git commit -m ..." options that embed
  // full commit messages. detectPrompt() applies its own 50-line window internally.
  const promptInput = (cliToolId === 'opencode' || cliToolId === 'codex' || cliToolId === 'claude' || cliToolId === 'copilot')
    ? stripBoxDrawing(cleanOutput)
    : stripBoxDrawing(lastLines);
  const promptDetection = detectPrompt(promptInput, promptOptions);
  if (promptDetection.isPrompt) {
    return {
      status: 'waiting',
      confidence: 'high',
      reason: 'prompt_detected',
      hasActivePrompt: true,
      promptDetection,
    };
  }

  // 1.5. Claude CLI selection list detection
  // Claude CLI's multi-select/checkbox prompts (e.g., AskUserQuestion with checkboxes)
  // use arrow keys + Enter to navigate and toggle, not number input.
  // The 15-line window may miss the question line, causing SEC-001a rejection above.
  // Detect via the footer instruction pattern and show NavigationButtons instead of PromptPanel.
  if (cliToolId === 'claude' && CLAUDE_SELECTION_LIST_FOOTER.test(lastLines)) {
    return {
      status: 'waiting',
      confidence: 'high',
      reason: STATUS_REASON.CLAUDE_SELECTION_LIST,
      hasActivePrompt: false,
      promptDetection,
    };
  }

  // 1.6. Copilot CLI selection list detection — moved to priority 0 (above thinking)
  // See comment at priority 0 for rationale.

  // 2. Thinking indicator detection - THINKING_TAIL_LINE_COUNT window (narrower)
  // CLI tool is actively processing (shows spinner, "Planning...", etc.)
  if (detectThinking(cliToolId, thinkingLines)) {
    return {
      status: 'running',
      confidence: 'high',
      reason: 'thinking_indicator',
      hasActivePrompt: false,
      promptDetection,
    };
  }

  // 2.5. OpenCode status detection (Issue #379)
  // OpenCode TUI layout: content area (top) | empty padding (~150 lines) | footer status bar (~6 lines at bottom).
  // Standard windowed checks (last N lines) only see footer/padding, never the content area.
  //
  // Detection strategy:
  // A. "esc interrupt" in footer → actively processing (running)
  // B. Find footer boundary via "ctrl+t" keybinding line, extract content above it, check for thinking → running
  // C. Same content window, check for ▣ Build completion → ready
  if (cliToolId === 'opencode') {
    // A. Check footer for processing indicator ("esc interrupt" replaces "ctrl+t variants..." during processing)
    if (OPENCODE_PROCESSING_INDICATOR.test(lastLines)) {
      return {
        status: 'running',
        confidence: 'high',
        reason: 'opencode_processing_indicator',
        hasActivePrompt: false,
        promptDetection,
      };
    }

    // Extract content area by finding TUI footer boundary dynamically.
    // Footer structure (bottom-up): keybinding hints ("ctrl+t variants..."),
    // ╹▀▀ separator, model info bar ("Build GPT-5-mini GitHub Copilot"), ┃ padding.
    // The keybinding line is the anchor; model bar is 2 lines above it.
    // ┃ padding above the model bar becomes empty after stripBoxDrawing and is
    // skipped by the lastNonEmpty search below.
    const strippedForOpenCode = stripBoxDrawing(cleanOutput);
    const ocLines = strippedForOpenCode.split('\n');
    let footerBoundary = Math.max(0, ocLines.length - 7); // fallback: skip 7 lines
    for (let i = ocLines.length - 1; i >= Math.max(0, ocLines.length - 10); i--) {
      if (/ctrl\+[tp]/.test(ocLines[i])) {
        // Exclude keybinding line (i), separator (i-1), and model info bar (i-2)
        footerBoundary = Math.max(0, i - 2);
        break;
      }
    }
    const contentCandidates = ocLines.slice(0, footerBoundary);
    let lastContentIdx = contentCandidates.length - 1;
    while (lastContentIdx >= 0 && contentCandidates[lastContentIdx].trim() === '') {
      lastContentIdx--;
    }
    if (lastContentIdx >= 0) {
      // B. Check last few content lines for thinking indicators
      const contentThinkingWindow = contentCandidates
        .slice(Math.max(0, lastContentIdx - THINKING_TAIL_LINE_COUNT + 1), lastContentIdx + 1)
        .join('\n');
      if (detectThinking('opencode', contentThinkingWindow)) {
        return {
          status: 'running',
          confidence: 'high',
          reason: 'thinking_indicator',
          hasActivePrompt: false,
          promptDetection,
        };
      }

      // C. Check content area for selection list (Issue #473: fuzzy-search list detection)
      // Selection list header ("Select model"/"Select provider") may be far above the
      // last content line when many items are listed, so check all content candidates.
      const contentCheckWindow = contentCandidates
        .slice(Math.max(0, lastContentIdx - STATUS_CHECK_LINE_COUNT + 1), lastContentIdx + 1)
        .join('\n');
      const fullContentText = contentCandidates.join('\n');
      if (OPENCODE_SELECTION_LIST_PATTERN.test(fullContentText)) {
        return {
          status: 'waiting',
          confidence: 'high',
          reason: STATUS_REASON.OPENCODE_SELECTION_LIST,
          hasActivePrompt: false,
          promptDetection,
        };
      }

      // D. Check last few content lines for completion marker (▣ Build · model · time)
      if (OPENCODE_RESPONSE_COMPLETE.test(contentCheckWindow)) {
        return {
          status: 'ready',
          confidence: 'high',
          reason: STATUS_REASON.OPENCODE_RESPONSE_COMPLETE,
          hasActivePrompt: false,
          promptDetection,
        };
      }

      // E. Check content area for prompt pattern (Issue #473: "Ask anything..." is in content area,
      // not in lastLines, due to OpenCode TUI padding between content and footer)
      const { promptPattern: ocPromptPattern } = getCliToolPatterns('opencode');
      if (ocPromptPattern.test(contentCheckWindow)) {
        return {
          status: 'ready',
          confidence: 'high',
          reason: STATUS_REASON.PROMPT_DETECTED,
          hasActivePrompt: true,
          promptDetection,
        };
      }
    }
  }

  // 2.7. Codex TUI content area detection (thinking + idle prompt)
  // Codex TUI layout: conversation area (top) | empty padding (~30 lines) | input area + status bar (bottom).
  // Standard windowed checks (last 5/15 lines) only see padding/status bar, missing both:
  // A. Thinking indicators (• Ran, • Planning) in the conversation area → should show spinner
  // B. Idle prompt (›) at the end of the conversation area → should show ready
  // Strategy: find the Codex status bar, extract content above it, then check for thinking/idle.
  if (cliToolId === 'codex') {
    const codexStatusBarPattern = /^\s*\S+.*\d+%\s+left\s+·/;
    let codexFooterBoundary = -1;
    for (let ci = contentLines.length - 1; ci >= Math.max(0, contentLines.length - 10); ci--) {
      if (codexStatusBarPattern.test(contentLines[ci])) {
        codexFooterBoundary = ci;
        break;
      }
    }
    if (codexFooterBoundary >= 0) {
      // Find last non-empty content line above footer (skip padding + input area)
      let lastContentIdx = codexFooterBoundary - 1;
      while (lastContentIdx >= 0 && contentLines[lastContentIdx].trim() === '') {
        lastContentIdx--;
      }
      if (lastContentIdx >= 0) {
        // A. Check content area for thinking indicators (wider window than step 2)
        const codexThinkingWindow = contentLines
          .slice(Math.max(0, lastContentIdx - THINKING_TAIL_LINE_COUNT + 1), lastContentIdx + 1)
          .join('\n');
        if (detectThinking('codex', codexThinkingWindow)) {
          return {
            status: 'running',
            confidence: 'high',
            reason: 'thinking_indicator',
            hasActivePrompt: false,
            promptDetection,
          };
        }

        // A2. Check content area for selection list (Issue #619: Codex /model selection list)
        // Codex /model Step 1 shows arrow-key selection list with
        // "press enter to confirm or esc to cancel" footer.
        // Must be checked AFTER thinking (A) but BEFORE idle prompt (B).
        // "press number to confirm" (Step 2) is NOT matched — that's handled
        // by detectMultipleChoicePrompt at priority 1.
        const codexFullContentText = contentLines
          .slice(0, lastContentIdx + 1)
          .join('\n');
        if (CODEX_SELECTION_LIST_PATTERN.test(codexFullContentText)) {
          return {
            status: 'waiting',
            confidence: 'high',
            reason: STATUS_REASON.CODEX_SELECTION_LIST,
            hasActivePrompt: false,
            promptDetection,
          };
        }

        // B. Check if the last content line is the idle › prompt.
        // The last non-empty line above the status bar is the current active line.
        // When Codex is idle, this is the › prompt (with optional suggestion text).
        // When processing, this is command output (not ›), so the check naturally fails.
        const lastContentLine = contentLines[lastContentIdx].trim();
        if (CODEX_PROMPT_PATTERN.test(lastContentLine)) {
          return {
            status: 'ready',
            confidence: 'high',
            reason: 'input_prompt',
            hasActivePrompt: false,
            promptDetection,
          };
        }

        // C. Fallback: status bar present but neither thinking nor idle › detected.
        // This means Codex is actively processing — command output has pushed the
        // • Ran/• Working indicators beyond the 5-line thinking window.
        // The status bar ("model · N% left · path") is always visible during Codex
        // sessions, and the only idle state (›) was checked in B above.
        return {
          status: 'running',
          confidence: 'high',
          reason: 'thinking_indicator',
          hasActivePrompt: false,
          promptDetection,
        };
      }
    }
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
      promptDetection,
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
        promptDetection,
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
    promptDetection,
  };
}
