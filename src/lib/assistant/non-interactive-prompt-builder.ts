import type Database from 'better-sqlite3';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { Repository } from '@/lib/db/db-repository';
import type {
  AssistantConversation,
  AssistantMessage,
} from '@/lib/db/assistant-conversation-db';
import { buildAssistantStartupSnapshot } from './context-builder';

const MAX_HISTORY_MESSAGES = 12;

function formatHistory(messages: AssistantMessage[]): string {
  const recentMessages = messages.slice(-MAX_HISTORY_MESSAGES);
  if (recentMessages.length === 0) {
    return 'No prior conversation history.';
  }

  return recentMessages
    .filter((message) => message.messageType === 'normal')
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join('\n\n');
}

export function buildNonInteractivePrompt(params: {
  db: Database.Database;
  cliToolId: CLIToolType;
  repository: Repository;
  messages: AssistantMessage[];
  userMessage: string;
  conversation?: AssistantConversation;
}): string {
  const { db, cliToolId, repository, messages, userMessage, conversation } = params;

  const startupContext = conversation?.contextSnapshot
    ?? buildAssistantStartupSnapshot(cliToolId, db);

  return [
    startupContext,
    '',
    '## Active Repository',
    `${repository.displayName || repository.name}: ${repository.path}`,
    '',
    '## Conversation History',
    formatHistory(messages),
    '',
    '## New User Message',
    userMessage,
  ].join('\n');
}
