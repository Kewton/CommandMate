/**
 * AssistantChatPanel Component
 * Home page chat-first Assistant Chat UI.
 */

'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { AssistantMessageInput } from './AssistantMessageInput';
import { AssistantMessageList } from './AssistantMessageList';
import { assistantApi } from '@/lib/api/assistant-api';
import type { AssistantToolInfo } from '@/lib/api/assistant-api';
import { GLOBAL_POLL_INTERVAL_MS } from '@/lib/session/global-session-constants';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type {
  AssistantConversation,
  AssistantMessage,
} from '@/lib/db/assistant-conversation-db';

const CLI_TOOL_KEY = 'commandmate-assistant-cli-tool';
const ASSISTANT_ALLOWED_TOOLS: readonly CLIToolType[] = ['claude', 'codex'];

function isAssistantAllowedTool(value: string): value is CLIToolType {
  return (ASSISTANT_ALLOWED_TOOLS as readonly string[]).includes(value);
}

interface RepositoryOption {
  id: string;
  path: string;
  name: string;
  displayName?: string;
}

export function AssistantChatPanel() {
  const [repositories, setRepositories] = useState<RepositoryOption[]>([]);
  const [availableTools, setAvailableTools] = useState<AssistantToolInfo[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [selectedTool, setSelectedTool] = useState<CLIToolType>('claude');
  const [conversation, setConversation] = useState<AssistantConversation | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [clearing, setClearing] = useState(false);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const conversationActive = conversation?.status === 'ready' || conversation?.status === 'running';
  const executionRunning = conversation?.status === 'running';
  const canSend = conversation?.status === 'ready';
  const selectedRepository = repositories.find((repo) => repo.id === selectedRepoId);
  const allowedTools = useMemo(
    () => availableTools.filter((tool) => isAssistantAllowedTool(tool.id)),
    [availableTools],
  );
  const selectedToolInfo = allowedTools.find((tool) => tool.id === selectedTool);
  const assistantLabel = selectedToolInfo?.name ?? selectedTool;

  const loadMessages = useCallback(async (conversationId: string) => {
    const nextMessages = await assistantApi.getMessages(conversationId);
    setMessages(nextMessages);
  }, []);

  const loadConversation = useCallback(async () => {
    if (!selectedRepoId) {
      setConversation(null);
      setMessages([]);
      return;
    }

    const nextConversation = await assistantApi.getConversation(selectedRepoId, selectedTool);
    setConversation(nextConversation);
    if (nextConversation) {
      await loadMessages(nextConversation.id);
    } else {
      setMessages([]);
    }
  }, [loadMessages, selectedRepoId, selectedTool]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedTool = localStorage.getItem(CLI_TOOL_KEY);
      if (savedTool && isAssistantAllowedTool(savedTool)) {
        setSelectedTool(savedTool);
      }
    }
  }, []);

  useEffect(() => {
    async function fetchRepos() {
      try {
        const res = await fetch('/api/worktrees');
        if (!res.ok) {
          return;
        }
        const data = await res.json();
        const repos: RepositoryOption[] = (data.repositories ?? []).map(
          (repo: { id: string; path: string; name: string; displayName?: string }) => ({
            id: repo.id,
            path: repo.path,
            name: repo.name,
            displayName: repo.displayName,
          }),
        );
        setRepositories(repos);
        if (repos.length > 0) {
          setSelectedRepoId((prev) => prev || repos[0].id);
        }
      } catch {
        // Silent fetch failure
      }
    }

    async function fetchTools() {
      const tools = await assistantApi.getInstalledTools();
      setAvailableTools(tools);

      const supportedTools = tools.filter((tool) => isAssistantAllowedTool(tool.id));
      const installedTool = supportedTools.find((tool) => tool.installed);
      if (installedTool) {
        setSelectedTool((prev) => {
          const prevTool = supportedTools.find((tool) => tool.id === prev);
          return prevTool?.installed ? prev : installedTool.id;
        });
      }
    }

    void fetchRepos();
    void fetchTools();
  }, []);

  useEffect(() => {
    if (!selectedRepoId) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const nextConversation = await assistantApi.getConversation(selectedRepoId, selectedTool);
        if (cancelled) {
          return;
        }

        setConversation(nextConversation);
        if (nextConversation) {
          const nextMessages = await assistantApi.getMessages(nextConversation.id);
          if (!cancelled) {
            setMessages(nextMessages);
          }
        } else {
          setMessages([]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load conversation');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedRepoId, selectedTool]);

  useEffect(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    if (!conversation) {
      return;
    }

    const poll = async () => {
      try {
        await loadConversation();
      } catch {
        // Silent poll failure
      }
    };

    void poll();
    pollIntervalRef.current = setInterval(poll, GLOBAL_POLL_INTERVAL_MS);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [conversation?.id, loadConversation, conversation]);

  const handleToolChange = useCallback((tool: CLIToolType) => {
    if (!isAssistantAllowedTool(tool)) {
      return;
    }
    setSelectedTool(tool);
    if (typeof window !== 'undefined') {
      localStorage.setItem(CLI_TOOL_KEY, tool);
    }
  }, []);

  const handleStart = useCallback(async () => {
    if (!selectedRepoId || starting) {
      return;
    }

    setStarting(true);
    setError(null);
    try {
      const result = await assistantApi.startSession(selectedTool, selectedRepoId);
      setConversation(result.conversation);
      await loadMessages(result.conversation.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start session');
    } finally {
      setStarting(false);
    }
  }, [loadMessages, selectedRepoId, selectedTool, starting]);

  const handleStop = useCallback(async () => {
    if (!conversation || stopping) {
      return;
    }

    setStopping(true);
    setError(null);
    try {
      await assistantApi.stopSession(selectedTool, conversation.id);
      await loadConversation();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop session');
    } finally {
      setStopping(false);
    }
  }, [conversation, loadConversation, selectedTool, stopping]);

  const handleClearHistory = useCallback(async () => {
    if (!conversation || clearing || executionRunning) {
      return;
    }

    const confirmed = window.confirm(
      'Clear all chat history for this repository and CLI? Past messages will no longer be sent back to the assistant.',
    );
    if (!confirmed) {
      return;
    }

    setClearing(true);
    setError(null);
    try {
      await assistantApi.clearMessages(conversation.id);
      await loadConversation();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear history');
    } finally {
      setClearing(false);
    }
  }, [clearing, conversation, executionRunning, loadConversation]);

  const handleSendMessage = useCallback(
    async (message: string) => {
      if (!conversation || !canSend) {
        return;
      }

      setError(null);
      try {
        await assistantApi.sendCommand(selectedTool, conversation.id, message);
        setConversation((prev) => (prev ? { ...prev, status: 'running' } : prev));
        await Promise.all([
          loadMessages(conversation.id),
          loadConversation(),
        ]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to send message');
        throw err;
      }
    },
    [canSend, conversation, loadConversation, loadMessages, selectedTool],
  );

  const handleEditMessage = useCallback(
    async (target: AssistantMessage, newContent: string) => {
      if (!conversation || !canSend) {
        throw new Error('Session is not ready to resend messages');
      }

      setError(null);
      await assistantApi.clearMessages(conversation.id, { fromMessageId: target.id });
      await assistantApi.sendCommand(selectedTool, conversation.id, newContent);
      setConversation((prev) => (prev ? { ...prev, status: 'running' } : prev));
      await Promise.all([
        loadMessages(conversation.id),
        loadConversation(),
      ]);
    },
    [canSend, conversation, loadConversation, loadMessages, selectedTool],
  );

  const handleRepoChange = useCallback(
    async (newRepoId: string) => {
      if (conversationActive) {
        const confirmed = window.confirm(
          'Changing repository will stop the active conversation. Do you want to continue?',
        );
        if (!confirmed) {
          return;
        }

        try {
          await assistantApi.stopSession(selectedTool, conversation.id);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to stop session');
          return;
        }
      }

      setSelectedRepoId(newRepoId);
      setError(null);
    },
    [conversation, conversationActive, selectedTool],
  );

  return (
    <div
      className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950/95 shadow-lg shadow-slate-950/20"
      data-testid="assistant-chat-panel"
    >
      <div
        className="flex h-[78vh] min-h-[34rem] max-h-[48rem] flex-col gap-4 overflow-hidden bg-gradient-to-br from-slate-950 via-slate-900 to-cyan-950/80 p-4"
      >
          <div className="flex flex-col gap-1">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto]">
              <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-300">
                Repository to Work In
              </span>
              <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-300">
                Assistant CLI
              </span>
              <span className="hidden md:block" />
            </div>

            <div className="grid gap-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto] md:items-center">
              <select
                value={selectedRepoId}
                onChange={(e) => void handleRepoChange(e.target.value)}
                disabled={repositories.length === 0}
                className="w-full rounded-lg border border-slate-600 bg-slate-100 px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 disabled:cursor-not-allowed disabled:bg-slate-300"
                data-testid="assistant-repo-select"
              >
                {repositories.length === 0 && <option value="">No repositories</option>}
                {repositories.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.displayName || repo.name}
                  </option>
                ))}
              </select>

              <select
                value={selectedTool}
                onChange={(e) => handleToolChange(e.target.value as CLIToolType)}
                disabled={conversationActive}
                className="w-full rounded-lg border border-slate-600 bg-slate-100 px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 disabled:cursor-not-allowed disabled:bg-slate-300"
                data-testid="assistant-tool-select"
              >
                {allowedTools.map((tool) => (
                  <option key={tool.id} value={tool.id} disabled={!tool.installed}>
                    {tool.name}{!tool.installed ? ' (not installed)' : ''}
                  </option>
                ))}
              </select>

              <div>
                {!conversationActive ? (
                  <button
                    onClick={handleStart}
                    disabled={!selectedRepoId || starting}
                    className="w-full rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition-colors hover:bg-cyan-400 disabled:bg-slate-500 disabled:text-slate-300 md:w-auto"
                    data-testid="assistant-start-button"
                  >
                    {starting ? 'Starting...' : 'Start'}
                  </button>
                ) : (
                  <button
                    onClick={handleStop}
                    disabled={stopping}
                    className="w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:bg-slate-500 disabled:text-slate-300 md:w-auto"
                    data-testid="assistant-stop-button"
                  >
                    {stopping ? 'Stopping...' : 'Stop'}
                  </button>
                )}
              </div>
            </div>

            <p className="text-xs text-slate-300">
              {selectedRepository
                ? `Start directory: ${selectedRepository.displayName || selectedRepository.name} (${selectedRepository.path})`
                : 'Select the repository used as the assistant session start directory.'}
            </p>
          </div>

          {error && (
            <div className="rounded border border-red-800 bg-red-950/40 p-2 text-sm text-red-200">
              {error}
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
            <div className="flex shrink-0 items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-[0.14em] text-slate-400">
                History
              </span>
              <button
                type="button"
                onClick={handleClearHistory}
                disabled={!conversation || clearing || executionRunning || messages.length === 0}
                className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900/80 px-2.5 py-1 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-slate-900/40 disabled:text-slate-500"
                data-testid="assistant-clear-button"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
                {clearing ? 'Clearing...' : 'Clear history'}
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              <AssistantMessageList
                messages={messages}
                assistantLabel={assistantLabel}
                sessionActive={conversationActive}
                waitingForResponse={executionRunning}
                canEdit={canSend}
                onEditMessage={handleEditMessage}
              />
            </div>

            <div className="shrink-0">
              <AssistantMessageInput
                onSend={handleSendMessage}
                disabled={!canSend}
                placeholder={canSend ? 'Type your message... (Enter to send)' : conversationActive ? 'Waiting for the current run to finish' : 'Start a session first'}
              />
            </div>
          </div>
      </div>
    </div>
  );
}
