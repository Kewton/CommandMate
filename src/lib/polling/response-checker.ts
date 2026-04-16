/** Response checking and extraction logic for CLI tool polling (Issue #575 split from response-poller.ts). */

import { captureSessionOutput, isSessionRunning } from '@/lib/session/cli-session';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  createMessage,
  getSessionState,
  updateSessionState,
  getWorktreeById,
  clearInProgressMessageId,
  markPendingPromptsAsAnswered,
} from '@/lib/db';
import { broadcastMessage } from '@/lib/ws-server';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import type { PromptDetectionResult } from '@/lib/detection/prompt-detector';
import { recordClaudeConversation } from '@/lib/conversation-logger';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { parseClaudeOutput } from '@/lib/claude-output';
import {
  getCliToolPatterns,
  stripAnsi,
  stripBoxDrawing,
  buildDetectPromptOptions,
  OPENCODE_PROMPT_PATTERN,
  OPENCODE_PROMPT_AFTER_RESPONSE,
  OPENCODE_RESPONSE_COMPLETE,
  OPENCODE_SKIP_PATTERNS,
} from '@/lib/detection/cli-patterns';
import { createLogger } from '@/lib/logger';
import { THINKING_TAIL_LINE_COUNT } from '@/config/thinking-constants';

const logger = createLogger('response-poller');

// Sub-module imports
import { resolveExtractionStartIndex, isOpenCodeComplete } from '../response-extractor';
import { cleanClaudeResponse, cleanGeminiResponse, cleanOpenCodeResponse, cleanCopilotResponse, truncateMessage } from '../response-cleaner';
import { COPILOT_MAX_MESSAGE_LENGTH, COPILOT_TRUNCATION_MARKER } from '@/config/copilot-constants';
import {
  accumulateTuiContent,
  getAccumulatedContent,
  clearTuiAccumulator,
} from '../tui-accumulator';
import { isDuplicatePrompt, normalizePromptForDedup } from './prompt-dedup';
import { getPollerKey, stopPolling, GEMINI_LOADING_INDICATORS } from './response-poller-core';

// ============================================================================
// Extraction types and helpers
// ============================================================================

/**
 * Return type for extractResponse(), representing partial or complete response extraction.
 */
export interface ExtractionResult {
  response: string;
  isComplete: boolean;
  lineCount: number;
  /** Prompt detection result carried from extractResponse early check (Issue #372) */
  promptDetection?: PromptDetectionResult;
  /** True when tmux buffer shrank (TUI redraw, screen clear, session restart) */
  bufferReset?: boolean;
}

/**
 * Creates an incomplete extraction result with empty response.
 * Centralizes the repeated pattern of returning an in-progress/incomplete state.
 *
 * @param lineCount - Current line count for state tracking
 * @returns ExtractionResult with empty response and isComplete: false
 */
export function incompleteResult(lineCount: number): ExtractionResult {
  return { response: '', isComplete: false, lineCount };
}

/**
 * Build a complete ExtractionResult for a detected prompt.
 *
 * Shared between Claude early prompt detection (section 3-4, site 1) and
 * fallback prompt detection (section 3-4, site 2) in extractResponse().
 * Applies resolveExtractionStartIndex() to limit extraction to lastCapturedLine
 * onwards, then strips ANSI codes for safe DB storage (Stage 4 MF-001).
 *
 * @param lines - The trimmed tmux buffer lines array
 * @param lastCapturedLine - Number of lines previously captured
 * @param totalLines - Total line count in the buffer
 * @param bufferReset - External buffer reset flag
 * @param cliToolId - CLI tool identifier
 * @param findRecentUserPromptIndex - Callback to locate the most recent user prompt
 * @returns ExtractionResult with isComplete: true and ANSI-stripped response
 */
export function buildPromptExtractionResult(
  lines: string[],
  lastCapturedLine: number,
  totalLines: number,
  bufferReset: boolean,
  cliToolId: CLIToolType,
  findRecentUserPromptIndex: (windowSize: number) => number,
  promptDetection?: PromptDetectionResult,
): ExtractionResult {
  const startIndex = resolveExtractionStartIndex(
    lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex
  );
  const extractedLines = lines.slice(startIndex);
  return {
    response: stripAnsi(extractedLines.join('\n')),
    isComplete: true,
    lineCount: totalLines,
    promptDetection,
    bufferReset,
  };
}

