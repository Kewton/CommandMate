/**
 * Conversation logging helper
 * Ensures Claude responses are paired with the latest user input before writing markdown logs
 */

import type Database from 'better-sqlite3';
import { getLastUserMessage } from './db';
import type { CLIToolType } from './cli-tools/types';
import { createLog } from './log-manager';
import { createLogger } from './logger';
import { mayActForPollerKey } from './polling/poller-owner';

const logger = createLogger('conversation-logger');

/** Options for {@link recordClaudeConversation}. */
export interface RecordClaudeConversationOptions {
  /**
   * The poller key the response poller's tick is writing under (Issue #3705).
   *
   * Given, the log is written only while the running code may still act for
   * that key (`mayActForPollerKey`), asked again after the log's own awaits,
   * right before the file is written: a tick retired while the log was reading
   * the old file leaves no `.md` entry for a reply whose row it was refused.
   * Omitted — the Stop route, and the held reply a stop confirms
   * (`pending-scraped-response`) — the log is written as before.
   */
  pollerKey?: string;
}

/**
 * Persist the latest Claude response alongside the most recent user prompt.
 * Errors are swallowed so the calling API route can continue responding.
 */
export async function recordClaudeConversation(
  db: Database.Database,
  worktreeId: string,
  claudeResponse: string,
  cliToolId: CLIToolType = 'claude',
  options: RecordClaudeConversationOptions = {}
): Promise<void> {
  const { pollerKey } = options;
  const mayWrite = pollerKey === undefined ? undefined : () => mayActForPollerKey(pollerKey);
  if (mayWrite && !mayWrite()) {
    logger.info('conversation:log-refused', { worktreeId, cliToolId });
    return;
  }

  const lastUserMessage = getLastUserMessage(db, worktreeId);

  if (!lastUserMessage) {
    return;
  }

  try {
    const logPath = await createLog(worktreeId, lastUserMessage.content, claudeResponse, cliToolId, {
      mayWrite,
    });
    if (logPath === null) {
      logger.info('conversation:log-refused', { worktreeId, cliToolId });
    }
  } catch (error) {
    logger.error('conversation:log-failed', { error: error instanceof Error ? error.message : String(error) });
  }
}
