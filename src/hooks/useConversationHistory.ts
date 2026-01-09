/**
 * useConversationHistory Hook
 *
 * Custom hook for managing conversation history with:
 * - Message grouping into conversation pairs
 * - Expand/collapse state management for each pair
 * - Memoization for performance
 */

'use client';

import { useMemo, useState, useCallback } from 'react';
import type { ChatMessage } from '@/types/models';
import type { ConversationPair } from '@/types/conversation';
import { groupMessagesIntoPairs } from '@/lib/conversation-grouper';

/**
 * Return type for useConversationHistory hook
 */
export interface UseConversationHistoryResult {
  /** Grouped conversation pairs */
  pairs: ConversationPair[];
  /** Set of expanded pair IDs */
  expandedPairs: Set<string>;
  /** Toggle expand/collapse state for a pair */
  toggleExpand: (pairId: string) => void;
  /** Check if a pair is expanded */
  isExpanded: (pairId: string) => boolean;
  /** Expand all pairs */
  expandAll: () => void;
  /** Collapse all pairs */
  collapseAll: () => void;
}

/**
 * Hook for managing conversation history display
 *
 * @param messages - Array of chat messages to group
 * @returns Grouped pairs with expand/collapse state management
 *
 * @example
 * ```tsx
 * const { pairs, isExpanded, toggleExpand } = useConversationHistory(messages);
 *
 * return pairs.map(pair => (
 *   <ConversationPairCard
 *     key={pair.id}
 *     pair={pair}
 *     isExpanded={isExpanded(pair.id)}
 *     onToggle={() => toggleExpand(pair.id)}
 *   />
 * ));
 * ```
 */
export function useConversationHistory(
  messages: ChatMessage[]
): UseConversationHistoryResult {
  // Memoize grouped pairs - only recalculate when messages change
  const pairs = useMemo(
    () => groupMessagesIntoPairs(messages),
    [messages]
  );

  // Track expanded pair IDs
  const [expandedPairs, setExpandedPairs] = useState<Set<string>>(new Set());

  // Toggle expand/collapse for a specific pair
  const toggleExpand = useCallback((pairId: string) => {
    setExpandedPairs((prev) => {
      const next = new Set(prev);
      if (next.has(pairId)) {
        next.delete(pairId);
      } else {
        next.add(pairId);
      }
      return next;
    });
  }, []);

  // Check if a pair is expanded
  const isExpanded = useCallback(
    (pairId: string) => expandedPairs.has(pairId),
    [expandedPairs]
  );

  // Expand all pairs
  const expandAll = useCallback(() => {
    setExpandedPairs(new Set(pairs.map((p) => p.id)));
  }, [pairs]);

  // Collapse all pairs
  const collapseAll = useCallback(() => {
    setExpandedPairs(new Set());
  }, []);

  return {
    pairs,
    expandedPairs,
    toggleExpand,
    isExpanded,
    expandAll,
    collapseAll,
  };
}