/**
 * Internal helper: detect prompt with CLI-tool-specific options.
 *
 * Centralizes the stripAnsi() + buildDetectPromptOptions() + detectPrompt() pipeline
 * to avoid repeating this 3-step sequence across extractResponse() and checkForResponse().
 *
 * @param output - Raw or pre-stripped tmux output
 * @param cliToolId - CLI tool identifier for building detection options
 * @returns PromptDetectionResult with isPrompt, promptData, and cleanContent
 */
export function detectPromptWithOptions(
  output: string,
  cliToolId: CLIToolType
): PromptDetectionResult {
  const promptOptions = buildDetectPromptOptions(cliToolId);
  return detectPrompt(stripBoxDrawing(stripAnsi(output)), promptOptions);
}

// ============================================================================
// extractResponse (internal)
// ============================================================================

/**
 * Extract CLI tool response from tmux output
 * Detects when a CLI tool has completed a response by looking for tool-specific patterns
 *
 * @param output - Full tmux output
 * @param lastCapturedLine - Number of lines previously captured
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 * @returns Extracted response or null if incomplete
 */
export function extractResponse(
  output: string,
  lastCapturedLine: number,
  cliToolId: CLIToolType
): ExtractionResult | null {
  // Trim trailing empty lines from the output before processing
  const rawLines = output.split('\n');
  let trimmedLength = rawLines.length;
  while (trimmedLength > 0 && rawLines[trimmedLength - 1].trim() === '') {
    trimmedLength--;
  }
  const lines = rawLines.slice(0, trimmedLength);
  const totalLines = lines.length;

  const BUFFER_RESET_TOLERANCE = 25;
  const bufferShrank = totalLines > 0 && lastCapturedLine > BUFFER_RESET_TOLERANCE && (totalLines + BUFFER_RESET_TOLERANCE) < lastCapturedLine;
  const sessionRestarted = totalLines > 0 && lastCapturedLine > 50 && totalLines < 50;
  const bufferReset = bufferShrank || sessionRestarted;

  // No new output
  if (!bufferReset && totalLines < lastCapturedLine - 5) {
    return null;
  }

  // Check recent lines for completion pattern.
  const checkLineCount = 20;
  const startLine = Math.max(0, totalLines - checkLineCount);
  const linesToCheck = lines.slice(startLine);
  const outputToCheck = cliToolId === 'opencode'
    ? stripAnsi(lines.join('\n'))
    : linesToCheck.join('\n');

  // Get tool-specific patterns from shared module
  const { promptPattern, separatorPattern, thinkingPattern, skipPatterns } = getCliToolPatterns(cliToolId);

  const findRecentUserPromptIndex = (windowSize: number = 60): number => {
    let userPromptPattern: RegExp;
    if (cliToolId === 'codex') {
      userPromptPattern = /^›\s+(?!Implement|Find and fix|Type|Summarize)/;
    } else if (cliToolId === 'opencode') {
      let buildCount = 0;
      for (let i = totalLines - 1; i >= Math.max(0, totalLines - windowSize); i--) {
        const cleanLine = stripAnsi(lines[i]);
        if (OPENCODE_RESPONSE_COMPLETE.test(cleanLine)) {
          buildCount++;
          if (buildCount === 2) {
            return i;
          }
        }
      }
      return -1;
    } else {
      userPromptPattern = /^[>❯]\s+\S/;
    }

    for (let i = totalLines - 1; i >= Math.max(0, totalLines - windowSize); i--) {
      const cleanLine = stripAnsi(lines[i]);
      if (userPromptPattern.test(cleanLine)) {
        return i;
      }
    }

    return -1;
  };

  // Early check for interactive prompts (before extraction logic)
  if (cliToolId === 'claude' || cliToolId === 'codex' || cliToolId === 'copilot') {
    const fullOutput = lines.join('\n');
    const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);

    if (promptDetection.isPrompt) {
      return buildPromptExtractionResult(
        lines, lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex,
        promptDetection,
      );
    }
  }

  // Strip ANSI codes before pattern matching
  const cleanOutputToCheck = stripAnsi(outputToCheck);

  const hasPrompt = promptPattern.test(cleanOutputToCheck);
  const hasSeparator = separatorPattern.test(cleanOutputToCheck);
  const isThinking = thinkingPattern.test(cleanOutputToCheck);

  // Prompt-based completion logic
  const isPromptBasedComplete = (cliToolId === 'codex' || cliToolId === 'gemini' || cliToolId === 'vibe-local' || cliToolId === 'copilot') && hasPrompt && !isThinking;
  const isClaudeComplete = cliToolId === 'claude' && hasPrompt && hasSeparator && !isThinking;
  const isOpenCodeDone = cliToolId === 'opencode' && isOpenCodeComplete(cleanOutputToCheck);

  if (isPromptBasedComplete || isClaudeComplete || isOpenCodeDone) {
    const responseLines: string[] = [];

    const startIndex = resolveExtractionStartIndex(
      lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex
    );

    let endIndex = totalLines;

    for (let i = startIndex; i < totalLines; i++) {
      const line = lines[i];
      const cleanLine = stripAnsi(line);

      if (cliToolId === 'codex' && /^›\s+/.test(cleanLine)) {
        endIndex = i;
        break;
      }

      if (cliToolId === 'gemini' && /^(%|\$|.*@.*[%$#])\s*$/.test(cleanLine)) {
        endIndex = i;
        break;
      }

      if (cliToolId === 'opencode') {
        if (OPENCODE_PROMPT_PATTERN.test(cleanLine) || OPENCODE_PROMPT_AFTER_RESPONSE.test(cleanLine)) {
          endIndex = i;
          break;
        }
      }

      const shouldSkip = skipPatterns.some(pattern => pattern.test(cleanLine));
      if (shouldSkip) {
        continue;
      }

      responseLines.push(line);
    }

    const response = responseLines.join('\n').trim();

    // DR-004: Check only the tail of the response for thinking indicators.
    const responseTailLines = response.split('\n').slice(-THINKING_TAIL_LINE_COUNT).join('\n');
    if (thinkingPattern.test(responseTailLines)) {
      return incompleteResult(totalLines);
    }

    // CRITICAL FIX: Detect and skip Claude Code startup banner/screen
    if (cliToolId === 'claude') {
      const cleanResponse = stripAnsi(response);

      const hasBannerArt = /[╭╮╰╯│]/.test(cleanResponse) || /░{3,}/.test(cleanResponse) || /▓{3,}/.test(cleanResponse);
      const hasVersionInfo = /Claude Code|claude\/|v\d+\.\d+/.test(cleanResponse);
      const hasStartupTips = /Tip:|for shortcuts|\?\s*for help/.test(cleanResponse);
      const hasProjectInit = /^\s*\/Users\/.*$/m.test(cleanResponse) && cleanResponse.split('\n').length < 30;

      const userPromptMatch = cleanResponse.match(/^[>❯]\s+(\S.*)$/m);

      if (userPromptMatch) {
        const userPromptIndex = cleanResponse.indexOf(userPromptMatch[0]);
        const contentAfterPrompt = cleanResponse.substring(userPromptIndex + userPromptMatch[0].length).trim();

        const contentLines = contentAfterPrompt.split('\n').filter(line => {
          const trimmed = line.trim();
          return trimmed &&
                 !skipPatterns.some(p => p.test(trimmed)) &&
                 !/^─+$/.test(trimmed);
        });

        if (contentLines.length === 0) {
          return incompleteResult(totalLines);
        }
      } else if ((hasBannerArt || hasVersionInfo || hasStartupTips || hasProjectInit) && response.length < 2000) {
        return incompleteResult(totalLines);
      }
    }

    // Gemini-specific check
    if (cliToolId === 'gemini') {
      const bannerCharCount = (response.match(/[░███]/g) || []).length;
      const totalChars = response.length;
      if (bannerCharCount > totalChars * 0.3) {
        return incompleteResult(totalLines);
      }

      if (GEMINI_LOADING_INDICATORS.some(indicator => response.includes(indicator))) {
        return incompleteResult(totalLines);
      }

      if (!response.includes('\u2726') && response.length < 10) {
        return incompleteResult(totalLines);
      }
    }

    // OpenCode banner defense
    if (cliToolId === 'opencode') {
      const cleanResponse = stripAnsi(response);
      if (cleanResponse.length < 50 || !OPENCODE_RESPONSE_COMPLETE.test(cleanOutputToCheck)) {
        const contentLines = cleanResponse.split('\n').filter(line => {
          const trimmed = line.trim();
          return trimmed && !OPENCODE_SKIP_PATTERNS.some(p => p.test(trimmed));
        });
        if (contentLines.length === 0) {
          return incompleteResult(totalLines);
        }
      }
    }

    return {
      response,
      isComplete: true,
      lineCount: endIndex,
      bufferReset,
    };
  }

  // Check if this is an interactive prompt
  if (cliToolId !== 'opencode') {
    const fullOutput = lines.join('\n');
    const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);

    if (promptDetection.isPrompt) {
      return buildPromptExtractionResult(
        lines, lastCapturedLine, totalLines, bufferReset, cliToolId, findRecentUserPromptIndex,
        promptDetection,
      );
    }
  }

  // Partial response in progress
  const responseLines: string[] = [];
  const endIndex = totalLines;
  const partialBufferReset = bufferReset || lastCapturedLine >= endIndex - 5;
  const recentPromptIndex = partialBufferReset ? findRecentUserPromptIndex(80) : -1;
  const startIndex = partialBufferReset
    ? (recentPromptIndex >= 0 ? recentPromptIndex + 1 : Math.max(0, endIndex - 80))
    : Math.max(0, lastCapturedLine);

  for (let i = startIndex; i < endIndex; i++) {
    const line = lines[i];
    const cleanLine = stripAnsi(line);

    const shouldSkip = skipPatterns.some(pattern => pattern.test(cleanLine));
    if (shouldSkip) {
      continue;
    }

    responseLines.push(line);
  }

  const partialResponse = responseLines.join('\n').trim();
  if (partialResponse) {
    return {
      response: partialResponse,
      isComplete: false,
      lineCount: endIndex,
    };
  }

  // Response not yet complete
  return incompleteResult(totalLines);
}

