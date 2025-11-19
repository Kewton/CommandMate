/**
 * Conversation logging helper
 * Ensures Claude responses are paired with the latest user input before writing markdown logs
 */

import type Database from 'better-sqlite3';
import { getLastUserMessage, getWorktreeById } from './db';
import { createLog } from './log-manager';

/**
 * Persist the latest Claude response alongside the most recent user prompt.
 * Errors are swallowed so the calling API route can continue responding.
 */
export async function recordClaudeConversation(
  db: Database.Database,
  worktreeId: string,
  claudeResponse: string
): Promise<void> {
  const lastUserMessage = getLastUserMessage(db, worktreeId);

  if (!lastUserMessage) {
    return;
  }

  // Get worktree to determine CLI tool ID
  const worktree = getWorktreeById(db, worktreeId);
  const cliToolId = worktree?.cliToolId || 'claude';

  try {
    await createLog(worktreeId, lastUserMessage.content, claudeResponse, cliToolId);
  } catch (error) {
    console.error('[recordClaudeConversation] Failed to create log file:', error);
  }
}
