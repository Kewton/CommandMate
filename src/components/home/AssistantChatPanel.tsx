/**
 * AssistantChatPanel Component
 * Issue #649: Main assistant chat panel for the Home page.
 *
 * Features:
 * - Collapsible panel (max 50vh when expanded)
 * - Repository selection dropdown
 * - CLI tool selection
 * - Terminal output display with polling
 * - Session start/stop controls
 * - Dark mode support
 * - Mobile responsive layout
 */

'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AssistantMessageInput } from './AssistantMessageInput';
import { assistantApi } from '@/lib/api/assistant-api';
import type { AssistantToolInfo } from '@/lib/api/assistant-api';
import { GLOBAL_POLL_INTERVAL_MS } from '@/lib/session/global-session-constants';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';

/** localStorage key for panel collapsed state */
const COLLAPSED_KEY = 'commandmate-assistant-collapsed';

/** localStorage key for selected CLI tool */
const CLI_TOOL_KEY = 'commandmate-assistant-cli-tool';

interface RepositoryOption {
  path: string;
  name: string;
  displayName?: string;
}

export function AssistantChatPanel() {
  const [collapsed, setCollapsed] = useState(true);
  const [repositories, setRepositories] = useState<RepositoryOption[]>([]);
  const [availableTools, setAvailableTools] = useState<AssistantToolInfo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [selectedTool, setSelectedTool] = useState<CLIToolType>('claude');
  const [sessionActive, setSessionActive] = useState(false);
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Restore collapsed state from localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(COLLAPSED_KEY);
      if (saved !== null) {
        setCollapsed(saved === 'true');
      }
      const savedTool = localStorage.getItem(CLI_TOOL_KEY);
      if (savedTool && (CLI_TOOL_IDS as readonly string[]).includes(savedTool)) {
        setSelectedTool(savedTool as CLIToolType);
      }
    }
  }, []);

  // Fetch repositories and installed tools
  useEffect(() => {
    async function fetchRepos() {
      try {
        const res = await fetch('/api/worktrees');
        if (res.ok) {
          const data = await res.json();
          const repos: RepositoryOption[] = (data.repositories ?? []).map(
            (r: { path: string; name: string; displayName?: string }) => ({
              path: r.path,
              name: r.name,
              displayName: r.displayName,
            }),
          );
          setRepositories(repos);
          if (repos.length > 0 && !selectedRepo) {
            setSelectedRepo(repos[0].path);
          }
        }
      } catch {
        // Silently handle fetch errors
      }
    }

    async function fetchTools() {
      const tools = await assistantApi.getInstalledTools();
      if (tools.length > 0) {
        setAvailableTools(tools);
        // Update selectedTool to first installed tool if current is not installed
        const installedTool = tools.find((t) => t.installed);
        if (installedTool) {
          setSelectedTool((prev) => {
            const prevInstalled = tools.find((t) => t.id === prev)?.installed;
            return prevInstalled ? prev : installedTool.id;
          });
        }
      }
    }

    void fetchRepos();
    void fetchTools();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Polling for output
  useEffect(() => {
    if (!sessionActive) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }

    const poll = async () => {
      try {
        const data = await assistantApi.getCurrentOutput(selectedTool);
        setOutput(data.output);
        if (!data.sessionActive) {
          setSessionActive(false);
        }
      } catch {
        // Silently handle poll errors
      }
    };

    // Initial poll
    void poll();

    pollIntervalRef.current = setInterval(poll, GLOBAL_POLL_INTERVAL_MS);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [sessionActive, selectedTool]);

  // Auto-scroll output to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        localStorage.setItem(COLLAPSED_KEY, String(next));
      }
      return next;
    });
  }, []);

  const handleToolChange = useCallback((tool: CLIToolType) => {
    setSelectedTool(tool);
    if (typeof window !== 'undefined') {
      localStorage.setItem(CLI_TOOL_KEY, tool);
    }
  }, []);

  const handleStart = useCallback(async () => {
    if (!selectedRepo || starting) return;

    setStarting(true);
    setError(null);
    try {
      await assistantApi.startSession(selectedTool, selectedRepo);
      setSessionActive(true);
      setOutput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start session');
    } finally {
      setStarting(false);
    }
  }, [selectedRepo, selectedTool, starting]);

  const handleStop = useCallback(async () => {
    if (stopping) return;

    setStopping(true);
    setError(null);
    try {
      await assistantApi.stopSession(selectedTool);
      setSessionActive(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop session');
    } finally {
      setStopping(false);
    }
  }, [selectedTool, stopping]);

  const handleSendMessage = useCallback(
    async (message: string) => {
      setError(null);
      try {
        await assistantApi.sendCommand(selectedTool, message);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to send message');
        throw err;
      }
    },
    [selectedTool],
  );

  const handleRepoChange = useCallback(
    (newRepo: string) => {
      if (sessionActive) {
        const confirmed = window.confirm(
          'Changing repository will not affect the active session. Do you want to continue?',
        );
        if (!confirmed) return;
      }
      setSelectedRepo(newRepo);
    },
    [sessionActive],
  );

  const selectedRepository = repositories.find((repo) => repo.path === selectedRepo);

  return (
    <div
      className="mb-6 overflow-hidden rounded-xl border border-slate-800 bg-slate-950/95 shadow-lg shadow-slate-950/20"
      data-testid="assistant-chat-panel"
    >
      {/* Header */}
      <button
        onClick={toggleCollapsed}
        className="flex w-full items-center justify-between border-b border-slate-800 bg-slate-900/90 px-4 py-3 transition-colors hover:bg-slate-900"
        data-testid="assistant-toggle-button"
      >
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-cyan-600 dark:text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          <span className="text-sm font-semibold text-slate-100">
            Assistant Chat
          </span>
          {sessionActive && (
            <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-300">
              Active
            </span>
          )}
        </div>
        <svg
          className={`h-4 w-4 text-slate-400 transition-transform ${collapsed ? '' : 'rotate-180'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Content */}
      {!collapsed && (
        <div
          className="space-y-4 bg-gradient-to-br from-slate-950 via-slate-900 to-cyan-950/80 p-4"
          style={{ maxHeight: '50vh', display: 'flex', flexDirection: 'column' }}
        >
          <div className="rounded-lg border border-slate-700 bg-slate-900/70 p-3">
            <p className="text-sm font-medium text-slate-100">
              Start a local assistant session in a repository and chat from that working directory.
            </p>
            <p className="mt-1 text-xs text-slate-300">
              The repository selection sets where the assistant starts running commands and reading files.
            </p>
          </div>

          {/* Controls */}
          <div className="grid gap-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto] md:items-end">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-300">
                Repository to Work In
              </span>
              <select
                value={selectedRepo}
                onChange={(e) => handleRepoChange(e.target.value)}
                disabled={repositories.length === 0}
                className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-100 px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 disabled:cursor-not-allowed disabled:bg-slate-300"
                data-testid="assistant-repo-select"
              >
                {repositories.length === 0 && (
                  <option value="">No repositories</option>
                )}
                {repositories.map((repo) => (
                  <option key={repo.path} value={repo.path}>
                    {repo.displayName || repo.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-300">
                {selectedRepository
                  ? `Current start directory: ${selectedRepository.displayName || selectedRepository.name}`
                  : 'Select the repository that will be used as the assistant session start directory.'}
              </p>
            </label>

            <label className="block">
              <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-300">
                Assistant CLI
              </span>
              <select
                value={selectedTool}
                onChange={(e) => handleToolChange(e.target.value as CLIToolType)}
                disabled={sessionActive}
                className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-100 px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 disabled:cursor-not-allowed disabled:bg-slate-300"
                data-testid="assistant-tool-select"
              >
                {availableTools.map((tool) => (
                  <option key={tool.id} value={tool.id} disabled={!tool.installed}>
                    {tool.name}{!tool.installed ? ' (not installed)' : ''}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-end">
              {!sessionActive ? (
                <button
                  onClick={handleStart}
                  disabled={!selectedRepo || starting}
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

          {/* Error display */}
          {error && (
            <div className="rounded border border-red-800 bg-red-950/40 p-2 text-sm text-red-200">
              {error}
            </div>
          )}

          {/* Terminal output */}
          <pre
            ref={outputRef}
            className="flex-1 min-h-[100px] max-h-[35vh] overflow-auto bg-gray-900 text-green-400 text-xs font-mono p-3 rounded border border-gray-700 whitespace-pre-wrap break-words"
            data-testid="assistant-output"
          >
            {output || (sessionActive ? 'Waiting for output...' : 'Select a repository and click Start to open an assistant session.')}
          </pre>

          {/* Message input */}
          <AssistantMessageInput
            onSend={handleSendMessage}
            disabled={!sessionActive}
            placeholder={sessionActive ? 'Type your message... (Enter to send)' : 'Start a session first'}
          />
        </div>
      )}
    </div>
  );
}
