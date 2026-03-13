/**
 * Conversation logging helper
 * Ensures Claude responses are paired with the latest user input before writing markdown logs
 */

import type Database from 'better-sqlite3';
import { getLastUserMessage } from './db';
import type { CLIToolType } from './cli-tools/types';
import { createLog } from './log-manager';
import { createLogger } from './logger';

const logger = createLogger('conversation-logger');

/**
 * Persist the latest Claude response alongside the most recent user prompt.
 * Errors are swallowed so the calling API route can continue responding.
 */
export async function recordClaudeConversation(
  db: Database.Database,
  worktreeId: string,
  claudeResponse: string,
  cliToolId: CLIToolType = 'claude'
): Promise<void> {
  const lastUserMessage = getLastUserMessage(db, worktreeId);

  if (!lastUserMessage) {
    return;
  }

  try {
    await createLog(worktreeId, lastUserMessage.content, claudeResponse, cliToolId);
  } catch (error) {
    logger.error('conversation:log-failed', { error: error instanceof Error ? error.message : String(error) });
  }
}
