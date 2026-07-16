/**
 * ConversationPairCard Component
 *
 * Displays a conversation pair (user message + assistant responses) as a single card.
 * Supports completed, pending, and orphan states with appropriate visual styling.
 */

'use client';

import React, { useMemo, useCallback, memo } from 'react';
import { Copy, ArrowDownToLine, ChevronDown, Loader2, AlertCircle, RotateCcw, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { ConversationPair } from '@/types/conversation';
import type { ChatMessage } from '@/types/models';
import { getDateFnsLocale } from '@/lib/date-locale';
import { formatMessageTimestamp } from '@/lib/date-utils';

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
  /** Issue #485: Callback when user message is inserted into message input */
  onInsertToMessage?: (content: string) => void;
  /**
   * Issue #725: Whether to render the assistant messages section.
   *
   * Defaults to `true` (preserves existing behavior). When set to `false`
   * (e.g. by the HistoryPane "User only" filter toggle), the
   * AssistantMessagesSection is not rendered even if assistant messages
   * exist in the pair.
   */
  showAssistant?: boolean;
  /**
   * Issue #1121: Called with the message id (tempId) to re-send an
   * optimistic message whose send failed. Only reachable on error bubbles.
   */
  onRetryPending?: (tempId: string) => void;
  /**
   * Issue #1121: Called with the message id (tempId) to discard an
   * optimistic message whose send failed. Only reachable on error bubbles.
   */
  onDiscardPending?: (tempId: string) => void;
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

/**
 * Maximum characters to show in collapsed state.
 *
 * Issue #725: Reduced from 300 to 100 to strengthen default-collapse so that
 * long assistant responses do not dominate the History pane visually.
 */
const COLLAPSED_MAX_CHARS = 100;

/**
 * Maximum lines to show in collapsed state.
 *
 * Issue #725: Reduced from 5 to 2 so that collapsed assistant messages
 * occupy at most 2 lines visually, matching the visual hierarchy goal.
 */
const COLLAPSED_MAX_LINES = 2;

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
  const t = useTranslations('worktree');
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
            className="text-accent-700 dark:text-accent-400 hover:text-accent-600 dark:hover:text-accent-300 hover:underline cursor-pointer font-mono text-sm"
            aria-label={t('conversation.openFile', { path: part.content })}
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
  const t = useTranslations('worktree');
  return (
    <div
      data-testid="pending-indicator"
      className="flex items-center gap-2 text-muted-foreground py-2"
    >
      <div className="flex gap-1" aria-hidden="true">
        <span className="w-2 h-2 bg-muted-foreground rounded-full animate-pulse" />
        <span
          className="w-2 h-2 bg-muted-foreground rounded-full animate-pulse"
          style={{ animationDelay: '150ms' }}
        />
        <span
          className="w-2 h-2 bg-muted-foreground rounded-full animate-pulse"
          style={{ animationDelay: '300ms' }}
        />
      </div>
      <span className="text-sm">{t('conversation.waitingForResponse')}</span>
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
  onInsertToMessage,
  onRetryPending,
  onDiscardPending,
}: {
  message: ChatMessage;
  onFilePathClick: (path: string) => void;
  onCopy?: (content: string) => void;
  onInsertToMessage?: (content: string) => void;
  onRetryPending?: (tempId: string) => void;
  onDiscardPending?: (tempId: string) => void;
}) {
  const locale = useLocale();
  const t = useTranslations('worktree');
  const tCommon = useTranslations('common');
  const dateFnsLocale = getDateFnsLocale(locale);
  const formattedTime = formatMessageTimestamp(message.timestamp, dateFnsLocale);

  // Issue #1121: optimistic send state drives the bubble's styling and actions.
  const sendState = message.optimisticState;
  const sectionClassName = [
    'group relative border-l-2 p-3 transition-opacity',
    sendState === 'error'
      ? 'border-danger-border bg-danger-subtle'
      : 'border-accent-500 bg-accent-500/10',
    sendState === 'sending' ? 'opacity-70' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={sectionClassName}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-medium text-accent-700 dark:text-accent-400">{t('conversation.you')}</span>
        <span className="text-xs text-muted-foreground">{formattedTime}</span>
        {/* Issue #1121: send-state chip (before the action toolbar). */}
        {sendState === 'sending' && (
          <span
            data-testid="optimistic-sending"
            className="flex items-center gap-1 text-xs text-muted-foreground"
          >
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            <span>{t('conversation.sending')}</span>
          </span>
        )}
        {sendState === 'error' && (
          <span
            data-testid="optimistic-error"
            className="flex items-center gap-1 text-xs text-danger-foreground"
          >
            <AlertCircle size={12} aria-hidden="true" />
            <span>{t('conversation.failedToSend')}</span>
          </span>
        )}
        {/* Issue #1121: on a failed send, retry/discard replace the hover toolbar
            and stay always-visible so recovery actions are reachable on touch too. */}
        {sendState === 'error' ? (
          <div className="ml-auto flex items-center gap-1">
            {onRetryPending && (
              <button
                type="button"
                data-testid="pending-retry"
                onClick={() => onRetryPending(message.id)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-accent-700 dark:text-accent-400 hover:bg-muted transition-colors"
                aria-label={t('conversation.retrySending')}
                title={tCommon('retry')}
              >
                <RotateCcw size={12} aria-hidden="true" />
                {tCommon('retry')}
              </button>
            )}
            {onDiscardPending && (
              <button
                type="button"
                data-testid="pending-discard"
                onClick={() => onDiscardPending(message.id)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-danger-foreground hover:bg-muted transition-colors"
                aria-label={t('conversation.discardMessage')}
                title={t('conversation.discard')}
              >
                <X size={12} aria-hidden="true" />
                {t('conversation.discard')}
              </button>
            )}
          </div>
        ) : (
          /* Persistent mini-toolbar: reveal on hover/focus (desktop), pinned to the
             row's right edge so actions never overlap the message body. On touch
             devices (no hover) it stays visible so copy/insert remain reachable
             (Issue #1075). */
          <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            {onInsertToMessage && (
              <button
                type="button"
                data-testid="insert-user-message"
                onClick={() => onInsertToMessage(message.content)}
                className="p-1 text-muted-foreground hover:text-accent-600 dark:hover:text-accent-400 hover:bg-muted rounded transition-colors"
                aria-label={t('conversation.insertToMessage')}
                title={t('conversation.insertToMessage')}
              >
                <ArrowDownToLine size={14} aria-hidden="true" />
              </button>
            )}
            {onCopy && (
              <button
                type="button"
                data-testid="copy-user-message"
                onClick={() => onCopy(message.content)}
                className="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
                aria-label={t('conversation.copyMessage')}
                title={t('conversation.copy')}
              >
                <Copy size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>
      <div
        data-message-id={message.id}
        className="text-sm text-foreground whitespace-pre-wrap break-words [word-break:break-word] max-w-full overflow-x-hidden"
      >
        <MessageContent content={message.content} onFilePathClick={onFilePathClick} />
      </div>
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
  hasLongContent = false,
  onToggleExpand,
}: {
  message: ChatMessage;
  index: number;
  total: number;
  isExpanded: boolean;
  onFilePathClick: (path: string) => void;
  onCopy?: (content: string) => void;
  /** Issue #1075: show the pair-level expand toggle on the first item's header. */
  hasLongContent?: boolean;
  onToggleExpand?: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations('worktree');
  const dateFnsLocale = getDateFnsLocale(locale);
  const formattedTime = formatMessageTimestamp(message.timestamp, dateFnsLocale);

  const { text: truncatedText, isTruncated } = useMemo(
    () => getTruncatedContent(message.content),
    [message.content]
  );

  const displayContent = isExpanded || !isTruncated ? message.content : truncatedText;
  // The expand/collapse control governs the whole pair, so render it once on the
  // first assistant item's header (Issue #1075: moved out of the body overlay).
  const showExpandToggle = index === 0 && hasLongContent && !!onToggleExpand;

  return (
    <div className="assistant-message-item group relative">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-medium text-muted-foreground">{t('conversation.assistant')}</span>
        <span className="text-xs text-muted-foreground">{formattedTime}</span>
        {total > 1 && (
          <span className="text-xs text-muted-foreground">
            ({index + 1}/{total})
          </span>
        )}
        {/* Persistent mini-toolbar pinned right; keeps actions off the body.
            Stays visible on touch devices (no hover) so expand/copy work there. */}
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          {showExpandToggle && (
            <button
              type="button"
              onClick={onToggleExpand}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-accent-700 dark:text-accent-400 hover:text-accent-600 dark:hover:text-accent-300 hover:bg-muted transition-colors"
              aria-expanded={isExpanded}
              aria-label={isExpanded ? t('conversation.collapseMessage') : t('conversation.expandMessage')}
            >
              <ChevronDown
                size={12}
                className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
              {isExpanded ? t('conversation.collapse') : t('conversation.expand')}
            </button>
          )}
          {onCopy && (
            <button
              type="button"
              data-testid="copy-assistant-message"
              onClick={() => onCopy(message.content)}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
              aria-label={t('conversation.copyMessage')}
              title={t('conversation.copy')}
            >
              <Copy size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <div
        data-message-id={message.id}
        className="text-xs text-foreground whitespace-pre-wrap break-words [word-break:break-word] max-w-full overflow-x-hidden"
      >
        <MessageContent content={displayContent} onFilePathClick={onFilePathClick} />
        {!isExpanded && isTruncated && (
          <span className="text-muted-foreground">...</span>
        )}
      </div>
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
  hasLongContent = false,
  onToggleExpand,
}: {
  messages: ChatMessage[];
  isExpanded: boolean;
  onFilePathClick: (path: string) => void;
  onCopy?: (content: string) => void;
  hasLongContent?: boolean;
  onToggleExpand?: () => void;
}) {
  return (
    <div className="bg-surface-2/50 border-l-2 border-border p-2 border-t border-border space-y-2">
      {messages.map((message, index) => (
        <React.Fragment key={message.id}>
          {index > 0 && (
            <div
              data-testid="assistant-message-divider"
              className="border-t border-dashed border-border"
            />
          )}
          <AssistantMessageItem
            message={message}
            index={index}
            total={messages.length}
            isExpanded={isExpanded}
            onFilePathClick={onFilePathClick}
            onCopy={onCopy}
            hasLongContent={hasLongContent}
            onToggleExpand={onToggleExpand}
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
  const t = useTranslations('worktree');
  return (
    <div
      data-testid="orphan-indicator"
      className="bg-warning/10 text-warning-foreground text-xs px-3 py-1 flex items-center gap-2"
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
      <span>{t('conversation.systemMessage')}</span>
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
  onInsertToMessage,
  showAssistant = true,
  onRetryPending,
  onDiscardPending,
}: ConversationPairCardProps) {
  const t = useTranslations('worktree');
  // Issue #1121: an optimistic (unsent / failed) user message drives special
  // styling and suppresses the "Waiting for response…" block — it is not yet
  // waiting on the assistant, it is waiting on the server to confirm the send.
  const isOptimistic = pair.userMessage?.optimisticState !== undefined;

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
      'border border-border rounded-lg overflow-hidden mb-4 transition-colors';
    const statusClass =
      pair.status === 'pending'
        ? 'pending'
        : pair.status === 'orphan'
        ? 'orphan border-l-4 border-warning'
        : '';
    return `${base} ${statusClass}`.trim();
  }, [pair.status]);

  // Truncated user message for aria-label. Not memoized: `t` churns identity
  // every render (Issue #1219), so a deps array holding it would recompute
  // anyway — and omitting it would freeze the label on a locale switch.
  const ariaLabel = pair.userMessage
    ? t('conversation.conversationLabel', {
        preview: `${pair.userMessage.content.substring(0, 50)}${
          pair.userMessage.content.length > 50 ? '...' : ''
        }`,
      })
    : t('conversation.systemMessageLabel');

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
          onInsertToMessage={onInsertToMessage}
          onRetryPending={onRetryPending}
          onDiscardPending={onDiscardPending}
        />
      )}

      {/* Assistant section */}
      {pair.status === 'pending' && !isOptimistic ? (
        <div className="bg-muted/40 border-l-2 border-border p-3 border-t border-border">
          <PendingIndicator />
        </div>
      ) : showAssistant && pair.assistantMessages.length > 0 ? (
        <AssistantMessagesSection
          messages={pair.assistantMessages}
          isExpanded={isExpanded}
          onFilePathClick={onFilePathClick}
          onCopy={onCopy}
          hasLongContent={hasLongContent}
          onToggleExpand={handleToggle}
        />
      ) : null}
    </div>
  );
});

export default ConversationPairCard;
