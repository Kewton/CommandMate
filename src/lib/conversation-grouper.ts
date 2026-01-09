/**
 * Conversation Grouper
 *
 * Groups flat message arrays into conversation pairs for UI display.
 * Each pair consists of a user message and its corresponding assistant responses.
 */

import type { ChatMessage } from '@/types/models';
import type { ConversationPair, ConversationHistory } from '@/types/conversation';

/**
 * Groups flat message array into conversation pairs.
 *
 * Algorithm:
 * 1. Sort messages by timestamp
 * 2. When a user message is detected, start a new pair
 * 3. Assistant messages are added to the current pair (as array for multi-part responses)
 * 4. Assistant messages before the first user message become orphan pairs
 *
 * Edge cases:
 * - Consecutive assistant messages -> added to same pair's assistantMessages array
 * - Orphan assistant messages (at beginning) -> create orphan status pair
 * - User message only -> pending status pair with empty assistantMessages
 *
 * @param messages - Flat array of chat messages
 * @returns Grouped conversation pairs
 */
export function groupMessagesIntoPairs(
  messages: ChatMessage[]
): ConversationHistory {
  if (messages.length === 0) {
    return [];
  }

  // Sort messages by timestamp
  const sorted = [...messages].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
  );

  const pairs: ConversationPair[] = [];
  let currentPair: ConversationPair | null = null;

  for (const message of sorted) {
    if (message.role === 'user') {
      // User message starts a new pair
      currentPair = {
        id: message.id,
        userMessage: message,
        assistantMessages: [],
        status: 'pending',
      };
      pairs.push(currentPair);
    } else if (message.role === 'assistant') {
      if (currentPair && currentPair.userMessage !== null) {
        // Add assistant message to existing pair
        currentPair.assistantMessages.push(message);
        currentPair.status = 'completed';
      } else if (currentPair && currentPair.userMessage === null) {
        // Add to existing orphan pair
        currentPair.assistantMessages.push(message);
      } else {
        // Create orphan pair for assistant message without prior user message
        const orphanPair: ConversationPair = {
          id: `orphan-${message.id}`,
          userMessage: null,
          assistantMessages: [message],
          status: 'orphan',
        };
        pairs.push(orphanPair);
        // Keep reference to add consecutive orphan messages
        currentPair = orphanPair;
      }
    }
  }

  return pairs;
}

/**
 * Check if a pair is a completed conversation (user + assistant)
 */
export function isCompletedPair(pair: ConversationPair): boolean {
  return pair.userMessage !== null && pair.assistantMessages.length > 0;
}

/**
 * Check if a pair is pending (user sent, waiting for response)
 */
export function isPendingPair(pair: ConversationPair): boolean {
  return pair.userMessage !== null && pair.assistantMessages.length === 0;
}

/**
 * Check if a pair is an orphan (assistant message without user input)
 */
export function isOrphanPair(pair: ConversationPair): boolean {
  return pair.userMessage === null;
}

/**
 * Get combined content from all assistant messages in a pair
 * Joins multiple messages with separator
 */
export function getCombinedAssistantContent(pair: ConversationPair): string {
  if (pair.assistantMessages.length === 0) {
    return '';
  }
  return pair.assistantMessages.map((m) => m.content).join('\n\n---\n\n');
}
