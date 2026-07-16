/**
 * Assistant Response Saver
 * Issue #53: Saves pending assistant responses before a new user message
 *
 * This module implements the "next user input trigger" pattern:
 * When a user sends a new message, we first capture and save any pending
 * assistant response from the CLI tool.
 *
 * Key responsibilities:
 * - Capture CLI output since last saved position
 * - Clean and validate the response based on CLI tool type
 * - Save as assistant message with proper timestamp ordering
 * - Update session state to prevent duplicate saves
 *
 * Scope: scrollback-rendering tools only (codex, gemini, vibe-local, antigravity).
 * The whole pattern rests on `lastCapturedLine` being a read cursor into a growing
 * buffer, which is false for alternate-screen tools — those are handled by the
 * response poller instead (Issue #1268 / #1292; see savePendingAssistantResponse).
 */

import Database from 'better-sqlite3';
import { captureSessionOutput } from './session/cli-session';
import {
  createMessage,
  getSessionState,
  updateSessionState,
} from './db';
import { broadcastMessage } from './ws-server';
// Issue #571 [DR1-05]: Import directly from response-cleaner instead of barrel re-export
import { cleanClaudeResponse, cleanGeminiResponse, cleanOpenCodeResponse, cleanCopilotResponse } from './response-cleaner';
import { usesAlternateScreen, type CLIToolType } from './cli-tools/types';
import type { ChatMessage } from '@/types/models';
import { createLogger } from '@/lib/logger';

const logger = createLogger('assistant-response-saver');

/**
 * Default buffer size for capturing CLI session output (in lines)
 * @constant
 */
const SESSION_OUTPUT_BUFFER_SIZE: number = 10000;

/**
 * Tolerance for detecting buffer reset (in lines)
 * If the buffer shrinks by more than this amount, we consider it a buffer reset
 * @constant
 */
const BUFFER_RESET_TOLERANCE: number = 25;

/**
 * Detect if the tmux buffer has been reset (cleared or session restarted)
 *
 * This handles two scenarios:
 * 1. Buffer shrink: When the current line count is significantly smaller than
 *    lastCapturedLine (e.g., 1993 -> 608 lines after scrollback cleared)
 * 2. Session restart: When a CLI session is restarted and the buffer is much
 *    smaller (e.g., 500 -> 30 lines)
 *
 * Without this detection, the condition `currentLineCount <= lastCapturedLine`
 * would incorrectly skip saving responses after buffer resets.
 *
 * @param currentLineCount - Current number of lines in the buffer
 * @param lastCapturedLine - Last captured line position from session state
 * @returns Object with bufferReset boolean and reason (shrink/restart/null)
 */
export function detectBufferReset(
  currentLineCount: number,
  lastCapturedLine: number
): { bufferReset: boolean; reason: 'shrink' | 'restart' | null } {
  // Condition 1: Buffer shrink detection
  // The buffer has shrunk significantly if:
  // - currentLineCount > 0 (buffer is not empty)
  // - lastCapturedLine > BUFFER_RESET_TOLERANCE (we had significant content before)
  // - (currentLineCount + BUFFER_RESET_TOLERANCE) < lastCapturedLine (significant shrink)
  const bufferShrank = currentLineCount > 0
    && lastCapturedLine > BUFFER_RESET_TOLERANCE
    && (currentLineCount + BUFFER_RESET_TOLERANCE) < lastCapturedLine;

  // Condition 2: Session restart detection
  // The session was restarted if:
  // - currentLineCount > 0 (buffer is not empty)
  // - lastCapturedLine > 50 (we had meaningful content before)
  // - currentLineCount < 50 (buffer is now very small, typical of fresh session)
  const sessionRestarted = currentLineCount > 0
    && lastCapturedLine > 50
    && currentLineCount < 50;

  if (bufferShrank) {
    return { bufferReset: true, reason: 'shrink' };
  }
  if (sessionRestarted) {
    return { bufferReset: true, reason: 'restart' };
  }
  return { bufferReset: false, reason: null };
}

/**
 * Time offset (in milliseconds) for assistant message timestamp
 * Ensures assistant response appears before user message in chronological order
 * @constant
 */
const ASSISTANT_TIMESTAMP_OFFSET_MS: number = 1;

/**
 * Clean CLI tool response based on tool type
 *
 * @param output - Raw output from CLI tool
 * @param cliToolId - CLI tool identifier (claude, codex, gemini)
 * @returns Cleaned response content
 */
export function cleanCliResponse(output: string, cliToolId: CLIToolType): string {
  switch (cliToolId) {
    case 'claude':
      return cleanClaudeResponse(output);
    case 'gemini':
      return cleanGeminiResponse(output);
    case 'opencode':
      return cleanOpenCodeResponse(output);
    case 'copilot':
      return cleanCopilotResponse(output);
    case 'codex':
      // Codex doesn't need special cleaning
      return output.trim();
    default:
      return output.trim();
  }
}

/**
 * Save pending assistant response before a new user message
 *
 * This function is called when a user sends a new message. It:
 * 1. Captures the current tmux output since the last saved position
 * 2. Cleans and validates the output
 * 3. Saves it as an assistant message (if non-empty)
 * 4. Updates the session state to track the new position
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 * @param userMessageTimestamp - Timestamp of the new user message (for timestamp ordering)
 * @param instanceId - Agent instance ID (Issue #868). Defaults to the primary instance (=== cliToolId).
 * @returns Saved message or null if no response to save
 */
