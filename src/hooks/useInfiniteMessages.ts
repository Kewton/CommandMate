/**
 * useInfiniteMessages Hook
 *
 * Provides infinite scroll functionality for loading messages.
 * Supports pagination, error handling, and caching.
 *
 * Features:
 * - Initial load of messages
 * - Load older messages on scroll
 * - Refresh capability
 * - Error handling with retry
 * - Cache management
 * - Conversation pair grouping
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { ChatMessage } from '@/types/models';
import type { ConversationPair } from '@/types/conversation';
import {
  type InfiniteMessagesError,
  createInfiniteMessagesError,
} from '@/types/infinite-messages';

/**
 * Options for useInfiniteMessages hook
 */
export interface UseInfiniteMessagesOptions {
  /** Worktree ID to fetch messages for */
  worktreeId: string;
  /** CLI tool ID for filtering messages */
  cliToolId: string;
  /** Number of messages per page (default: 50) */
  pageSize?: number;
}

/**
 * Return type for useInfiniteMessages hook
 */
export interface UseInfiniteMessagesReturn {
  /** All loaded messages */
  messages: ChatMessage[];
  /** Messages grouped into conversation pairs */
  conversationPairs: ConversationPair[];
  /** Whether initial load is in progress */
  isLoading: boolean;
  /** Whether older messages are being loaded */
  isLoadingOlder: boolean;
  /** Whether a refresh is in progress */
  isRefreshing: boolean;
  /** Whether there are more messages to load */
  hasMore: boolean;
  /** Load more (older) messages */
  loadMore: () => Promise<void>;
  /** Current error state */
  error: InfiniteMessagesError | null;
  /** Retry the last failed operation */
  retry: () => Promise<void>;
  /** Refresh all messages */
  refresh: () => Promise<void>;
  /** Clear the message cache */
  clearCache: () => void;
}

/**
 * Groups messages into conversation pairs
 */
function groupIntoConversationPairs(messages: ChatMessage[]): ConversationPair[] {
  const pairs: ConversationPair[] = [];
  let currentPair: ConversationPair | null = null;

  for (const message of messages) {
    if (message.role === 'user') {
      // Start a new pair
      if (currentPair) {
        pairs.push(currentPair);
      }
      currentPair = {
        id: `pair-${message.id}`,
        status: 'pending',
        userMessage: message,
        assistantMessages: [],
      };
    } else if (message.role === 'assistant') {
      if (currentPair) {
        currentPair.assistantMessages.push(message);
        currentPair.status = 'completed';
      } else {
        // Orphan assistant message
        pairs.push({
          id: `pair-orphan-${message.id}`,
          status: 'orphan',
          userMessage: null,
          assistantMessages: [message],
        });
      }
    }
  }

  // Push the last pair if exists
  if (currentPair) {
    pairs.push(currentPair);
  }

  return pairs;
}

/**
 * Parse message timestamps from API response
 */
function parseMessageTimestamps(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => ({
    ...msg,
    timestamp: new Date(msg.timestamp),
  }));
}

/**
 * Hook for infinite scroll message loading
 *
 * @param options - Configuration options
 * @returns Object with messages, loading states, and control functions
 *
 * @example
 * ```tsx
 * function MessageList({ worktreeId }) {
 *   const {
 *     messages,
 *     isLoading,
 *     hasMore,
 *     loadMore,
 *     error,
 *     retry,
 *   } = useInfiniteMessages({
 *     worktreeId,
 *     cliToolId: 'claude',
 *   });
 *
 *   if (error) {
 *     return <button onClick={retry}>Retry</button>;
 *   }
 *
 *   return (
 *     <div onScroll={handleScroll}>
 *       {messages.map(msg => <Message key={msg.id} {...msg} />)}
 *       {hasMore && <button onClick={loadMore}>Load More</button>}
 *     </div>
 *   );
 * }
 * ```
 */
