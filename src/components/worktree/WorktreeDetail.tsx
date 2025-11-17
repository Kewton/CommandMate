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

type TabView = 'messages' | 'logs';

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
   * Initial data fetch
   */
  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      await Promise.all([fetchWorktree(), fetchMessages()]);
      setLoading(false);
    };

    fetchData();
  }, [fetchWorktree, fetchMessages]);

  /**
   * WebSocket for real-time updates
   */
  const { status: wsStatus } = useWebSocket({
    worktreeIds: [worktreeId],
    onMessage: (message) => {
      if (message.type === 'broadcast' && message.worktreeId === worktreeId) {
        // Claude response received - clear waiting state
        setWaitingForResponse(false);
        // Refresh data when updates occur
        fetchMessages();
      }
    },
  });

  /**
   * Handle message sent
   */
  const handleMessageSent = () => {
    // Set waiting state when user sends a message
    setWaitingForResponse(true);
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
    <div className="container-custom py-8">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <Link href="/" className="text-blue-600 hover:text-blue-700">
            ← Back
          </Link>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="mb-2">{worktree?.name}</h1>
            <p className="text-gray-600 font-mono text-sm">{worktree?.path}</p>
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

      {/* Tab Navigation */}
      <div className="mb-6 border-b border-gray-200">
        <nav className="flex gap-4">
          <button
            onClick={() => setActiveTab('messages')}
            className={`pb-3 px-1 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'messages'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            Messages
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className={`pb-3 px-1 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'logs'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            Log Files
          </button>
        </nav>
      </div>

      {/* Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {activeTab === 'messages' && (
            <>
              <MessageList
                messages={messages}
                worktreeId={worktree.id}
                loading={false}
                waitingForResponse={waitingForResponse}
              />
              <Card padding="lg">
                <CardHeader>
                  <CardTitle>Send Message</CardTitle>
                </CardHeader>
                <CardContent>
                  <MessageInput worktreeId={worktreeId} onMessageSent={handleMessageSent} />
                </CardContent>
              </Card>
            </>
          )}

          {activeTab === 'logs' && <LogViewer worktreeId={worktreeId} />}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Worktree Info */}
          <Card padding="lg">
            <CardHeader>
              <CardTitle>Information</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3">
                <div>
                  <dt className="text-xs text-gray-500">Branch</dt>
                  <dd className="text-sm font-medium text-gray-900">{worktree?.name}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Path</dt>
                  <dd className="text-sm font-mono text-gray-900 break-all">{worktree?.path}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Messages</dt>
                  <dd className="text-sm font-medium text-gray-900">{messages.length}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          {/* Quick Actions */}
          <Card padding="lg">
            <CardHeader>
              <CardTitle>Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button variant="secondary" fullWidth size="sm">
                Open in Terminal
              </Button>
              <Button variant="secondary" fullWidth size="sm">
                Open in VS Code
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
