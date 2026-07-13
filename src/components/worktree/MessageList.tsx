/**
 * MessageList Component
 * Displays chat message history for a worktree
 *
 * Issue #1117: Visual language unified with ConversationPairCard
 * (semantic/status tint tokens, lucide-react icons, hover-reveal toolbar
 * with touch fallback). Structure and optimistic-update logic preserved.
 */

'use client';

import React, { useRef, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Check, CircleCheck, Clock, Copy, Loader2, MessageCircle, X } from 'lucide-react';
import { Card } from '@/components/ui';
import type { ChatMessage } from '@/types/models';
import { useTranslations, useLocale } from 'next-intl';
import { getDateFnsLocale } from '@/lib/date-locale';
import { formatMessageTimestamp } from '@/lib/date-utils';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { PromptMessage } from './PromptMessage';
import AnsiToHtml from 'ansi-to-html';
import { getCliToolDisplayNameSafe } from '@/lib/cli-tools/types';

// Module-level constants to prevent ReactMarkdown DOM rebuilds on re-render
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

/**
 * File-path link style shared by user/assistant content, matching
 * ConversationPairCard's MessageContent link treatment.
 */
const FILE_LINK_CLASSES =
  'text-accent-700 dark:text-accent-400 hover:text-accent-600 dark:hover:text-accent-300 hover:underline font-mono transition-colors break-all inline';

/**
 * Hover-reveal mini-toolbar (ConversationPairCard language). Stays visible on
 * touch devices (no hover) so actions remain reachable.
 */
const TOOLBAR_CLASSES =
  'ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100';

export interface MessageListProps {
  messages: ChatMessage[];
  worktreeId: string;
  loading?: boolean;
  waitingForResponse?: boolean;
  generatingContent?: string;
  realtimeOutput?: string;
  isThinking?: boolean;
  selectedCliTool?: string;
  /** Issue #36: Callback for optimistic update when user clicks Yes/No */
  onOptimisticUpdate?: (message: ChatMessage) => void;
  /** Issue #36: Callback to rollback optimistic update on API failure */
  onOptimisticRollback?: (messages: ChatMessage[]) => void;
}

/**
 * Message bubble props interface
 */
interface MessageBubbleProps {
  message: ChatMessage;
  onFilePathClick: (path: string) => void;
  onPromptRespond?: (messageId: string, answer: string) => void;
}