// ============================================================================
// checkForResponse (exported for response-poller-core.ts)
// ============================================================================

/**
 * Check for CLI tool response once
 *
 * @param worktreeId - Worktree ID
 * @returns True if response was found and processed
 */
export async function checkForResponse(worktreeId: string, cliToolId: CLIToolType): Promise<boolean> {
  const db = getDbInstance();

  try {
    // Get worktree to verify it exists
    const worktree = getWorktreeById(db, worktreeId);
    if (!worktree) {
      logger.error('worktree-worktreeid-not');
      stopPolling(worktreeId, cliToolId);
      return false;
    }

    // Check if CLI tool session is running
    const running = await isSessionRunning(worktreeId, cliToolId);
    if (!running) {
      logger.info('session-not-running');
      stopPolling(worktreeId, cliToolId);
      return false;
    }

    // Get session state (last captured line count)
    const sessionState = getSessionState(db, worktreeId, cliToolId);
    const lastCapturedLine = sessionState?.lastCapturedLine || 0;

    // Capture current output
    const output = await captureSessionOutput(worktreeId, cliToolId, 10000);

    // Layer 2: Accumulate TUI content for full-screen TUI tools (for overlap tracking only).
    if (cliToolId === 'opencode' || cliToolId === 'copilot') {
      const pollerKey = getPollerKey(worktreeId, cliToolId);
      accumulateTuiContent(pollerKey, output, cliToolId);
    }

    // Extract response
    const result = extractResponse(output, lastCapturedLine, cliToolId);

    if (!result || !result.isComplete) {
      // DR-004 windowing: Only check tail lines
      const { thinkingPattern } = getCliToolPatterns(cliToolId);
      const cleanOutput = stripAnsi(output);
      const tailLines = cleanOutput.split('\n').slice(-THINKING_TAIL_LINE_COUNT).join('\n');
      if (thinkingPattern.test(tailLines)) {
        const answeredCount = markPendingPromptsAsAnswered(db, worktreeId, cliToolId);
        if (answeredCount > 0) {
          logger.info('marked-answeredcount-pending');
        }
      }
      return false;
    }

    const isFullScreenTui = cliToolId === 'opencode' || cliToolId === 'copilot';

    // Duplicate prevention
    if (!isFullScreenTui && !result.bufferReset && result.lineCount === lastCapturedLine && !sessionState?.inProgressMessageId) {
      return false;
    }

    if (!result.bufferReset && !isFullScreenTui && result.lineCount <= lastCapturedLine) {
      logger.info('already-saved-up-to-line-lastcapturedlin');
      return false;
    }

    // Response is complete! Check if it's a prompt.
    const promptDetection = result.promptDetection ?? detectPromptWithOptions(result.response, cliToolId);

    if (promptDetection.isPrompt) {
      // Issue #565: Content hash-based duplicate prompt prevention
      const promptContent = promptDetection.rawContent || promptDetection.cleanContent;
      const pollerKey = getPollerKey(worktreeId, cliToolId);
      const normalizedForDedup = normalizePromptForDedup(promptContent, cliToolId);
      if (isDuplicatePrompt(pollerKey, normalizedForDedup)) {
        logger.info('duplicate-prompt-skipped', { worktreeId, cliToolId });
        return false;
      }

      // Issue #571: Clean TUI decorations from Copilot prompt content before saving
      let promptSaveContent = promptContent;
      if (cliToolId === 'copilot') {
        promptSaveContent = cleanCopilotResponse(promptContent);
        promptSaveContent = truncateMessage(promptSaveContent, COPILOT_MAX_MESSAGE_LENGTH, COPILOT_TRUNCATION_MARKER);
      }

      // This is a prompt - save as prompt message
      clearInProgressMessageId(db, worktreeId, cliToolId);

      const message = createMessage(db, {
        worktreeId,
        role: 'assistant',
        content: promptSaveContent,
        messageType: 'prompt',
        promptData: promptDetection.promptData,
        timestamp: new Date(),
        cliToolId,
      });

      updateSessionState(db, worktreeId, cliToolId, result.lineCount);
      broadcastMessage('message', { worktreeId, message });

      if (!isFullScreenTui) {
        stopPolling(worktreeId, cliToolId);
      }

      return true;
    }

    // Validate response content is not empty
    if (!result.response || result.response.trim() === '') {
      updateSessionState(db, worktreeId, cliToolId, result.lineCount);
      return false;
    }

    // Parse Claude-specific metadata
    const claudeMetadata = cliToolId === 'claude'
      ? parseClaudeOutput(result.response)
      : undefined;

    // Clean up responses
    let cleanedResponse = result.response;
    if (cliToolId === 'gemini') {
      cleanedResponse = cleanGeminiResponse(result.response);
    } else if (cliToolId === 'claude') {
      cleanedResponse = cleanClaudeResponse(result.response);
    } else if (cliToolId === 'copilot') {
      const pollerKey = getPollerKey(worktreeId, cliToolId);
      const accumulatedContent = getAccumulatedContent(pollerKey);
      const sourceContent = accumulatedContent || result.response;
      cleanedResponse = cleanCopilotResponse(sourceContent);
      cleanedResponse = truncateMessage(cleanedResponse, COPILOT_MAX_MESSAGE_LENGTH, COPILOT_TRUNCATION_MARKER);

      clearTuiAccumulator(pollerKey);
    } else if (cliToolId === 'opencode') {
      cleanedResponse = cleanOpenCodeResponse(result.response);

      const pollerKey = getPollerKey(worktreeId, cliToolId);
      clearTuiAccumulator(pollerKey);
    }

    // If cleaned response is empty or just "[No content]", skip saving
    if (!cleanedResponse || cleanedResponse.trim() === '' || cleanedResponse === '[No content]') {
      updateSessionState(db, worktreeId, cliToolId, result.lineCount);
      clearInProgressMessageId(db, worktreeId, cliToolId);
      return false;
    }

    // Create Markdown log file for the conversation pair
    if (cleanedResponse) {
      await recordClaudeConversation(db, worktreeId, cleanedResponse, cliToolId);
    }

    // Mark any pending prompts as answered
    const answeredCount = markPendingPromptsAsAnswered(db, worktreeId, cliToolId);
    if (answeredCount > 0) {
      logger.info('marked-answeredcount-pending');
    }

    // Race condition prevention: re-check session state before saving
    const currentSessionState = getSessionState(db, worktreeId, cliToolId);
    if (!isFullScreenTui && currentSessionState && result.lineCount <= currentSessionState.lastCapturedLine) {
      logger.info('race-condition-detected-skipping-save-re');
      return false;
    }

    // Create new CLI tool message in database
    const message = createMessage(db, {
      worktreeId,
      role: 'assistant',
      content: cleanedResponse,
      messageType: 'normal',
      timestamp: new Date(),
      cliToolId,
      summary: claudeMetadata?.summary,
      logFileName: claudeMetadata?.logFileName,
      requestId: claudeMetadata?.requestId,
    });

    // Broadcast message to WebSocket clients
    broadcastMessage('message', { worktreeId, message });

    // Update session state
    updateSessionState(db, worktreeId, cliToolId, result.lineCount);

    // For full-screen TUIs, stop polling after saving the response.
    if (isFullScreenTui) {
      stopPolling(worktreeId, cliToolId);
    }

    return true;
  } catch (error: unknown) {
    logger.error('response:check-failed', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
