/**
 * WorktreeDetail Component
 * Main component for worktree detail page
 */

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent, Badge, Button } from '@/components/ui';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { LogViewer } from './LogViewer';
import { worktreeApi, handleApiError } from '@/lib/api-client';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { Worktree, ChatMessage } from '@/types/models';

export interface WorktreeDetailProps {
  worktreeId: string;
}

type TabView = 'messages' | 'logs' | 'info' | 'memo';

/**
 * Worktree detail page component
 *
 * @example
 * ```tsx
 * <WorktreeDetail worktreeId="main" />
 * ```
 */
export function WorktreeDetail({ worktreeId }: WorktreeDetailProps) {
  const [worktree, setWorktree] = useState<Worktree | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabView>('messages');
  const [waitingForResponse, setWaitingForResponse] = useState(false);
  const [isEditingMemo, setIsEditingMemo] = useState(false);
  const [memoText, setMemoText] = useState('');
  const [isEditingLink, setIsEditingLink] = useState(false);
  const [linkText, setLinkText] = useState('');
  const [showNewMessageNotification, setShowNewMessageNotification] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [generatingContent, setGeneratingContent] = useState<string>('');

  /**
   * Fetch worktree data
   */
  const fetchWorktree = useCallback(async () => {
    try {
      setError(null);
      const data = await worktreeApi.getById(worktreeId);
      setWorktree(data);
    } catch (err) {
      setError(handleApiError(err));
    }
  }, [worktreeId]);

  /**
   * Fetch messages
   */
  const fetchMessages = useCallback(async () => {
    try {
      setError(null);
      const data = await worktreeApi.getMessages(worktreeId);
      setMessages(data);
    } catch (err) {
      setError(handleApiError(err));
    }
  }, [worktreeId]);

  /**
   * Initial data fetch with log file sync
   */
  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);

      // Fetch worktree and messages from database
      await Promise.all([fetchWorktree(), fetchMessages()]);

      // Then sync latest Claude message from log file
      try {
        const updatedMessages = await worktreeApi.getMessages(worktreeId);
        const claudeMessages = updatedMessages.filter(m => m.role === 'assistant' && m.logFileName);
        const latestClaudeMessage = claudeMessages
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

        if (latestClaudeMessage?.logFileName) {
          console.log('[Initial fetch] Syncing latest message from log file:', latestClaudeMessage.logFileName);
          const logContent = await fetchFromLogFile(latestClaudeMessage.logFileName);
          if (logContent) {
            setMessages(prevMessages =>
              prevMessages.map(msg =>
                msg.id === latestClaudeMessage.id
                  ? { ...msg, content: logContent }
                  : msg
              )
            );
          }
        }
      } catch (err) {
        console.error('[Initial fetch] Error syncing from log file:', err);
        // Don't show error to user, just log it
      }

      setLoading(false);
    };

    fetchData();
  }, [fetchWorktree, fetchMessages, worktreeId]);

  /**
   * Sync memo and link text when worktree changes
   */
  useEffect(() => {
    if (worktree) {
      setMemoText(worktree.memo || '');
      setLinkText(worktree.link || '');
    }
  }, [worktree]);

  /**
   * Save memo
   */
  const handleSaveMemo = async () => {
    try {
      setError(null);
      const updated = await worktreeApi.updateMemo(worktreeId, memoText);
      setWorktree(updated);
      setIsEditingMemo(false);
    } catch (err) {
      setError(handleApiError(err));
    }
  };

  /**
   * Cancel memo edit
   */
  const handleCancelMemo = () => {
    setMemoText(worktree?.memo || '');
    setIsEditingMemo(false);
  };

  /**
   * Save link
   */
  const handleSaveLink = async () => {
    try {
      setError(null);
      const updated = await worktreeApi.updateLink(worktreeId, linkText);
      setWorktree(updated);
      setIsEditingLink(false);
    } catch (err) {
      setError(handleApiError(err));
    }
  };

  /**
   * Cancel link editing
   */
  const handleCancelLink = () => {
    setLinkText(worktree?.link || '');
    setIsEditingLink(false);
  };

  /**
   * Fetch latest content from log file
   */
  const fetchFromLogFile = async (logFileName: string): Promise<string | null> => {
    try {
      console.log('[fetchFromLogFile] Fetching log file:', logFileName);
      const response = await fetch(`/api/worktrees/${worktreeId}/logs/${logFileName}`);
      console.log('[fetchFromLogFile] Response status:', response.status);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('[fetchFromLogFile] Failed to fetch:', response.status, errorData);
        return null;
      }
      const data = await response.json();
      console.log('[fetchFromLogFile] Successfully fetched, content length:', data.content?.length || 0);
      return data.content || null;
    } catch (err) {
      console.error('[fetchFromLogFile] Error:', err);
      return null;
    }
  };

  /**
   * Handle manual refresh with log file sync
   */
  const handleManualRefresh = async () => {
    console.log('[handleManualRefresh] Starting manual refresh...');
    setIsRefreshing(true);

    try {
      // First, fetch messages from DB
      setError(null);
      const updatedMessages = await worktreeApi.getMessages(worktreeId);
      console.log('[handleManualRefresh] Fetched messages from DB:', updatedMessages.length);
      setMessages(updatedMessages);

      // Then, sync the latest Claude message from log file
      const claudeMessages = updatedMessages.filter(m => m.role === 'assistant' && m.logFileName);
      console.log('[handleManualRefresh] Claude messages with logFileName:', claudeMessages.length);

      const latestClaudeMessage = claudeMessages
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

      if (latestClaudeMessage?.logFileName) {
        console.log('[handleManualRefresh] Latest Claude message:', {
          id: latestClaudeMessage.id,
          logFileName: latestClaudeMessage.logFileName,
          timestamp: latestClaudeMessage.timestamp,
          currentContentLength: latestClaudeMessage.content.length
        });

        const logContent = await fetchFromLogFile(latestClaudeMessage.logFileName);
        if (logContent) {
          console.log('[handleManualRefresh] Updating message content');
          // Update the message content with log file content
          setMessages(prevMessages =>
            prevMessages.map(msg =>
              msg.id === latestClaudeMessage.id
                ? { ...msg, content: logContent }
                : msg
            )
          );
        } else {
          console.warn('[handleManualRefresh] No log content received');
        }
      } else {
        console.warn('[handleManualRefresh] No latest Claude message with logFileName found');
      }

      // Show brief notification
      setShowNewMessageNotification(true);
      setTimeout(() => setShowNewMessageNotification(false), 2000);
    } catch (err) {
      console.error('[handleManualRefresh] Error:', err);
      setError(handleApiError(err));
    } finally {
      setIsRefreshing(false);
      console.log('[handleManualRefresh] Refresh complete');
    }
  };

  /**
   * Memoize worktree IDs array to prevent unnecessary re-renders
   */
  const worktreeIds = React.useMemo(() => [worktreeId], [worktreeId]);

  /**
   * Handle WebSocket messages
   */
  const handleWebSocketMessage = useCallback((message: any) => {
    if (message.type === 'broadcast' && message.worktreeId === worktreeId) {
      // Claude response received - clear waiting state
      setWaitingForResponse(false);
      // Refresh data when updates occur
      fetchMessages();
      // Show notification
      setShowNewMessageNotification(true);
      setTimeout(() => setShowNewMessageNotification(false), 3000);
    } else if (message.data?.type === 'session_status_changed' && message.data.worktreeId === worktreeId) {
      // Session was killed - check if messages should be cleared
      if (message.data.messagesCleared) {
        console.log('[WorktreeDetail] Session killed, clearing messages');
        setMessages([]);
        setWaitingForResponse(false);
        setGeneratingContent('');
      }
    }
  }, [worktreeId, fetchMessages]);

  /**
   * WebSocket for real-time updates
   */
  const { status: wsStatus } = useWebSocket({
    worktreeIds,
    onMessage: handleWebSocketMessage,
  });

  /**
   * Poll for current tmux output while waiting for response
   */
  useEffect(() => {
    if (!waitingForResponse) {
      setGeneratingContent('');
      return;
    }

    let pollInterval: NodeJS.Timeout;
    let isMounted = true;

    const pollCurrentOutput = async () => {
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}/current-output`);
        if (!response.ok) {
          console.error('Failed to fetch current output:', response.status);
          return;
        }

        const data = await response.json();

        if (!isMounted) return;

        if (data.isRunning && data.isGenerating) {
          // Update generating content with new content
          setGeneratingContent(data.content || '');
        }

        if (data.isComplete) {
          // Response is complete - stop polling and fetch final messages
          setWaitingForResponse(false);
          setGeneratingContent('');
          fetchMessages();
        }
      } catch (err) {
        console.error('Error polling current output:', err);
      }
    };

    // Start polling immediately
    pollCurrentOutput();

    // Then poll every 2.5 seconds
    pollInterval = setInterval(pollCurrentOutput, 2500);

    return () => {
      isMounted = false;
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [waitingForResponse, worktreeId, fetchMessages]);

  /**
   * Handle message sent
   */
  const handleMessageSent = () => {
    // Set waiting state when user sends a message
    setWaitingForResponse(true);
    setGeneratingContent('');
    fetchMessages();
  };

  if (loading) {
    return (
      <div className="container-custom py-8">
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-gray-300 border-t-blue-600" />
          <p className="mt-4 text-gray-600">Loading worktree...</p>
        </div>
      </div>
    );
  }

  if (error && !worktree) {
    return (
      <div className="container-custom py-8">
        <Card padding="lg">
          <div className="text-center py-8">
            <svg
              className="mx-auto h-12 w-12 text-red-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <p className="mt-4 text-red-600">{error}</p>
            <Link href="/" className="mt-4 inline-block">
              <Button variant="secondary">Back to Home</Button>
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Fixed Header Container */}
      <div className="sticky top-0 z-10 bg-gray-50">
        <div className="container-custom py-4 md:py-8">
          {/* Header - Hidden on mobile */}
          <div className="mb-4 md:mb-6 hidden md:block">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-blue-600 hover:text-blue-700 flex-shrink-0">
              ← Back
            </Link>
            <h1 className="mb-0">{worktree?.name}</h1>
          </div>
          <div className="flex items-center gap-2">
            {wsStatus === 'connected' && (
              <Badge variant="success" dot>
                Live
              </Badge>
            )}
            <Button variant="secondary" size="sm" onClick={() => fetchMessages()}>
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {/* Mobile Header - Compact */}
      <div className="mb-3 md:hidden flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Link href="/" className="text-blue-600 hover:text-blue-700 text-sm flex-shrink-0">
            ← Back
          </Link>
          <h1 className="text-lg font-semibold truncate">{worktree?.name}</h1>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {wsStatus === 'connected' && (
            <Badge variant="success" dot>
              Live
            </Badge>
          )}
          <Button variant="secondary" size="sm" onClick={() => fetchMessages()}>
            Refresh
          </Button>
        </div>
      </div>

          {/* Tab Navigation */}
          <div className="mb-0 border-b border-gray-200">
            <nav className="flex gap-6">
          <button
            onClick={() => setActiveTab('messages')}
            className={`pb-3 px-4 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'messages'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            Messages
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className={`pb-3 px-4 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'logs'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            Log
          </button>
          <button
            onClick={() => setActiveTab('info')}
            className={`pb-3 px-4 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'info'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            Information
          </button>
          <button
            onClick={() => setActiveTab('memo')}
            className={`pb-3 px-4 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'memo'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            Memo
          </button>
            </nav>
          </div>
        </div>
      </div>

      {/* Content */}
      {activeTab === 'messages' && (
        <div className="flex-1 flex flex-col relative">
          {/* New Message Notification */}
          {showNewMessageNotification && (
            <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-20 bg-blue-600 text-white px-4 py-2 rounded-full shadow-lg animate-fade-in">
              <span className="text-sm font-medium">新しいメッセージがあります</span>
            </div>
          )}

          {/* Manual Refresh Button */}
          <button
            onClick={handleManualRefresh}
            disabled={isRefreshing}
            className="fixed bottom-24 right-6 z-20 bg-blue-600 hover:bg-blue-700 text-white p-3 rounded-full shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            title="最新のメッセージを取得"
          >
            {isRefreshing ? (
              <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            ) : (
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            )}
          </button>

          {/* Message List - constrained width to match tabs */}
          <div className="flex-1 w-full max-w-7xl mx-auto">
            <MessageList
              messages={messages}
              worktreeId={worktree!.id}
              loading={false}
              waitingForResponse={waitingForResponse}
              generatingContent={generatingContent}
            />
          </div>

          {/* Message Input - constrained width to match tabs */}
          <div className="sticky bottom-0 flex-shrink-0 w-full max-w-7xl mx-auto bg-gray-50 border-t border-gray-200">
            <div className="px-4 sm:px-6 lg:px-8 pb-4 pt-2">
              <MessageInput worktreeId={worktreeId} onMessageSent={handleMessageSent} />
            </div>
          </div>
        </div>
      )}

      <div className="w-full max-w-7xl mx-auto px-4 py-4 flex-shrink-0">
        {activeTab === 'logs' && <LogViewer worktreeId={worktreeId} />}

        {activeTab === 'info' && (
          <Card padding="lg">
            <CardHeader>
              <CardTitle>Information</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-6 max-w-none">
                <div>
                  <dt className="text-sm font-medium text-gray-500 mb-2">Branch</dt>
                  <dd className="text-base font-medium text-gray-900">{worktree?.name}</dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-gray-500 mb-2">Path</dt>
                  <dd className="text-base font-mono text-gray-900 break-all">{worktree?.path}</dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-gray-500 mb-2">Messages</dt>
                  <dd className="text-base font-medium text-gray-900">{messages.length}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        )}

        {activeTab === 'memo' && (
          <div className="space-y-6">
            {/* Memo Section */}
            <Card padding="lg">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Memo</CardTitle>
                  {!isEditingMemo && (
                    <Button variant="ghost" size="sm" onClick={() => setIsEditingMemo(true)}>
                      Edit
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {isEditingMemo ? (
                  <div className="space-y-3">
                    <textarea
                      value={memoText}
                      onChange={(e) => setMemoText(e.target.value)}
                      placeholder="Add notes about this branch..."
                      className="input w-full min-h-[300px] resize-y"
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <Button variant="primary" size="sm" onClick={handleSaveMemo}>
                        Save
                      </Button>
                      <Button variant="secondary" size="sm" onClick={handleCancelMemo}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="min-h-[200px] max-w-none">
                    {worktree?.memo ? (
                      <p className="text-base text-gray-700 whitespace-pre-wrap leading-relaxed">{worktree.memo}</p>
                    ) : (
                      <p className="text-base text-gray-400 italic">No memo added yet</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Link Section */}
            <Card padding="lg">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Link</CardTitle>
                  {!isEditingLink && (
                    <Button variant="ghost" size="sm" onClick={() => setIsEditingLink(true)}>
                      Edit
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {isEditingLink ? (
                  <div className="space-y-3">
                    <input
                      type="url"
                      value={linkText}
                      onChange={(e) => setLinkText(e.target.value)}
                      placeholder="https://example.com (e.g., issue tracker, PR, documentation)"
                      className="input w-full"
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <Button variant="primary" size="sm" onClick={handleSaveLink}>
                        Save
                      </Button>
                      <Button variant="secondary" size="sm" onClick={handleCancelLink}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="min-h-[100px] max-w-none">
                    {worktree?.link ? (
                      <a
                        href={worktree.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 hover:underline"
                      >
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                          />
                        </svg>
                        <span className="text-base">{worktree.link}</span>
                      </a>
                    ) : (
                      <p className="text-base text-gray-400 italic">No link added yet</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