// Check if content contains ANSI escape codes
const hasAnsiCodes = (text: string): boolean => {
  return /\x1b\[[0-9;]*m|\[[0-9;]*m/.test(text);
};

// Convert ANSI codes to HTML (always-dark island — matches the fixed terminal
// theme, so the raw hex values here are intentional; see docs/design-system.md)
const convertAnsiToHtml = (text: string): string => {
  const convert = new AnsiToHtml({
    fg: '#d1d5db',
    bg: '#1f2937',
    newline: true,
    escapeXML: true,
  });
  return convert.toHtml(text);
};

/**
 * Message bubble component (Memoized)
 * Issue #36: React.memo prevents unnecessary re-renders when message updates occur
 * Custom comparison function only compares id, content, and promptData status/answer
 */
const MessageBubble = React.memo(function MessageBubble({
  message,
  onFilePathClick,
  onPromptRespond
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const locale = useLocale();
  const dateFnsLocale = getDateFnsLocale(locale);
  const tPrompt = useTranslations('prompt');
  const tCommon = useTranslations('common');
  const timestamp = formatMessageTimestamp(new Date(message.timestamp), dateFnsLocale);

  // State for handling text input options
  const [selectedTextInputOption, setSelectedTextInputOption] = React.useState<number | null>(null);
  const [textInputValue, setTextInputValue] = React.useState('');

  const handleCopy = useCallback(() => {
    void navigator.clipboard?.writeText(message.content).catch(() => {
      // Clipboard unavailable (e.g. insecure context) — silently ignore
    });
  }, [message.content]);

  // Use ref to stabilize onFilePathClick reference for markdownComponents.
  // This prevents ReactMarkdown from rebuilding DOM when parent re-renders.
  const onFilePathClickRef = useRef(onFilePathClick);
  onFilePathClickRef.current = onFilePathClick;

  /**
   * Memoized markdown components to prevent re-renders.
   * Uses ref for onFilePathClick so deps are stable.
   */
  const markdownComponents = useMemo<Components>(() => {
    /**
     * Detect and linkify file paths in text
     * Matches patterns like: src/components/Foo.tsx, src/lib/bar.ts:123, etc.
     */
    const renderTextWithFileLinks = (text: string): React.ReactNode[] => {
      // File path pattern: matches common file paths with extensions
      // Examples: src/components/Foo.tsx, lib/utils.ts, path/to/file.js:123
      const filePathPattern = /\b([\w\-./]+\/[\w\-./]+\.\w+)(?::(\d+))?/g;

      const parts: React.ReactNode[] = [];
      let lastIndex = 0;
      let match;

      while ((match = filePathPattern.exec(text)) !== null) {
        const fullMatch = match[0];
        const filePath = match[1];

        // Add text before the match
        if (match.index > lastIndex) {
          parts.push(text.substring(lastIndex, match.index));
        }

        // Add clickable file link
        parts.push(
          <button
            key={`file-${match.index}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onFilePathClickRef.current(filePath);
            }}
            className={FILE_LINK_CLASSES}
          >
            {fullMatch}
          </button>
        );

        lastIndex = match.index + fullMatch.length;
      }

      // Add remaining text
      if (lastIndex < text.length) {
        parts.push(text.substring(lastIndex));
      }

      return parts.length > 0 ? parts : [text];
    };

    /**
     * Process children recursively to find and linkify file paths
     */
    const processChildren = (children: React.ReactNode): React.ReactNode => {
      if (typeof children === 'string') {
        const parts = renderTextWithFileLinks(children);
        return parts.length === 1 && typeof parts[0] === 'string' ? children : <>{parts}</>;
      }

      if (Array.isArray(children)) {
        return children.map((child, index) => (
          <React.Fragment key={index}>{processChildren(child)}</React.Fragment>
        ));
      }

      return children;
    };

    const components: Components = {
      p: ({ children, ...props }) => {
        return <p {...props}>{processChildren(children)}</p>;
      }
    };

    return components;
  }, []);

  return (
    <div className="border border-border rounded-lg overflow-hidden mb-4 transition-colors">
      <div
        className={`group relative p-3 border-l-2 ${
          isUser ? 'border-accent-500 bg-accent-500/10' : 'border-border bg-surface-2/50'
        }`}
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-1">
          <span
            className={`text-xs font-medium ${
              isUser ? 'text-accent-700 dark:text-accent-400' : 'text-muted-foreground'
            }`}
          >
            {isUser ? 'You' : getCliToolDisplayNameSafe(message.cliToolId)}
          </span>
          <span className="text-xs text-muted-foreground">{timestamp}</span>
          <div className={TOOLBAR_CLASSES}>
            <button
              type="button"
              data-testid={isUser ? 'copy-user-message' : 'copy-assistant-message'}
              onClick={handleCopy}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
              aria-label="Copy message"
              title="Copy"
            >
              <Copy size={14} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Content */}
        {message.summary && (
          <div className="text-sm font-medium mb-2 text-foreground">
            {message.summary}
          </div>
        )}
        <div className="text-sm text-foreground break-words [word-break:break-word] max-w-full overflow-x-hidden">
          {hasAnsiCodes(message.content) ? (
            <pre
              className="whitespace-pre-wrap font-mono text-sm bg-[#0d1117] text-[#c9d1d9] p-4 rounded overflow-x-auto"
              dangerouslySetInnerHTML={{ __html: convertAnsiToHtml(message.content) }}
            />
          ) : (
            <div className="assistant-md text-sm leading-6">
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={markdownComponents}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          )}
        </div>

        {/* Log file link */}
        {message.logFileName && (
          <div className="mt-2 pt-2 border-t border-border">
            <a
              href={`/api/worktrees/${message.worktreeId}/logs/${message.logFileName}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-accent-700 dark:text-accent-400 hover:text-accent-600 dark:hover:text-accent-300 hover:underline"
            >
              View log file →
            </a>
          </div>
        )}

        {/* Prompt choice buttons for assistant messages */}
        {!isUser && message.promptData && onPromptRespond && (
          <div className="mt-3 pt-3 border-t border-border">
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-warning-subtle text-warning-foreground border border-warning-border">
                {tPrompt('awaitingSelection')}
              </span>
              <div className="text-sm text-foreground font-medium">
                {message.promptData.question}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {message.promptData.type === 'yes_no' ? (
                <>
                  <button
                    onClick={() => onPromptRespond(message.id, 'yes')}
                    disabled={message.promptData.status === 'answered'}
                    className="px-5 py-2.5 bg-accent-600 text-white rounded-lg hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all font-medium text-sm shadow-sm hover:shadow-md flex items-center gap-2"
                  >
                    <Check size={16} aria-hidden="true" />
                    {tPrompt('yes')}
                  </button>
                  <button
                    onClick={() => onPromptRespond(message.id, 'no')}
                    disabled={message.promptData.status === 'answered'}
                    className="px-5 py-2.5 bg-surface text-foreground border-2 border-input rounded-lg hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-all font-medium text-sm shadow-sm hover:shadow-md flex items-center gap-2"
                  >
                    <X size={16} aria-hidden="true" />
                    {tPrompt('no')}
                  </button>
                </>
              ) : message.promptData.type === 'multiple_choice' ? (
                <>
                  {message.promptData.options.map((option) => (
                    <button
                      key={option.number}
                      onClick={() => {
                        if (option.requiresTextInput) {
                          // For text input options, select the option (don't send immediately)
                          setSelectedTextInputOption(option.number);
                          setTextInputValue('');
                        } else {
                          // For regular options, send immediately
                          onPromptRespond(message.id, option.number.toString());
                        }
                      }}
                      disabled={message.promptData?.status === 'answered'}
                      className={`px-5 py-2.5 rounded-lg transition-all font-medium text-sm shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed ${
                        selectedTextInputOption === option.number
                          ? 'bg-accent-600 text-white hover:bg-accent-700 ring-2 ring-ring'
                          : option.isDefault
                          ? 'bg-accent-600 text-white hover:bg-accent-700 ring-2 ring-accent-400/50'
                          : 'bg-surface text-foreground hover:bg-muted border border-input'
                      }`}
                    >
                      <span className="inline-flex items-center gap-2">
                        <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                          selectedTextInputOption === option.number || option.isDefault
                            ? 'bg-accent-500 text-white'
                            : 'bg-muted text-muted-foreground'
                        }`}>
                          {option.number}
                        </span>
                        {option.label}
                      </span>
                    </button>
                  ))}

                  {/* Text input field for selected text input option */}
                  {selectedTextInputOption !== null && message.promptData?.status === 'pending' && (
                    <div className="w-full mt-3 p-4 bg-surface-2 border border-border rounded-lg">
                      <label className="block text-sm font-medium text-foreground mb-2">
                        {tPrompt('enterCustomMessage')}:
                      </label>
                      <textarea
                        value={textInputValue}
                        onChange={(e) => setTextInputValue(e.target.value)}
                        placeholder={tPrompt('enterMessageHere')}
                        rows={3}
                        className="w-full px-3 py-2 bg-surface text-foreground border border-input rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-accent-500 text-sm"
                      />
                      <div className="flex gap-2 mt-3">
                        <button
                          onClick={() => {
                            if (textInputValue.trim()) {
                              onPromptRespond(message.id, textInputValue.trim());
                              setSelectedTextInputOption(null);
                              setTextInputValue('');
                            }
                          }}
                          disabled={!textInputValue.trim()}
                          className="px-4 py-2 bg-accent-600 text-white rounded-lg hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all font-medium text-sm shadow-sm hover:shadow-md"
                        >
                          {tCommon('send')}
                        </button>
                        <button
                          onClick={() => {
                            setSelectedTextInputOption(null);
                            setTextInputValue('');
                          }}
                          className="px-4 py-2 bg-muted text-foreground rounded-lg hover:bg-muted/80 transition-all font-medium text-sm"
                        >
                          {tCommon('cancel')}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : null}
            </div>
            {message.promptData.status === 'answered' && message.promptData.answer && (
              <div className="mt-3 flex items-center gap-2 text-sm text-success-foreground bg-success-subtle border border-success-border px-3 py-2 rounded-lg">
                <CircleCheck size={16} aria-hidden="true" />
                {tPrompt('answered')}: {message.promptData.answer}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // Issue #36: Custom comparison function for React.memo
  // Only re-render when these specific properties change
  return (
    prevProps.message.id === nextProps.message.id &&
    prevProps.message.content === nextProps.message.content &&
    prevProps.message.promptData?.status === nextProps.message.promptData?.status &&
    prevProps.message.promptData?.answer === nextProps.message.promptData?.answer
  );
});

/**
 * List of chat messages
 *
 * @example
 * ```tsx
 * <MessageList messages={messages} loading={false} waitingForResponse={false} />
 * ```
 */
export function MessageList({
  messages,
  worktreeId,
  loading = false,
  waitingForResponse = false,
  generatingContent: _generatingContent = '',
  realtimeOutput = '',
  isThinking = false,
  selectedCliTool = 'claude',
  onOptimisticUpdate,
  onOptimisticRollback,
}: MessageListProps) {
  const router = useRouter();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const tWorktree = useTranslations('worktree');

  // Track previous message count to detect new messages
  const prevMessageCountRef = useRef(messages.length);
  // Issue #131: Track previous worktreeId to detect worktree changes
  const prevWorktreeIdRef = useRef<string | undefined>(worktreeId);

  // Auto-scroll to bottom when new messages arrive or worktree changes
  // Issue #131: Use 'instant' scroll when switching worktrees to avoid animation during navigation
  useEffect(() => {
    const isWorktreeChange = prevWorktreeIdRef.current !== worktreeId;

    // Scroll when message count increases (new message added) or when worktree changes
    if (messages.length > prevMessageCountRef.current || isWorktreeChange) {
      messagesEndRef.current?.scrollIntoView({
        behavior: isWorktreeChange ? 'instant' : 'smooth'
      });
    }

    prevMessageCountRef.current = messages.length;
    prevWorktreeIdRef.current = worktreeId;
  }, [messages.length, worktreeId]);

  /**
   * Handle file path click - navigate to full screen file viewer
   */
  const handleFilePathClick = useCallback((path: string) => {
    router.push(`/worktrees/${worktreeId}/files/${path}`);
  }, [router, worktreeId]);

  /**
   * Handle prompt response with Optimistic Update
   * Issue #36: Immediately updates UI when user clicks Yes/No, rolls back on API failure
   */
  const handlePromptResponse = useCallback(async (messageId: string, answer: string) => {
    // 1. Store original messages for potential rollback
    const originalMessages = messages;
    const targetMessage = messages.find((msg) => msg.id === messageId);

    // Validate target message
    if (!targetMessage?.promptData) {
      // Target message not found or has no promptData - skip silently
      return;
    }

    // 2. Optimistic Update: Immediately update UI
    const optimisticMessage: ChatMessage = {
      ...targetMessage,
      promptData: {
        ...targetMessage.promptData,
        status: 'answered' as const,
        answer,
        answeredAt: new Date().toISOString(),
      },
    };

    // Notify parent component of optimistic update
    if (onOptimisticUpdate) {
      onOptimisticUpdate(optimisticMessage);
    }

    try {
      // 3. API call
      const response = await fetch(`/api/worktrees/${worktreeId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, answer }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to send response');
      }

      // Success: WebSocket will confirm the update (already optimistically applied)

    } catch (error) {
      // 4. Rollback on failure
      console.error('[MessageList] Failed to send prompt response:', error);
      if (onOptimisticRollback) {
        onOptimisticRollback(originalMessages);
      }
      // Re-throw to allow calling code to handle if needed
      throw error;
    }
  }, [messages, worktreeId, onOptimisticUpdate, onOptimisticRollback]);

  if (loading) {
    return (
      <Card padding="lg">
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-input border-t-accent-600" />
          <p className="mt-4 text-muted-foreground">Loading messages...</p>
        </div>
      </Card>
    );
  }

  if (messages.length === 0) {
    return (
      <Card padding="lg">
        <div className="text-center py-8">
          <MessageCircle size={48} className="mx-auto text-muted-foreground" aria-hidden="true" />
          <p className="mt-4 text-muted-foreground">No messages yet</p>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4">
      <div className="py-4">
        {messages.map((message) => {
          // Render prompt message
          if (message.messageType === 'prompt') {
            return (
              <PromptMessage
                key={message.id}
                message={message}
                worktreeId={worktreeId}
                onRespond={(answer) => handlePromptResponse(message.id, answer)}
              />
            );
          }

          // Render normal message
          return (
            <MessageBubble
              key={message.id}
              message={message}
              onFilePathClick={handleFilePathClick}
              onPromptRespond={handlePromptResponse}
            />
          );
        })}

        {/* Show realtime output while session is running */}
        {waitingForResponse && (
          <div className="border border-border rounded-lg overflow-hidden mb-4 transition-colors">
            <div className="border-l-2 border-border bg-surface-2/50 p-3">
              {/* Header with status indicator */}
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-medium text-muted-foreground">{getCliToolDisplayNameSafe(selectedCliTool)}</span>
                <div className="flex gap-1">
                  <div className="w-1.5 h-1.5 bg-success rounded-full animate-pulse" />
                </div>
                <span className="text-xs text-success-foreground font-medium">{tWorktree('session.running')}</span>
              </div>

              {/* Progress indicator - fixed at top */}
              <div className="sticky top-0 bg-surface z-10 pb-2 mb-3 border-b border-border">
                {/* Thinking indicator */}
                {isThinking && (
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 rounded-full bg-info animate-pulse" />
                    <span className="text-sm font-medium text-info-foreground">{tWorktree('status.thinking')}</span>
                    <span className="text-xs text-info-foreground/70 ml-auto">{tWorktree('status.thinkingStatus')}</span>
                  </div>
                )}

                {/* Active output indicator */}
                {!isThinking && realtimeOutput && (
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
                    <span className="text-sm font-medium text-success-foreground">{tWorktree('output.latest')}</span>
                    <span className="text-xs text-success-foreground/70 ml-auto">{tWorktree('output.realtimeUpdate')}</span>
                  </div>
                )}

                {/* Starting up indicator */}
                {!isThinking && !realtimeOutput && (
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse" />
                    <span className="text-sm font-medium text-foreground">{tWorktree('session.starting')}</span>
                    <span className="text-xs text-muted-foreground ml-auto">...</span>
                  </div>
                )}
              </div>

              {/* Realtime output area */}
              {realtimeOutput ? (
                <div className="space-y-3">
                  {/* Latest content */}
                  <div className="p-3 bg-success-subtle rounded-lg border border-success-border">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-success-foreground uppercase tracking-wide flex items-center gap-1">
                        <Clock size={12} aria-hidden="true" />
                        {tWorktree('output.latest')}
                      </span>
                      <span className="text-xs text-success-foreground/70">{new Date().toLocaleTimeString()}</span>
                    </div>
                    <div className="break-words [word-break:break-word] max-w-full">
                      {hasAnsiCodes(realtimeOutput) ? (
                        <pre
                          className="whitespace-pre-wrap font-mono text-xs bg-[#0d1117] text-[#c9d1d9] p-3 rounded overflow-x-auto max-h-[500px] overflow-y-auto"
                          dangerouslySetInnerHTML={{ __html: convertAnsiToHtml(realtimeOutput) }}
                        />
                      ) : (
                        <div className="text-sm text-foreground whitespace-pre-wrap font-mono max-h-[500px] overflow-y-auto">
                          {realtimeOutput}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : isThinking ? (
                <div className="text-center py-6">
                  <div className="inline-flex items-center gap-2 text-info-foreground">
                    <Loader2 size={20} className="animate-spin" aria-hidden="true" />
                    <p className="text-sm font-medium">{tWorktree('status.claudeIsThinking')}</p>
                  </div>
                </div>
              ) : (
                <div className="text-center py-6">
                  <div className="inline-flex items-center gap-2 text-muted-foreground">
                    <div className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse" />
                    <p className="text-sm">{tWorktree('session.startingEllipsis')}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}
