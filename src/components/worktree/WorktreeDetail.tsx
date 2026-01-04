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
import {
  useWebSocket,
  type WebSocketMessage,
  type SessionStatusPayload,
  type BroadcastPayload,
} from '@/hooks/useWebSocket';
import type { Worktree, ChatMessage } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

export interface WorktreeDetailProps {
  worktreeId: string;
}

type TabView = 'claude' | 'codex' | 'gemini' | 'logs' | 'info' | 'memo';

const CLI_TABS: CLIToolType[] = ['claude', 'codex', 'gemini'];
const isCliTab = (tab: TabView): tab is CLIToolType => CLI_TABS.includes(tab as CLIToolType);

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
  const [activeTab, setActiveTab] = useState<TabView>('claude');
  const [waitingForResponse, setWaitingForResponse] = useState(false);
  const [isEditingMemo, setIsEditingMemo] = useState(false);
  const [memoText, setMemoText] = useState('');
  const [isEditingLink, setIsEditingLink] = useState(false);
  const [linkText, setLinkText] = useState('');
  const [showNewMessageNotification, setShowNewMessageNotification] = useState(false);
  const [generatingContent, setGeneratingContent] = useState<string>('');
  const [pendingCliTool, setPendingCliTool] = useState<CLIToolType | null>(null);
  const [realtimeOutput, setRealtimeOutput] = useState<string>('');
  const [isThinking, setIsThinking] = useState<boolean>(false);
  const [wsConnected, setWsConnected] = useState<boolean>(false);

  const resolveActiveCliTool = useCallback((): CLIToolType => {
    if (isCliTab(activeTab)) {
      return activeTab;
    }
    return worktree?.cliToolId || 'claude';
  }, [activeTab, worktree?.cliToolId]);


  /**
   * Fetch latest content from log file
   */
  const fetchFromLogFile = useCallback(async (logFileName: string): Promise<string | null> => {
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
  }, [worktreeId]);

  /**
   * Fetch messages for the active CLI tool tab
   */
  const fetchMessages = useCallback(async (cliTool?: 'claude' | 'codex' | 'gemini') => {
    try {
      setError(null);
      const targetCliTool = cliTool || resolveActiveCliTool();
      const data = await worktreeApi.getMessages(worktreeId, targetCliTool);
      setMessages(data);
    } catch (err) {
      setError(handleApiError(err));
    }
  }, [worktreeId, resolveActiveCliTool]);

  /**
   * Initial data fetch with log file sync
   */
  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);

      try {
        const worktreeData = await worktreeApi.getById(worktreeId);
        setWorktree(worktreeData);

        // Always default to claude tab on initial load
        const initialCliTool = 'claude';
        setActiveTab(initialCliTool);

        const initialMessages = await worktreeApi.getMessages(worktreeId, initialCliTool);
        setMessages(initialMessages);

        // Sync latest CLI tool message from log file (removed duplicate API call)
        const toolMessages = initialMessages.filter(
          m => m.cliToolId === initialCliTool && m.logFileName
        );
        const latestCliMessage = toolMessages
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

        if (latestCliMessage?.logFileName) {
          console.log('[Initial fetch] Syncing latest message from log file:', latestCliMessage.logFileName);
          const logContent = await fetchFromLogFile(latestCliMessage.logFileName);
          if (logContent) {
            setMessages(prevMessages =>
              prevMessages.map(msg =>
                msg.id === latestCliMessage.id
                  ? { ...msg, content: logContent }
                  : msg
              )
            );
          }
        }
      } catch (err) {
        console.error('[Initial fetch] Error fetching worktree or syncing logs:', err);
        setError(handleApiError(err));
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [worktreeId, fetchFromLogFile]);

  /**
   * Sync memo and link when worktree changes
   */
  useEffect(() => {
    if (worktree) {
      setMemoText(worktree.memo || '');
      setLinkText(worktree.link || '');
    }
  }, [worktree]);

  /**
   * Check current session status when active tab changes
   */
  useEffect(() => {
    if (activeTab === 'claude' || activeTab === 'codex' || activeTab === 'gemini') {
      fetchMessages(activeTab);

      // Check if there's an active session for this CLI tool
      const checkSessionStatus = async () => {
        try {
          const response = await fetch(`/api/worktrees/${worktreeId}/current-output?cliTool=${activeTab}`);
          if (!response.ok) {
            console.error('Failed to fetch current output:', response.status);
            return;
          }

          const data = await response.json();

          if (data.isRunning && data.isGenerating) {
            // Session is running and generating content
            setWaitingForResponse(true);
            setPendingCliTool(activeTab);
            setGeneratingContent(data.content || '');
          } else if (data.isRunning && !data.isGenerating) {
            // Session is running but not generating (waiting for user input)
            setWaitingForResponse(false);
            setPendingCliTool(null);
            setGeneratingContent('');
          } else {
            // Session is not running
            setWaitingForResponse(false);
            setPendingCliTool(null);
            setGeneratingContent('');
          }
        } catch (err) {
          console.error('Error checking session status:', err);
        }
      };

      checkSessionStatus();
    }
  }, [activeTab, worktreeId, fetchMessages]);

  /**
   * Periodically refresh messages so the user does not need to hit the Refresh button
   * Uses longer interval when WebSocket is connected (real-time updates available)
   */
  useEffect(() => {
    if (!isCliTab(activeTab)) {
      return;
    }

    let isMounted = true;

    const pollMessages = async () => {
      if (!isMounted) {
        return;
      }
      await fetchMessages(activeTab);
    };

    // Initial refresh (in addition to tab-change fetch) to ensure latest state
    pollMessages();

    // Use longer polling interval when WebSocket is connected
    // WebSocket provides real-time updates, so polling is just a fallback
    const pollingInterval = wsConnected ? 15000 : 5000;
    const interval = setInterval(pollMessages, pollingInterval);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [activeTab, fetchMessages, wsConnected]);

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
   * Memoize worktree IDs array to prevent unnecessary re-renders
   */
  const worktreeIds = React.useMemo(() => [worktreeId], [worktreeId]);

  /**
   * Handle WebSocket messages
   */
  const isSessionStatusPayload = (payload: BroadcastPayload | undefined): payload is SessionStatusPayload => {
    return Boolean(payload && payload.type === 'session_status_changed');
  };

  const isChatPayload = (payload: BroadcastPayload | undefined): payload is Extract<BroadcastPayload, { message: ChatMessage }> => {
    return Boolean(payload && 'message' in payload && payload.message);
  };

  const handleWebSocketMessage = useCallback((message: WebSocketMessage) => {
    if (isSessionStatusPayload(message.data) && message.data.worktreeId === worktreeId) {
      if (message.data.messagesCleared) {
        console.log('[WorktreeDetail] Session killed, clearing messages');
        setMessages([]);
        setWaitingForResponse(false);
        setPendingCliTool(null);
        setGeneratingContent('');
      }
    }

    if (message.type === 'broadcast' && message.worktreeId === worktreeId) {
      setWaitingForResponse(false);
      setPendingCliTool(null);
      setGeneratingContent('');
      const cliToolFromMessage = isChatPayload(message.data)
        ? message.data.message.cliToolId as CLIToolType | undefined
        : undefined;
      const targetCliTool = isCliTab(activeTab)
        ? activeTab
        : cliToolFromMessage || resolveActiveCliTool();
      fetchMessages(targetCliTool);
      setShowNewMessageNotification(true);
      setTimeout(() => setShowNewMessageNotification(false), 3000);
    }
  }, [worktreeId, activeTab, fetchMessages, resolveActiveCliTool]);

  /**
   * WebSocket for real-time updates
   */
  const { status: wsStatus } = useWebSocket({
    worktreeIds,
    onMessage: handleWebSocketMessage,
    onStatusChange: (status) => setWsConnected(status === 'connected'),
  });

  const messageListCliTool = pendingCliTool || (isCliTab(activeTab) ? activeTab : resolveActiveCliTool());

  /**
   * Poll for current tmux output continuously and refresh messages
   * Key change: Always show realtime output while session is running
   * Optimized: Uses shorter interval when waiting for response, longer when idle
   */
  useEffect(() => {
    if (!isCliTab(activeTab)) {
      return;
    }

    let isMounted = true;
    const cliToolForPolling = activeTab;
    let lastMessageCount = messages.length;

    const pollCurrentOutput = async () => {
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}/current-output?cliTool=${cliToolForPolling}`);
        if (!response.ok) {
          console.error('Failed to fetch current output:', response.status);
          return;
        }

        const data = await response.json();

        if (!isMounted) return;

        if (!data.isRunning) {
          // Session is not running - clear all states
          setWaitingForResponse(false);
          setPendingCliTool(null);
          setGeneratingContent('');
          setRealtimeOutput('');
          setIsThinking(false);
          return;
        }

        // Only fetch messages when we detect a state change or new response
        // This reduces redundant API calls (was calling every poll)
        if (data.isGenerating || waitingForResponse) {
          const updatedMessages = await worktreeApi.getMessages(worktreeId, cliToolForPolling);
          const messageCountChanged = updatedMessages.length !== lastMessageCount;

          if (messageCountChanged) {
            console.log('[Polling] Message count changed:', lastMessageCount, '->', updatedMessages.length);
            lastMessageCount = updatedMessages.length;
            setMessages(updatedMessages);

            // Check if the latest message is an assistant response (not user)
            const latestMessage = updatedMessages[updatedMessages.length - 1];
            if (latestMessage && latestMessage.role === 'assistant') {
              console.log('[Polling] Assistant response saved, hiding realtime output');
              setWaitingForResponse(false);
              setPendingCliTool(null);
              setGeneratingContent('');
              setRealtimeOutput('');
              setIsThinking(false);
              return;
            }
          }

          // Session IS running AND we're waiting for a response
          const latestMessage = updatedMessages[updatedMessages.length - 1];
          const isAwaitingResponse = latestMessage && latestMessage.role === 'user';

          if (isAwaitingResponse) {
            setWaitingForResponse(true);
            setPendingCliTool(cliToolForPolling);
            setGeneratingContent(data.content || '');
            setRealtimeOutput(data.realtimeSnippet || '');
            setIsThinking(data.thinking || false);

            if (data.isPromptWaiting) {
              setIsThinking(false);
            }
          } else {
            setWaitingForResponse(false);
            setPendingCliTool(null);
            setGeneratingContent('');
            setRealtimeOutput('');
            setIsThinking(false);
          }
        }
      } catch (err) {
        console.error('Error polling current output:', err);
      }
    };

    // Start polling immediately
    pollCurrentOutput();

    // Dynamic polling interval:
    // - 2 seconds when waiting for response (need quick updates for realtime display)
    // - 10 seconds when WebSocket connected and not waiting (WebSocket handles updates)
    // - 5 seconds otherwise (fallback polling)
    const getPollingInterval = () => {
      if (waitingForResponse) return 2000;
      if (wsConnected) return 10000;
      return 5000;
    };

    const pollInterval = setInterval(pollCurrentOutput, getPollingInterval());

    return () => {
      isMounted = false;
      clearInterval(pollInterval);
    };
  }, [activeTab, worktreeId, messages.length, waitingForResponse, wsConnected]);

  /**
   * Handle message sent
   */
  const handleMessageSent = (cliToolId?: CLIToolType) => {
    // Set waiting state when user sends a message
    const toolId = cliToolId || resolveActiveCliTool();
    setWaitingForResponse(true);
    setPendingCliTool(toolId);
    setGeneratingContent('');
    fetchMessages(toolId);
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
            <Link href={`/worktrees/${worktreeId}/simple-terminal`}>
              <Button variant="primary" size="sm">
                🖥️ Terminal
              </Button>
            </Link>
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
          <Link href={`/worktrees/${worktreeId}/simple-terminal`}>
            <Button variant="primary" size="sm">
              🖥️
            </Button>
          </Link>
        </div>
      </div>

          {/* Tab Navigation */}
          <div className="mb-0 border-b border-gray-200 overflow-x-auto">
            <nav className="flex gap-6 min-w-max">
          <button
            onClick={() => setActiveTab('claude')}
            className={`pb-3 px-4 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'claude'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            Claude
          </button>
          <button
            onClick={() => setActiveTab('codex')}
            className={`pb-3 px-4 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'codex'
                ? 'border-yellow-600 text-yellow-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            Codex
          </button>
          <button
            onClick={() => setActiveTab('gemini')}
            className={`pb-3 px-4 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'gemini'
                ? 'border-green-600 text-green-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            Gemini
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
      {(activeTab === 'claude' || activeTab === 'codex' || activeTab === 'gemini') && (
        <div className="flex-1 flex flex-col w-full max-w-7xl mx-auto relative">
          {/* New Message Notification */}
          {showNewMessageNotification && (
            <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-20 bg-blue-600 text-white px-4 py-2 rounded-full shadow-lg animate-fade-in">
              <span className="text-sm font-medium">新しいメッセージがあります</span>
            </div>
          )}

          {/* Message List */}
          <div className="flex-1 w-full">
            <MessageList
              messages={messages}
              worktreeId={worktree!.id}
              loading={false}
              waitingForResponse={waitingForResponse}
              generatingContent={generatingContent}
              realtimeOutput={realtimeOutput}
              isThinking={isThinking}
              selectedCliTool={messageListCliTool}
            />
          </div>

          {/* Message Input */}
          <div className="sticky bottom-0 flex-shrink-0 w-full bg-gray-50 border-t border-gray-200">
            <div className="px-4 sm:px-6 lg:px-8 pb-4 pt-2">
              <MessageInput
                worktreeId={worktreeId}
                onMessageSent={handleMessageSent}
                cliToolId={activeTab as 'claude' | 'codex' | 'gemini'}
              />
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