export async function savePendingAssistantResponse(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  userMessageTimestamp: Date,
  instanceId?: string
): Promise<ChatMessage | null> {
  // Issue #868: session_states / chat_messages are keyed by instance. The
  // primary instance uses instanceId === cliToolId, preserving legacy behavior.
  const resolvedInstanceId = instanceId ?? cliToolId;
  try {
    // Issue #1292: this whole function assumes the pane is a growing scrollback —
    // that `lastCapturedLine` is a read cursor and everything past it is unsaved.
    // Alternate-screen tools (claude since v2, opencode, copilot) break that
    // assumption at the root: tmux keeps no scrollback for them, so `capture-pane`
    // always returns exactly `pane_height` lines and the previous turns stay
    // painted on screen. "Old" and "pending new" content are therefore
    // indistinguishable, and the line count is a screen-row constant rather than a
    // cursor (Issue #1268).
    //
    // Measured on Claude (pane_height=1000): the first call saves at fromLine=0 and
    // parks lastCapturedLine at 1000; every later call then trips the
    // `currentLineCount <= lastCapturedLine` gate (1000 <= 1000) and returns null.
    // So its only lifetime effect was persisting the startup banner — model, plan,
    // login expiry, MCP auth state and cwd — as a bogus assistant message.
    //
    // The response poller is what actually records these tools' replies, deduping
    // on response content instead of line counts (Issue #1268/#1289), so skipping
    // here drops no coverage. OpenCode already opted out for this exact reason.
    if (usesAlternateScreen(cliToolId)) {
      return null;
    }

    // 1. Get session state for last captured position
    const sessionState = getSessionState(db, worktreeId, resolvedInstanceId);
    const lastCapturedLine = sessionState?.lastCapturedLine || 0;

    // 2. Capture current tmux output
    let output: string;
    try {
      output = await captureSessionOutput(worktreeId, cliToolId, SESSION_OUTPUT_BUFFER_SIZE, instanceId);
    } catch {
      // Session not running or capture failed - return null without error
      logger.info('failed-to-capture');
      return null;
    }

    if (!output) {
      return null;
    }

    // 3. Calculate current line count
    // Trim trailing empty lines for consistency with response-poller's extractResponse.
    // Without this, tmux buffer padding inflates the line count, causing the poller's
    // dedup check (result.lineCount <= lastCapturedLine) to always trigger.
    const lines = output.split('\n');
    let trimmedLength = lines.length;
    while (trimmedLength > 0 && lines[trimmedLength - 1].trim() === '') {
      trimmedLength--;
    }
    const currentLineCount = trimmedLength;

    // 4. Detect buffer reset (Issue #59 fix)
    const { bufferReset, reason } = detectBufferReset(currentLineCount, lastCapturedLine);

    if (bufferReset) {
      logger.info('buffer:reset-detected', { reason, currentLineCount, lastCapturedLine });
    }

    // 5. Determine effective last captured line
    // If buffer was reset, start from the beginning (0)
    const effectiveLastCapturedLine = bufferReset ? 0 : lastCapturedLine;

    // 6. Check for new output (using effective position)
    // Prevent duplicate saves when no new output has been added
    if (!bufferReset && currentLineCount <= lastCapturedLine) {
      // Correct stale position: if stored lastCapturedLine was inflated (untrimmed count
      // from before the trimming fix), update it to the current trimmed count so the
      // response-poller's dedup check can work correctly.
      if (currentLineCount < lastCapturedLine) {
        updateSessionState(db, worktreeId, cliToolId, currentLineCount, instanceId);
        logger.info('position:corrected-stale', { from: lastCapturedLine, to: currentLineCount });
      }
      return null;
    }

    // 7. Extract new lines since effective last capture position
    const newLines = lines.slice(effectiveLastCapturedLine);
    const newOutput = newLines.join('\n');

    // 8. Clean the response.
    // Only scrollback-rendering tools reach this point (Issue #1292), so the
    // tool-specific cleaners in cleanCliResponse cover every remaining case.
    const cleanedResponse = cleanCliResponse(newOutput, cliToolId);

    // 9. Check if cleaned response is empty
    if (!cleanedResponse || cleanedResponse.trim() === '') {
      // Output exists but cleaned to empty - update position but don't save
      updateSessionState(db, worktreeId, cliToolId, currentLineCount, instanceId);
      logger.debug('response:empty-after-clean', { currentLineCount });
      return null;
    }

    // Set assistant timestamp before user message to ensure correct chronological order
    // This is critical for proper conversation history display
    const assistantTimestamp = new Date(userMessageTimestamp.getTime() - ASSISTANT_TIMESTAMP_OFFSET_MS);

    // 10. Save to database
    const message = createMessage(db, {
      worktreeId,
      role: 'assistant',
      content: cleanedResponse,
      messageType: 'normal',
      timestamp: assistantTimestamp,
      cliToolId,
      instanceId: resolvedInstanceId,
    });

    // 11. Update session state with new position
    updateSessionState(db, worktreeId, cliToolId, currentLineCount, instanceId);

    // 12. Broadcast to WebSocket clients
    broadcastMessage('message', { worktreeId, message });

    logger.info('response:saved', { fromLine: lastCapturedLine, toLine: currentLineCount });

    return message;
  } catch (error) {
    // Log error but don't throw - user message should still be saved
    logger.error('error:', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
