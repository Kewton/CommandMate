/**
 * ConversationPairCard Component
 *
 * Displays a conversation pair (user message + assistant responses) as a single card.
 * Supports completed, pending, and orphan states with appropriate visual styling.
 */

'use client';

import React, { useMemo, useCallback, memo } from 'react';
import { Copy } from 'lucide-react';
import type { ConversationPair } from '@/types/conversation';
import type { ChatMessage } from '@/types/models';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for ConversationPairCard component
 */
export interface ConversationPairCardProps {
  /** Conversation pair to display */
  pair: ConversationPair;
  /** Callback when a file path is clicked */
  onFilePathClick: (path: string) => void;
  /** Whether the card is expanded (for long assistant messages) */
  isExpanded?: boolean;
  /** Callback when expand/collapse is toggled */
  onToggleExpand?: () => void;
  /** Callback when a message is copied (optional) */
  onCopy?: (content: string) => void;
}

/** Parsed content part type */
interface ContentPart {
  type: 'text' | 'path';
  content: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Regular expression to match file paths.
 * Matches paths like /path/to/file.ts, ./relative/path.js, etc.
 */
const FILE_PATH_REGEX = /(\/[^\s\n<>"']+\.[a-zA-Z0-9]+)/g;

/** Maximum characters to show in collapsed state */
const COLLAPSED_MAX_CHARS = 300;

/** Maximum lines to show in collapsed state */
const COLLAPSED_MAX_LINES = 5;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parses content string into text and file path parts.
 * Detects file paths matching the FILE_PATH_REGEX pattern and splits
 * the content into alternating text and path segments.
 *
 * @param content - The raw message content to parse
 * @returns Array of content parts, each marked as 'text' or 'path'
 */
function parseContentParts(content: string): ContentPart[] {
  const matches = content.match(FILE_PATH_REGEX);
  if (!matches || matches.length === 0) {
    return [{ type: 'text', content }];
  }

  const result: ContentPart[] = [];
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
}

/**
 * Get truncated content for collapsed view.
 * Truncates content based on COLLAPSED_MAX_LINES and COLLAPSED_MAX_CHARS limits.
 *
 * @param content - The full message content
 * @returns Object containing truncated text and whether truncation occurred
 */
function getTruncatedContent(
  content: string
): { text: string; isTruncated: boolean } {
  const lines = content.split('\n');

  if (lines.length <= COLLAPSED_MAX_LINES && content.length <= COLLAPSED_MAX_CHARS) {
    return { text: content, isTruncated: false };
  }

  let truncated = lines.slice(0, COLLAPSED_MAX_LINES).join('\n');
  if (truncated.length > COLLAPSED_MAX_CHARS) {
    truncated = truncated.slice(0, COLLAPSED_MAX_CHARS);
  }

  return { text: truncated, isTruncated: true };
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Renders message content with clickable file paths.
 * File paths matching the FILE_PATH_REGEX are converted to clickable buttons.
 *
 * @param props.content - The message content to render
 * @param props.onFilePathClick - Callback invoked when a file path is clicked
 */
const MessageContent = memo(function MessageContent({
  content,
  onFilePathClick,
}: {
  content: string;
  onFilePathClick: (path: string) => void;
}) {
  const parts = useMemo(() => parseContentParts(content), [content]);

  const handlePathClick = useCallback(
    (path: string) => () => onFilePathClick(path),
    [onFilePathClick]
  );

  return (
    <span>
      {parts.map((part, index) =>
        part.type === 'path' ? (
          <button
            key={index}
            type="button"
            onClick={handlePathClick(part.content)}
            className="text-blue-400 hover:text-blue-300 hover:underline cursor-pointer font-mono text-sm"
            aria-label={`Open file: ${part.content}`}
          >
            {part.content}
          </button>
        ) : (
          <span key={index}>{part.content}</span>
        )
      )}
    </span>
  );
});

/**
 * Pending indicator component.
 * Displays animated dots to indicate that a response is being awaited.
 */
function PendingIndicator() {
  return (
    <div
      data-testid="pending-indicator"
      className="flex items-center gap-2 text-gray-400 py-2"
    >
      <div className="flex gap-1" aria-hidden="true">
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse" />
        <span
          className="w-2 h-2 bg-gray-400 rounded-full animate-pulse"
          style={{ animationDelay: '150ms' }}
        />
        <span
          className="w-2 h-2 bg-gray-400 rounded-full animate-pulse"
          style={{ animationDelay: '300ms' }}
        />
      </div>
      <span className="text-sm">Waiting for response...</span>
    </div>
  );
}

/**
 * User message section.
 * Displays a user message with timestamp and clickable file paths.
 *
 * @param props.message - The user's chat message
 * @param props.onFilePathClick - Callback invoked when a file path is clicked
 */
const UserMessageSection = memo(function UserMessageSection({
  message,
  onFilePathClick,
  onCopy,
}: {
  message: ChatMessage;
  onFilePathClick: (path: string) => void;
  onCopy?: (content: string) => void;
}) {
  const formattedTime = useMemo(
    () => message.timestamp.toLocaleTimeString(),
    [message.timestamp]
  );

  return (
    <div className="relative bg-blue-900/30 border-l-4 border-blue-500 p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-medium text-blue-400">You</span>
        <span className="text-xs text-gray-500">{formattedTime}</span>
      </div>
      <div className="text-sm text-gray-200 whitespace-pre-wrap break-words">
        <MessageContent content={message.content} onFilePathClick={onFilePathClick} />
      </div>
      {onCopy && (
        <button
          type="button"
          data-testid="copy-user-message"
          onClick={() => onCopy(message.content)}
          className="absolute top-2 right-2 p-1 text-gray-400 hover:text-gray-200 bg-gray-800/80 rounded transition-colors"
          aria-label="Copy message"
          title="Copy"
        >
          <Copy size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
});

/**
 * Single assistant message item with optional counter.
 * Displays an individual assistant response with truncation support.
 *
 * @param props.message - The assistant's chat message
 * @param props.index - Index of this message in the array (0-based)
 * @param props.total - Total number of assistant messages in the pair
 * @param props.isExpanded - Whether the message is expanded (showing full content)
 * @param props.onFilePathClick - Callback invoked when a file path is clicked
 */
const AssistantMessageItem = memo(function AssistantMessageItem({
  message,
  index,
  total,
  isExpanded,
  onFilePathClick,
  onCopy,
}: {
  message: ChatMessage;
  index: number;
  total: number;
  isExpanded: boolean;
  onFilePathClick: (path: string) => void;
  onCopy?: (content: string) => void;
}) {
  const formattedTime = useMemo(
    () => message.timestamp.toLocaleTimeString(),
    [message.timestamp]
  );

  const { text: truncatedText, isTruncated } = useMemo(
    () => getTruncatedContent(message.content),
    [message.content]
  );

  const displayContent = isExpanded || !isTruncated ? message.content : truncatedText;

  return (
    <div className="assistant-message-item relative">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-medium text-gray-400">Assistant</span>
        <span className="text-xs text-gray-500">{formattedTime}</span>
        {total > 1 && (
          <span className="text-xs text-gray-500">
            ({index + 1}/{total})
          </span>
        )}
      </div>
      <div className="text-sm text-gray-200 whitespace-pre-wrap break-words [word-break:break-word] max-w-full overflow-x-hidden">
        <MessageContent content={displayContent} onFilePathClick={onFilePathClick} />
        {!isExpanded && isTruncated && (
          <span className="text-gray-500">...</span>
        )}
      </div>
      {onCopy && (
        <button
          type="button"
          data-testid="copy-assistant-message"
          onClick={() => onCopy(message.content)}
          className="absolute top-2 right-2 p-1 text-gray-400 hover:text-gray-200 bg-gray-800/80 rounded transition-colors"
          aria-label="Copy message"
          title="Copy"
        >
          <Copy size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
});

/**
 * Assistant messages section.
 * Renders all assistant messages in a pair with dividers between them.
 *
 * @param props.messages - Array of assistant chat messages
 * @param props.isExpanded - Whether messages are expanded (showing full content)
 * @param props.onFilePathClick - Callback invoked when a file path is clicked
 */
const AssistantMessagesSection = memo(function AssistantMessagesSection({
  messages,
  isExpanded,
  onFilePathClick,
  onCopy,
}: {
  messages: ChatMessage[];
  isExpanded: boolean;
  onFilePathClick: (path: string) => void;
  onCopy?: (content: string) => void;
}) {
  return (
    <div className="bg-gray-800/50 border-l-4 border-gray-600 p-3 border-t border-gray-700 space-y-3">
      {messages.map((message, index) => (
        <React.Fragment key={message.id}>
          {index > 0 && (
            <div
              data-testid="assistant-message-divider"
              className="border-t border-dashed border-gray-600"
            />
          )}
          <AssistantMessageItem
            message={message}
            index={index}
            total={messages.length}
            isExpanded={isExpanded}
            onFilePathClick={onFilePathClick}
            onCopy={onCopy}
          />
        </React.Fragment>
      ))}
    </div>
  );
});

/**
 * Orphan header for system messages.
 * Displays a warning indicator for assistant messages without user input.
 */
function OrphanHeader() {
  return (
    <div
      data-testid="orphan-indicator"
      className="bg-yellow-900/20 text-yellow-400 text-xs px-3 py-1 flex items-center gap-2"
    >
      <svg
        className="w-3 h-3"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      <span>System Message</span>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * ConversationPairCard component for displaying grouped conversation pairs.
 *
 * Visual states:
 * - completed: User message + Assistant response(s)
 * - pending: User message with waiting indicator
 * - orphan: Assistant message without user input (system message)
 *
 * @example
 * ```tsx
 * <ConversationPairCard
 *   pair={pair}
 *   onFilePathClick={(path) => openFile(path)}
 *   isExpanded={isExpanded}
 *   onToggleExpand={() => toggleExpand(pair.id)}
 * />
 * ```
 */
export const ConversationPairCard = memo(function ConversationPairCard({
  pair,
  onFilePathClick,
  isExpanded = false,
  onToggleExpand,
  onCopy,
}: ConversationPairCardProps) {
  // Determine if expand button should be shown
  const hasLongContent = useMemo(() => {
    return pair.assistantMessages.some((msg) => {
      const { isTruncated } = getTruncatedContent(msg.content);
      return isTruncated;
    });
  }, [pair.assistantMessages]);

  const handleToggle = useCallback(() => {
    if (onToggleExpand) {
      onToggleExpand();
    }
  }, [onToggleExpand]);

  // Build card class based on status
  const cardClassName = useMemo(() => {
    const base =
      'border border-gray-700 rounded-lg overflow-hidden mb-4 transition-colors';
    const statusClass =
      pair.status === 'pending'
        ? 'pending'
        : pair.status === 'orphan'
        ? 'orphan border-l-4 border-yellow-600'
        : '';
    return `${base} ${statusClass}`.trim();
  }, [pair.status]);

  // Truncated user message for aria-label
  const ariaLabel = useMemo(() => {
    if (pair.userMessage) {
      const preview = pair.userMessage.content.substring(0, 50);
      return `Conversation: ${preview}${pair.userMessage.content.length > 50 ? '...' : ''}`;
    }
    return 'System message';
  }, [pair.userMessage]);

  return (
    <div
      data-testid="conversation-pair-card"
      role="article"
      aria-label={ariaLabel}
      className={cardClassName}
    >
      {/* Orphan header for system messages */}
      {pair.status === 'orphan' && <OrphanHeader />}

      {/* User message section */}
      {pair.userMessage && (
        <UserMessageSection
          message={pair.userMessage}
          onFilePathClick={onFilePathClick}
          onCopy={onCopy}
        />
      )}

      {/* Assistant section */}
      {pair.status === 'pending' ? (
        <div className="bg-gray-800/30 border-l-4 border-gray-600 p-3 border-t border-gray-700">
          <PendingIndicator />
        </div>
      ) : pair.assistantMessages.length > 0 ? (
        <div className="relative">
          <AssistantMessagesSection
            messages={pair.assistantMessages}
            isExpanded={isExpanded}
            onFilePathClick={onFilePathClick}
            onCopy={onCopy}
          />
          {/* Expand/Collapse button */}
          {hasLongContent && (
            <div className="absolute top-2 right-2">
              <button
                type="button"
                onClick={handleToggle}
                className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors bg-gray-800/80 px-2 py-1 rounded"
                aria-expanded={isExpanded}
                aria-label={isExpanded ? 'Collapse message' : 'Expand message'}
              >
                <svg
                  className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
                {isExpanded ? 'Collapse' : 'Expand'}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
});

export default ConversationPairCard;
