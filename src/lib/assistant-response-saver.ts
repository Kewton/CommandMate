/**
 * Assistant Response Saver
 * Issue #53: Saves pending assistant responses before a new user message
 *
 * This module implements the "next user input trigger" pattern:
 * When a user sends a new message, we first capture and save any pending
 * assistant response from the CLI tool (Claude/Codex/Gemini).
 *
 * Key responsibilities:
 * - Capture CLI output since last saved position
 * - Clean and validate the response based on CLI tool type
 * - Save as assistant message with proper timestamp ordering
 * - Update session state to prevent duplicate saves
 */

import Database from 'better-sqlite3';
import { captureSessionOutput } from './cli-session';
import {
  createMessage,
  getSessionState,
  updateSessionState,
} from './db';
import { broadcastMessage } from './ws-server';
import { cleanClaudeResponse, cleanGeminiResponse } from './response-poller';
import type { CLIToolType } from './cli-tools/types';
import type { ChatMessage } from '@/types/models';

/**
 * Default buffer size for capturing CLI session output (in lines)
 */
const SESSION_OUTPUT_BUFFER_SIZE = 10000;

/**
 * Time offset (in milliseconds) for assistant message timestamp
 * Ensures assistant response appears before user message in chronological order
 */
const ASSISTANT_TIMESTAMP_OFFSET_MS = 1;

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
 * @returns Saved message or null if no response to save
 */
export async function savePendingAssistantResponse(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  userMessageTimestamp: Date
): Promise<ChatMessage | null> {
  try {
    // 1. Get session state for last captured position
    const sessionState = getSessionState(db, worktreeId, cliToolId);
    const lastCapturedLine = sessionState?.lastCapturedLine || 0;

    // 2. Capture current tmux output
    let output: string;
    try {
      output = await captureSessionOutput(worktreeId, cliToolId, SESSION_OUTPUT_BUFFER_SIZE);
    } catch {
      // Session not running or capture failed - return null without error
      console.log(`[savePendingAssistantResponse] Failed to capture session output for ${worktreeId}`);
      return null;
    }

    if (!output) {
      return null;
    }

    // 3. Calculate current line count and check for new output
    const lines = output.split('\n');
    const currentLineCount = lines.length;

    // Prevent duplicate saves when no new output has been added
    if (currentLineCount <= lastCapturedLine) {
      console.log(
        `[savePendingAssistantResponse] No new output (current: ${currentLineCount}, last: ${lastCapturedLine})`
      );
      return null;
    }

    // 4. Extract new lines since last capture
    const newLines = lines.slice(lastCapturedLine);
    const newOutput = newLines.join('\n');

    // 5. Clean the response
    const cleanedResponse = cleanCliResponse(newOutput, cliToolId);

    // 6. Check if cleaned response is empty
    if (!cleanedResponse || cleanedResponse.trim() === '') {
      // Output exists but cleaned to empty - update position but don't save
      updateSessionState(db, worktreeId, cliToolId, currentLineCount);
      console.log(
        `[savePendingAssistantResponse] Cleaned response is empty, updating position to ${currentLineCount}`
      );
      return null;
    }

    // Set assistant timestamp before user message to ensure correct chronological order
    // This is critical for proper conversation history display
    const assistantTimestamp = new Date(userMessageTimestamp.getTime() - ASSISTANT_TIMESTAMP_OFFSET_MS);

    // 7. Save to database
    const message = createMessage(db, {
      worktreeId,
      role: 'assistant',
      content: cleanedResponse,
      messageType: 'normal',
      timestamp: assistantTimestamp,
      cliToolId,
    });

    // 8. Update session state with new position
    updateSessionState(db, worktreeId, cliToolId, currentLineCount);

    // 9. Broadcast to WebSocket clients
    broadcastMessage('message', { worktreeId, message });

    console.log(
      `[savePendingAssistantResponse] Saved assistant response (lines ${lastCapturedLine}-${currentLineCount})`
    );

    return message;
  } catch (error) {
    // Log error but don't throw - user message should still be saved
    console.error('[savePendingAssistantResponse] Error:', error);
    return null;
  }
}
