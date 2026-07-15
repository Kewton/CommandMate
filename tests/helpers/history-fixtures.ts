/**
 * Large conversation-history fixtures (Issue #1123).
 *
 * Generates deterministic `ChatMessage[]` for exercising the virtualized
 * HistoryPane at scale (e.g. 1000 conversation pairs). Timestamps are strictly
 * increasing so `groupMessagesIntoPairs` orders them predictably, and ids are
 * stable/unique so tests can target specific rows.
 */
import type { ChatMessage } from '@/types/models';

export interface GenerateHistoryOptions {
  worktreeId?: string;
  /** Base epoch (ms) for the first message; each message advances by 1s. */
  startEpochMs?: number;
  /** When true, every pair's assistant message is long (triggers truncation). */
  longAssistant?: boolean;
}

/**
 * Build `pairCount` user→assistant conversation pairs (2 × pairCount messages),
 * in chronological order.
 */
export function generateConversationMessages(
  pairCount: number,
  options: GenerateHistoryOptions = {}
): ChatMessage[] {
  const worktreeId = options.worktreeId ?? 'test-worktree';
  const startEpochMs = options.startEpochMs ?? Date.UTC(2024, 0, 1, 0, 0, 0);
  const messages: ChatMessage[] = [];

  for (let i = 0; i < pairCount; i++) {
    const userTime = new Date(startEpochMs + i * 2000);
    const assistantTime = new Date(startEpochMs + i * 2000 + 1000);

    messages.push({
      id: `user-${i}`,
      worktreeId,
      role: 'user',
      content: `User message ${i}`,
      timestamp: userTime,
      messageType: 'normal',
      archived: false,
    });

    const assistantContent = options.longAssistant
      ? `Assistant response ${i}. ${'lorem ipsum dolor sit amet. '.repeat(30)}`
      : `Assistant response ${i}`;

    messages.push({
      id: `assistant-${i}`,
      worktreeId,
      role: 'assistant',
      content: assistantContent,
      timestamp: assistantTime,
      messageType: 'normal',
      archived: false,
    });
  }

  return messages;
}