export function useInfiniteMessages(
  options: UseInfiniteMessagesOptions
): UseInfiniteMessagesReturn {
  const { worktreeId, cliToolId, pageSize = 50 } = options;

  // State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<InfiniteMessagesError | null>(null);

  // Refs
  const lastFailedOperationRef = useRef<(() => Promise<void>) | null>(null);
  const isMountedRef = useRef(true);

  /**
   * Fetch messages from API
   */
  const fetchMessages = useCallback(
    async (before?: string): Promise<ChatMessage[]> => {
      const params = new URLSearchParams({
        cliTool: cliToolId,
        limit: String(pageSize),
      });
      if (before) {
        params.set('before', before);
      }

      const response = await fetch(
        `/api/worktrees/${worktreeId}/messages?${params.toString()}`
      );

      if (!response.ok) {
        throw response;
      }

      const data = await response.json();
      return parseMessageTimestamps(data);
    },
    [worktreeId, cliToolId, pageSize]
  );

  /**
   * Handle errors and store for retry
   */
  const handleError = useCallback(
    (err: unknown, operation: () => Promise<void>) => {
      lastFailedOperationRef.current = operation;
      const error = createInfiniteMessagesError({ error: err });
      setError(error);
    },
    []
  );

  /**
   * Initial load of messages
   */
  const loadInitial = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const fetchedMessages = await fetchMessages();
      if (!isMountedRef.current) return;

      setMessages(fetchedMessages);
      setHasMore(fetchedMessages.length >= pageSize);
    } catch (err) {
      if (!isMountedRef.current) return;
      handleError(err, loadInitial);
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [fetchMessages, pageSize, handleError]);

  /**
   * Load older messages
   */
  const loadMore = useCallback(async () => {
    if (!hasMore || isLoadingOlder) return;

    setIsLoadingOlder(true);
    setError(null);

    try {
      const oldestMessage = messages[messages.length - 1];
      const before = oldestMessage?.timestamp
        ? oldestMessage.timestamp.toISOString()
        : undefined;

      const fetchedMessages = await fetchMessages(before);
      if (!isMountedRef.current) return;

      setMessages((prev) => [...prev, ...fetchedMessages]);
      setHasMore(fetchedMessages.length >= pageSize);
    } catch (err) {
      if (!isMountedRef.current) return;
      handleError(err, loadMore);
    } finally {
      if (isMountedRef.current) {
        setIsLoadingOlder(false);
      }
    }
  }, [hasMore, isLoadingOlder, messages, fetchMessages, pageSize, handleError]);

  /**
   * Retry the last failed operation
   */
  const retry = useCallback(async () => {
    if (lastFailedOperationRef.current) {
      setError(null);
      await lastFailedOperationRef.current();
    }
  }, []);

  /**
   * Refresh all messages
   */
  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    setError(null);

    try {
      const fetchedMessages = await fetchMessages();
      if (!isMountedRef.current) return;

      setMessages(fetchedMessages);
      setHasMore(fetchedMessages.length >= pageSize);
    } catch (err) {
      if (!isMountedRef.current) return;
      handleError(err, refresh);
    } finally {
      if (isMountedRef.current) {
        setIsRefreshing(false);
      }
    }
  }, [fetchMessages, pageSize, handleError]);

  /**
   * Clear the message cache
   */
  const clearCache = useCallback(() => {
    setMessages([]);
    setHasMore(false);
    setError(null);
  }, []);

  /**
   * Group messages into conversation pairs (memoized)
   */
  const conversationPairs = useMemo(
    () => groupIntoConversationPairs(messages),
    [messages]
  );

  // Initial load on mount
  useEffect(() => {
    isMountedRef.current = true;
    loadInitial();

    return () => {
      isMountedRef.current = false;
    };
  }, [loadInitial]);

  return {
    messages,
    conversationPairs,
    isLoading,
    isLoadingOlder,
    isRefreshing,
    hasMore,
    loadMore,
    error,
    retry,
    refresh,
    clearCache,
  };
}

export default useInfiniteMessages;
