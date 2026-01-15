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
import { stripAnsi } from './cli-patterns';
import type { CLIToolType } from './cli-tools/types';
import type { ChatMessage } from '@/types/models';

/**
 * Skip patterns for Claude-specific UI elements
 * Used by extractAssistantResponseBeforeLastPrompt to filter out non-response content
 * @remarks These patterns are specific to the "before prompt" extraction logic
 * and differ from cli-patterns.ts skipPatterns which are for "after prompt" extraction
 */
const CLAUDE_SKIP_PATTERNS: readonly RegExp[] = [
  /^[╭╮╰╯│─\s]+$/,  // Box drawing characters
  /Claude Code v[\d.]+/,  // Version info
  /^─{10,}$/,  // Separator lines
  /^❯\s*$/,  // Empty prompt lines
  /^\s*$/,  // Empty lines
  /CLAUDE_HOOKS_/,
  /\/bin\/claude/,
  /@.*\s+%/,
  /localhost/,
  /:3000/,
  /curl.*POST/,
  /export\s+/,
  /Tips for getting started/,
  /Welcome back/,
  /\?\s*for shortcuts/,
];

/**
 * Extract assistant response BEFORE the last user prompt
 *
 * This is the key fix for Issue #54 Problem 4:
 * - cleanClaudeResponse() extracts AFTER the last prompt (for response-poller)
 * - This function extracts BEFORE the last prompt (for savePendingAssistantResponse)
 *
 * Scenario:
 * tmuxバッファの状態（ユーザーがメッセージBを送信した時点）:
 * ─────────────────────────────────────
 * ❯ メッセージA（前回のユーザー入力）
 * [前回のassistant応答 - 保存したい内容]
 * ───
 * ❯ メッセージB（今回のユーザー入力）  ← 最後のプロンプト
 * [Claude処理中...]
 * ─────────────────────────────────────
 *
 * We want to extract the content BEFORE ❯ メッセージB
 *
 * @param output - Raw tmux output (new lines since last capture)
 * @param cliToolId - CLI tool ID
 * @returns Cleaned assistant response content
 */
export function extractAssistantResponseBeforeLastPrompt(
  output: string,
  cliToolId: CLIToolType
): string {
  if (!output || output.trim() === '') {
    return '';
  }

  if (cliToolId !== 'claude') {
    // For non-Claude tools, use simple trimming
    return output.trim();
  }

  const cleanOutput = stripAnsi(output);
  const lines = cleanOutput.split('\n');

  // Find the LAST user prompt (the new message that triggered this save)
  // User prompt pattern: ❯ followed by actual content
  let lastUserPromptIndex = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^❯\s+\S/.test(lines[i])) {
      lastUserPromptIndex = i;
      break;
    }
  }

  // Extract lines BEFORE the last user prompt
  const responseLines = lines.slice(0, lastUserPromptIndex);

  // Filter out UI elements
  const cleanedLines = responseLines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return !CLAUDE_SKIP_PATTERNS.some(pattern => pattern.test(trimmed));
  });

  return cleanedLines.join('\n').trim();
}

/**
 * Default buffer size for capturing CLI session output (in lines)
 * @constant
 */
const SESSION_OUTPUT_BUFFER_SIZE: number = 10000;

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
    // Issue #54 FIX: For Claude, use extractAssistantResponseBeforeLastPrompt
    // to extract content BEFORE the last user prompt (not after it)
    // This fixes the issue where assistant responses were not being saved
    // when user sends a new message
    const cleanedResponse = cliToolId === 'claude'
      ? extractAssistantResponseBeforeLastPrompt(newOutput, cliToolId)
      : cleanCliResponse(newOutput, cliToolId);

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
