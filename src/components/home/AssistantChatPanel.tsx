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
import { GLOBAL_POLL_INTERVAL_MS } from '@/lib/session/global-session-constants';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { CLI_TOOL_IDS, getCliToolDisplayName } from '@/lib/cli-tools/types';

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

  // Fetch repositories
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
    fetchRepos();
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

  return (
    <div
      className="mb-6 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden"
      data-testid="assistant-chat-panel"
    >
      {/* Header */}
      <button
        onClick={toggleCollapsed}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-750 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        data-testid="assistant-toggle-button"
      >
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-cyan-600 dark:text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Assistant Chat
          </span>
          {sessionActive && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">
              Active
            </span>
          )}
        </div>
        <svg
          className={`w-4 h-4 text-gray-500 dark:text-gray-400 transition-transform ${collapsed ? '' : 'rotate-180'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Content */}
      {!collapsed && (
        <div className="p-4 space-y-3" style={{ maxHeight: '50vh', display: 'flex', flexDirection: 'column' }}>
          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Repository selector */}
            <select
              value={selectedRepo}
              onChange={(e) => handleRepoChange(e.target.value)}
              disabled={repositories.length === 0}
              className="text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded px-2 py-1 max-w-[200px] truncate"
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

            {/* CLI tool selector */}
            <select
              value={selectedTool}
              onChange={(e) => handleToolChange(e.target.value as CLIToolType)}
              disabled={sessionActive}
              className="text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded px-2 py-1"
              data-testid="assistant-tool-select"
            >
              {CLI_TOOL_IDS.map((toolId) => (
                <option key={toolId} value={toolId}>
                  {getCliToolDisplayName(toolId)}
                </option>
              ))}
            </select>

            {/* Start/Stop button */}
            {!sessionActive ? (
              <button
                onClick={handleStart}
                disabled={!selectedRepo || starting}
                className="text-sm px-3 py-1 bg-cyan-600 hover:bg-cyan-700 text-white rounded disabled:bg-gray-400 dark:disabled:bg-gray-600 transition-colors"
                data-testid="assistant-start-button"
              >
                {starting ? 'Starting...' : 'Start'}
              </button>
            ) : (
              <button
                onClick={handleStop}
                disabled={stopping}
                className="text-sm px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded disabled:bg-gray-400 dark:disabled:bg-gray-600 transition-colors"
                data-testid="assistant-stop-button"
              >
                {stopping ? 'Stopping...' : 'Stop'}
              </button>
            )}
          </div>

          {/* Error display */}
          {error && (
            <div className="p-2 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded text-sm text-red-800 dark:text-red-300">
              {error}
            </div>
          )}

          {/* Terminal output */}
          <pre
            ref={outputRef}
            className="flex-1 min-h-[100px] max-h-[35vh] overflow-auto bg-gray-900 text-green-400 text-xs font-mono p-3 rounded border border-gray-700 whitespace-pre-wrap break-words"
            data-testid="assistant-output"
          >
            {output || (sessionActive ? 'Waiting for output...' : 'Start a session to begin.')}
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
