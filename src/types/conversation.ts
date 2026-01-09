/**
 * Conversation Pair Types
 *
 * Types for grouping user-assistant message pairs in the UI layer.
 * These types are used to display conversation history with 1:1 correspondence
 * between user inputs and assistant responses.
 */

import type { ChatMessage } from './models';

/**
 * Conversation pair status
 * - 'pending': User input sent, waiting for assistant response
 * - 'completed': Normal conversation pair (User + Assistant)
 * - 'orphan': Orphan assistant message (no user input)
 */
export type ConversationStatus = 'pending' | 'completed' | 'orphan';

/**
 * Conversation pair: Groups user input with corresponding assistant responses
 *
 * Design considerations:
 * - assistantMessages is an array to support consecutive assistant messages
 * - userMessage is nullable to support orphan assistant messages
 */
export interface ConversationPair {
  /** Unique identifier for the pair (user message ID, or "orphan-{id}" for orphan messages) */
  id: string;
  /** User message (null for orphan assistant messages) */
  userMessage: ChatMessage | null;
  /** Array of assistant messages (empty for pending, may have multiple for multi-part responses) */
  assistantMessages: ChatMessage[];
  /** Conversation status */
  status: ConversationStatus;
}

/**
 * Conversation history: Array of conversation pairs
 */
export type ConversationHistory = ConversationPair[];
