/**
 * MessageList Component
 * Displays chat message history for a worktree
 */

'use client';

import React, { useRef, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import type { ChatMessage } from '@/types/models';
import { format } from 'date-fns';
import { ja } from 'date-fns/locale';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { PromptMessage } from './PromptMessage';

export interface MessageListProps {
  messages: ChatMessage[];
  worktreeId: string;
  loading?: boolean;
  waitingForResponse?: boolean;
  generatingContent?: string;
  selectedCliTool?: string;
}

/**
 * Message bubble component
 */
function MessageBubble({
  message,
  onFilePathClick
}: {
  message: ChatMessage;
  onFilePathClick: (path: string) => void;
}) {
  const isUser = message.role === 'user';
  const timestamp = format(new Date(message.timestamp), 'PPp', { locale: ja });

  // Get CLI tool display name
  const getToolName = (cliToolId?: string) => {
    switch (cliToolId) {
      case 'claude':
        return 'Claude';
      case 'codex':
        return 'Codex';
      case 'gemini':
        return 'Gemini';
      default:
        return 'Assistant';
    }
  };

  /**
   * Memoized markdown components to prevent re-renders
   */
  const markdownComponents = useMemo(() => {
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
              onFilePathClick(filePath);
            }}
            className={`underline hover:no-underline font-mono transition-colors break-all inline ${
              isUser ? 'text-blue-100 hover:text-white' : 'text-blue-600 hover:text-blue-800'
            }`}
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

    return {
      p: ({ children, ...props }: any) => {
        if (!isUser) {
          return <p {...props}>{processChildren(children)}</p>;
        }
        return <p {...props}>{children}</p>;
      }
    };
  }, [isUser, onFilePathClick]);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div className={`max-w-[80%] ${isUser ? 'order-2' : 'order-1'}`}>
        <div
          className={`rounded-lg px-4 py-3 ${
            isUser
              ? 'bg-blue-600 text-white'
              : 'bg-white border border-gray-200'
          }`}
        >
          {/* Header */}
          <div className="flex items-center gap-2 mb-2">
            <span className={`text-xs font-medium ${isUser ? 'text-blue-100' : 'text-gray-500'}`}>
              {isUser ? 'You' : getToolName(message.cliToolId)}
            </span>
            <span className={`text-xs ${isUser ? 'text-blue-200' : 'text-gray-400'}`}>
              {timestamp}
            </span>
          </div>

          {/* Content */}
          <div className={`prose prose-sm max-w-none break-words overflow-wrap-anywhere ${isUser ? 'prose-invert' : ''}`}>
            {message.summary && (
              <div className={`text-sm font-medium mb-2 ${isUser ? 'text-blue-50' : 'text-gray-700'}`}>
                {message.summary}
              </div>
            )}
            <div className={`break-words overflow-wrap-anywhere ${isUser ? 'text-white' : 'text-gray-900'}`}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={markdownComponents}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          </div>

          {/* Log file link */}
          {message.logFileName && (
            <div className="mt-2 pt-2 border-t border-opacity-20">
              <a
                href={`/api/worktrees/${message.worktreeId}/logs/${message.logFileName}`}
                target="_blank"
                rel="noopener noreferrer"
                className={`text-xs ${isUser ? 'text-blue-100 hover:text-white' : 'text-blue-600 hover:text-blue-700'}`}
              >
                View log file →
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

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
  generatingContent = '',
  selectedCliTool = 'claude',
}: MessageListProps) {
  const router = useRouter();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Get CLI tool display name
  const getToolName = (cliToolId?: string) => {
    switch (cliToolId) {
      case 'claude':
        return 'Claude';
      case 'codex':
        return 'Codex';
      case 'gemini':
        return 'Gemini';
      default:
        return 'Assistant';
    }
  };

  // Auto-scroll to bottom when new messages arrive or content is generating
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, generatingContent]);

  /**
   * Handle file path click - navigate to full screen file viewer
   */
  const handleFilePathClick = useCallback((path: string) => {
    router.push(`/worktrees/${worktreeId}/files/${path}`);
  }, [router, worktreeId]);

  /**
   * Handle prompt response
   */
  const handlePromptResponse = async (messageId: string, answer: string) => {
    const response = await fetch(`/api/worktrees/${worktreeId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, answer }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to send response');
    }

    // Message will be updated via WebSocket broadcast
  };

  if (loading) {
    return (
      <Card padding="lg">
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-gray-300 border-t-blue-600" />
          <p className="mt-4 text-gray-600">Loading messages...</p>
        </div>
      </Card>
    );
  }

  if (messages.length === 0) {
    return (
      <Card padding="lg">
        <div className="text-center py-8">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
          <p className="mt-4 text-gray-600">No messages yet</p>
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
            />
          );
        })}

        {/* Show "Waiting for response" indicator with generating content */}
        {waitingForResponse && (
          <div className="flex justify-start mb-4">
            <div className="max-w-[80%] w-full">
              <div className="rounded-lg px-4 py-3 bg-white border border-gray-200 shadow-sm">
                {/* Header with generating indicator */}
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs font-medium text-gray-500">{getToolName(selectedCliTool)}</span>
                  <div className="flex gap-1">
                    <div className="w-1.5 h-1.5 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-1.5 h-1.5 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-1.5 h-1.5 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>

                {/* Progress indicator - fixed at top */}
                <div className="sticky top-0 bg-white z-10 pb-2 mb-3 border-b border-gray-200">
                  {/* Stage 1: Waiting */}
                  <div className={`flex items-center gap-2 mb-2 ${!generatingContent ? 'opacity-100' : 'opacity-50'}`}>
                    <div className={`w-2 h-2 rounded-full ${!generatingContent ? 'bg-blue-600 animate-pulse' : 'bg-green-500'}`} />
                    <span className="text-sm font-medium text-gray-700">応答を待機中</span>
                    {!generatingContent && <span className="text-xs text-gray-500 ml-auto">...</span>}
                    {generatingContent && <span className="text-xs text-green-600 ml-auto">✓</span>}
                  </div>

                  {/* Stage 2: Generating */}
                  {generatingContent && (
                    <div className="flex items-center gap-2 mb-2 opacity-100">
                      <div className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
                      <span className="text-sm font-medium text-gray-700">最新状態（生成中）</span>
                      <span className="text-xs text-gray-500 ml-auto">更新中...</span>
                    </div>
                  )}
                </div>

                {/* Generating content area */}
                {generatingContent ? (
                  <div className="space-y-3">
                    {/* Latest content */}
                    <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">最新の出力</span>
                        <span className="text-xs text-gray-400">{new Date().toLocaleTimeString('ja-JP')}</span>
                      </div>
                      <div className="prose prose-sm max-w-none break-words overflow-wrap-anywhere text-gray-900">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          rehypePlugins={[rehypeHighlight]}
                        >
                          {generatingContent}
                        </ReactMarkdown>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-4">
                    <p className="text-sm text-gray-500">応答を待っています...</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}
