/**
 * Message synchronization utilities
 * Issue #54: Improved message handling with optimistic UI updates
 *
 * This module provides utilities for:
 * - Merging messages from different sources without duplicates
 * - Managing optimistic UI updates (add/confirm/remove)
 * - Maintaining message count limits to prevent memory issues
 */

import type { ChatMessage } from '@/types/models';

/**
 * Maximum number of messages to keep in memory
 * This prevents memory leaks from unbounded message growth
 * @constant
 */
export const MAX_MESSAGES: number = 200 as const;

/**
 * Merge messages from existing and incoming sources
 *
 * Features:
 * - Deduplicates by message ID
 * - Sorts by timestamp (ascending)
 * - Respects max limit by removing oldest messages
 *
 * @param existing - Current messages in state
 * @param incoming - New messages to merge
 * @param maxMessages - Maximum number of messages to keep (default: MAX_MESSAGES)
 * @returns Merged and sorted message array
 */
export function mergeMessages(
  existing: ChatMessage[],
  incoming: ChatMessage[],
  maxMessages: number = MAX_MESSAGES
): ChatMessage[] {
  // Create a map of existing message IDs for quick lookup
  const existingIds = new Set(existing.map(m => m.id));

  // Filter out duplicates from incoming messages
  const newMessages = incoming.filter(m => !existingIds.has(m.id));

  // Merge and sort by timestamp
  const merged = [...existing, ...newMessages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Apply max limit by keeping newest messages
  if (merged.length > maxMessages) {
    return merged.slice(-maxMessages);
  }

  return merged;
}

/**
 * Partial message data for optimistic updates
 * ID is provided separately, timestamp is auto-generated if not provided
 */
type OptimisticMessageData = Omit<ChatMessage, 'id' | 'timestamp'> & {
  timestamp?: Date;
};

/**
 * Add an optimistic message with a temporary ID
 *
 * Use this when sending a message to show it immediately in the UI
 * before the server responds. The message will have a temporary ID
 * that can be replaced with the real ID using confirmOptimisticMessage.
 *
 * @param messages - Current messages array
 * @param newMessage - Message data (without ID, timestamp is optional)
 * @param tempId - Temporary ID for the message (e.g., "temp-123")
 * @returns New messages array with the optimistic message added
 */
export function addOptimisticMessage(
  messages: ChatMessage[],
  newMessage: OptimisticMessageData,
  tempId: string
): ChatMessage[] {
  const optimistic: ChatMessage = {
    ...newMessage,
    id: tempId,
    timestamp: newMessage.timestamp || new Date(),
  } as ChatMessage;

  const result = [...messages, optimistic];

  // Respect max limit
  return result.slice(-MAX_MESSAGES);
}

/**
 * Confirm an optimistic message by replacing temp ID with real ID
 *
 * Call this after the server responds successfully to replace
 * the temporary ID with the real database ID.
 *
 * @param messages - Current messages array
 * @param tempId - Temporary ID to replace
 * @param realId - Real ID from the server
 * @returns New messages array with the ID replaced
 */
export function confirmOptimisticMessage(
  messages: ChatMessage[],
  tempId: string,
  realId: string
): ChatMessage[] {
  return messages.map(m =>
    m.id === tempId ? { ...m, id: realId } : m
  );
}

/**
 * Remove an optimistic message (e.g., on server error)
 *
 * Call this if the server request fails to remove the
 * optimistic message from the UI.
 *
 * @param messages - Current messages array
 * @param tempId - Temporary ID of message to remove
 * @returns New messages array without the specified message
 */
export function removeOptimisticMessage(
  messages: ChatMessage[],
  tempId: string
): ChatMessage[] {
  return messages.filter(m => m.id !== tempId);
}
