/**
 * HistoryPane Component
 *
 * Displays message history with independent scrolling
 * Supports file path detection and click handling
 */

'use client';

import React, { useMemo, memo } from 'react';
import type { ChatMessage } from '@/types/models';

/**
 * Props for HistoryPane component
 */
export interface HistoryPaneProps {
  /** Array of chat messages to display */
  messages: ChatMessage[];
  /** Associated worktree ID */
  worktreeId: string;
  /** Callback when a file path is clicked */
  onFilePathClick: (path: string) => void;
  /** Whether the component is in loading state */
  isLoading?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Regular expression to match file paths
 * Matches paths like /path/to/file.ts, ./relative/path.js, etc.
 */
const FILE_PATH_REGEX = /(\/[^\s\n<>"']+\.[a-zA-Z0-9]+)/g;

/**
 * Renders message content with clickable file paths
 */
function MessageContent({
  content,
  onFilePathClick,
}: {
  content: string;
  onFilePathClick: (path: string) => void;
}) {
  // Split content by file paths and render with clickable links
  const parts = useMemo(() => {
    const matches = content.match(FILE_PATH_REGEX);
    if (!matches || matches.length === 0) {
      // No file paths, return escaped content
      return [{ type: 'text' as const, content }];
    }

    const result: Array<{ type: 'text' | 'path'; content: string }> = [];
    let lastIndex = 0;

    matches.forEach((match) => {
      const index = content.indexOf(match, lastIndex);
      if (index > lastIndex) {
        result.push({ type: 'text', content: content.slice(lastIndex, index) });
      }
      result.push({ type: 'path', content: match });
      lastIndex = index + match.length;
    });

    if (lastIndex < content.length) {
      result.push({ type: 'text', content: content.slice(lastIndex) });
    }

    return result;
  }, [content]);

  return (
    <span>
      {parts.map((part, index) =>
        part.type === 'path' ? (
          <button
            key={index}
            onClick={() => onFilePathClick(part.content)}
            className="text-blue-400 hover:text-blue-300 hover:underline cursor-pointer font-mono text-sm"
            aria-label={part.content}
          >
            {part.content}
          </button>
        ) : (
          <span key={index}>{part.content}</span>
        )
      )}
    </span>
  );
}

/**
 * Single message display component
 */
function MessageItem({
  message,
  onFilePathClick,
}: {
  message: ChatMessage;
  onFilePathClick: (path: string) => void;
}) {
  const isUser = message.role === 'user';

  return (
    <div
      data-testid={`message-${message.role}`}
      className={`p-3 rounded-lg mb-2 ${
        isUser
          ? 'bg-blue-900/30 border-l-4 border-blue-500 ml-4 user'
          : 'bg-gray-800/50 border-l-4 border-gray-600 mr-4 assistant'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span
          className={`text-xs font-medium ${
            isUser ? 'text-blue-400' : 'text-gray-400'
          }`}
        >
          {isUser ? 'You' : 'Assistant'}
        </span>
        <span className="text-xs text-gray-500">
          {message.timestamp.toLocaleTimeString()}
        </span>
      </div>
      <div className="text-sm text-gray-200 whitespace-pre-wrap break-words">
        <MessageContent content={message.content} onFilePathClick={onFilePathClick} />
      </div>
    </div>
  );
}

/**
 * Loading indicator component
 */
function LoadingIndicator() {
  return (
    <div
      data-testid="loading-indicator"
      className="flex items-center justify-center py-4"
    >
      <div className="flex gap-1">
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse" />
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse delay-100" />
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse delay-200" />
      </div>
      <span className="ml-2 text-sm text-gray-400">Loading...</span>
    </div>
  );
}

/**
 * Empty state component
 */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-gray-500">
      <svg
        className="w-12 h-12 mb-2 opacity-50"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
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

/**
 * HistoryPane component for displaying message history
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
}: HistoryPaneProps) {
  // worktreeId is kept in props for future use (e.g., filtering, fetching)
  void _worktreeId;
  // Sort messages by timestamp
  const sortedMessages = useMemo(
    () =>
      [...messages].sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
      ),
    [messages]
  );

  const containerClasses = useMemo(
    () =>
      [
        'h-full',
        'flex',
        'flex-col',
        'overflow-y-auto',
        'overflow-x-hidden',
        'bg-gray-900',
        'rounded-lg',
        'border',
        'border-gray-700',
        className,
      ]
        .filter(Boolean)
        .join(' '),
    [className]
  );

  return (
    <div
      role="region"
      aria-label="Message history"
      className={containerClasses}
    >
      {/* Header */}
      <div className="sticky top-0 bg-gray-900 border-b border-gray-700 px-4 py-2 z-10">
        <h3 className="text-sm font-medium text-gray-300">Message History</h3>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 min-h-0">
        {isLoading ? (
          <LoadingIndicator />
        ) : messages.length === 0 ? (
          <EmptyState />
        ) : (
          sortedMessages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              onFilePathClick={onFilePathClick}
            />
          ))
        )}
      </div>
    </div>
  );
});

export default HistoryPane;
