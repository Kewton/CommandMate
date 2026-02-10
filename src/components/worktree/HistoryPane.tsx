/**
 * HistoryPane Component
 *
 * Displays message history grouped as conversation pairs.
 * Each pair shows a user message with its corresponding assistant response(s).
 * Supports file path detection and click handling.
 */

'use client';

import React, { useMemo, useCallback, memo, useRef, useLayoutEffect } from 'react';
import type { ChatMessage } from '@/types/models';
import { useConversationHistory } from '@/hooks/useConversationHistory';
import { ConversationPairCard } from './ConversationPairCard';
import { copyToClipboard } from '@/lib/clipboard-utils';

// ============================================================================
// Constants
// ============================================================================

/**
 * Height of the sticky header in pixels.
 * Used for scroll position calculations and future reference.
 * Note: sticky top-0 does not affect scrollTop calculation as content flows below naturally.
 */
export const STICKY_HEADER_HEIGHT = 48;

// ============================================================================
// Types
// ============================================================================

/**
 * Props for HistoryPane component
 */
export interface HistoryPaneProps {
  /** Array of chat messages to display */
  messages: ChatMessage[];
  /** Associated worktree ID (reserved for future filtering/fetching) */
  worktreeId: string;
  /** Callback when a file path is clicked */
  onFilePathClick: (path: string) => void;
  /** Whether the component is in loading state */
  isLoading?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Toast notification callback for copy feedback (optional) */
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Loading indicator component.
 * Displays animated dots while content is loading.
 * Includes proper ARIA role and label for accessibility.
 */
function LoadingIndicator() {
  return (
    <div
      data-testid="loading-indicator"
      className="flex items-center justify-center py-4"
      role="status"
      aria-label="Loading messages"
    >
      <div className="flex gap-1" aria-hidden="true">
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse" />
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse delay-100" />
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse delay-200" />
      </div>
      <span className="ml-2 text-sm text-gray-400">Loading...</span>
    </div>
  );
}

/**
 * Empty state component.
 * Displays a friendly message and icon when there are no messages.
 * Provides visual feedback to users that the history is empty.
 */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-gray-500">
      <svg
        className="w-12 h-12 mb-2 opacity-50"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
        />
      </svg>
      <p className="text-sm">No messages yet</p>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/** Base container classes for the history pane */
const BASE_CONTAINER_CLASSES = [
  'h-full',
  'flex',
  'flex-col',
  'overflow-y-auto',
  'overflow-x-hidden',
  'bg-gray-900',
  'rounded-lg',
  'border',
  'border-gray-700',
] as const;

/**
 * HistoryPane component for displaying message history as conversation pairs.
 *
 * Features:
 * - Groups user and assistant messages into conversation pairs
 * - Supports consecutive assistant messages in a single pair
 * - Handles orphan assistant messages (system messages)
 * - Shows pending state when waiting for response
 * - Independent scrolling
 * - Clickable file paths
 * - Loading and empty states
 * - Accessibility support
 *
 * @example
 * ```tsx
 * <HistoryPane
 *   messages={messages}
 *   worktreeId="my-worktree"
 *   onFilePathClick={(path) => openFile(path)}
 *   isLoading={false}
 * />
 * ```
 */
export const HistoryPane = memo(function HistoryPane({
  messages,
  worktreeId: _worktreeId,
  onFilePathClick,
  isLoading = false,
  className = '',
  showToast,
}: HistoryPaneProps) {
  // worktreeId is kept in props for future use (e.g., filtering, fetching)
  // Using underscore prefix to indicate intentionally unused parameter
  void _worktreeId;

  // Scroll container ref for position preservation
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Store scroll position to restore after re-renders
  const scrollPositionRef = useRef<number>(0);
  // Track message count to detect meaningful changes
  const prevMessageCountRef = useRef<number>(messages.length);

  // Save scroll position before render
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (container) {
      scrollPositionRef.current = container.scrollTop;
    }
  });

  // Restore scroll position after render if message count unchanged
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const prevCount = prevMessageCountRef.current;

    // Only restore scroll if message count hasn't increased
    // (new messages should allow natural scroll behavior)
    if (container && messages.length === prevCount) {
      requestAnimationFrame(() => {
        container.scrollTop = scrollPositionRef.current;
        // Note: sticky header does not affect scrollTop calculation
        // as content flows below the header naturally
      });
    }

    // Update previous count for next render
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  // Use conversation history hook for grouping and expand/collapse state
  const { pairs, isExpanded, toggleExpand } = useConversationHistory(messages);

  // Build container class string
  const containerClasses = useMemo(
    () => [...BASE_CONTAINER_CLASSES, className].filter(Boolean).join(' '),
    [className]
  );

  // Memoize the file path click handler to prevent unnecessary re-renders
  const handleFilePathClick = useCallback(
    (path: string) => onFilePathClick(path),
    [onFilePathClick]
  );

  // Create toggle handler factory
  const createToggleHandler = useCallback(
    (pairId: string) => () => toggleExpand(pairId),
    [toggleExpand]
  );

  // Copy message handler - uses copyToClipboard utility (SF-S4-1, MF-1 DRY)
  const handleCopy = useCallback(
    async (content: string) => {
      try {
        await copyToClipboard(content);
        showToast?.('Copied to clipboard', 'success');
      } catch {
        // SF-S4-3: Error log excludes message content
        console.error('[HistoryPane] Failed to copy to clipboard');
        showToast?.('Failed to copy', 'error');
      }
    },
    [showToast]
  );

  // Render content based on state
  const renderContent = () => {
    if (isLoading) {
      return <LoadingIndicator />;
    }
    if (messages.length === 0) {
      return <EmptyState />;
    }
    return pairs.map((pair) => (
      <ConversationPairCard
        key={pair.id}
        pair={pair}
        onFilePathClick={handleFilePathClick}
        isExpanded={isExpanded(pair.id)}
        onToggleExpand={createToggleHandler(pair.id)}
        onCopy={handleCopy}
      />
    ));
  };

  return (
    <div
      ref={scrollContainerRef}
      role="region"
      aria-label="Message history"
      className={containerClasses}
    >
      {/* Header */}
      <div className="sticky top-0 bg-gray-900 border-b border-gray-700 px-4 py-2 z-10">
        <h3 className="text-sm font-medium text-gray-300">Message History</h3>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 min-h-0">{renderContent()}</div>
    </div>
  );
});

export default HistoryPane;
