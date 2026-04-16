/**
 * Server-side polling for assistant conversations.
 * Persists completed assistant responses independent of the active UI tab.
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  deleteAssistantSessionState,
  getAssistantConversationById,
  updateAssistantConversation,
} from '@/lib/db';
import {
  GLOBAL_POLL_INTERVAL_MS,
  GLOBAL_POLL_MAX_RETRIES,
} from '@/lib/session/global-session-constants';
import { hasSession } from '@/lib/tmux/tmux';
import { createLogger } from '@/lib/logger';
import { getAssistantConversationSession } from '@/lib/assistant/conversation-session';
import { savePendingAssistantResponseForConversation } from '@/lib/assistant/conversation-response-saver';

const logger = createLogger('assistant-conversation-poller');

const activePollers = new Map<string, NodeJS.Timeout>();
const pollerIterations = new Map<string, number>();

function getPollerKey(conversationId: string, cliToolId: CLIToolType): string {
  return `${conversationId}:${cliToolId}`;
}

export function pollAssistantConversation(
  conversationId: string,
  cliToolId: CLIToolType
): void {
  stopAssistantConversationPolling(conversationId, cliToolId);

  const pollerKey = getPollerKey(conversationId, cliToolId);
  pollerIterations.set(pollerKey, 0);
  scheduleNextPoll(conversationId, cliToolId);
}

export function stopAssistantConversationPolling(
  conversationId: string,
  cliToolId: CLIToolType
): void {
  const pollerKey = getPollerKey(conversationId, cliToolId);
  const timerId = activePollers.get(pollerKey);
  if (timerId) {
    clearTimeout(timerId);
    activePollers.delete(pollerKey);
    pollerIterations.delete(pollerKey);
  }
}

export function stopAllAssistantConversationPolling(): void {
  for (const timerId of activePollers.values()) {
    clearTimeout(timerId);
  }
  activePollers.clear();
  pollerIterations.clear();
}

function scheduleNextPoll(conversationId: string, cliToolId: CLIToolType): void {
  const pollerKey = getPollerKey(conversationId, cliToolId);

  const timerId = setTimeout(async () => {
    const iteration = pollerIterations.get(pollerKey) ?? 0;
    if (iteration >= GLOBAL_POLL_MAX_RETRIES) {
      stopAssistantConversationPolling(conversationId, cliToolId);
      return;
    }

    pollerIterations.set(pollerKey, iteration + 1);

    try {
      const db = getDbInstance();
      const conversation = getAssistantConversationById(db, conversationId);
      if (!conversation || conversation.cliToolId !== cliToolId || conversation.status !== 'running') {
        stopAssistantConversationPolling(conversationId, cliToolId);
        return;
      }

      const { sessionName } = getAssistantConversationSession(cliToolId, conversationId);
      const sessionExists = await hasSession(sessionName);
      if (!sessionExists) {
        updateAssistantConversation(db, conversationId, {
          status: 'stopped',
          lastStoppedAt: new Date(),
        });
        deleteAssistantSessionState(db, conversationId);
        stopAssistantConversationPolling(conversationId, cliToolId);
        return;
      }

      await savePendingAssistantResponseForConversation(db, conversationId, cliToolId);
    } catch (error) {
      logger.error('poll:error', {
        conversationId,
        cliToolId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (activePollers.has(pollerKey)) {
      scheduleNextPoll(conversationId, cliToolId);
    }
  }, GLOBAL_POLL_INTERVAL_MS);

  activePollers.set(pollerKey, timerId);
}
