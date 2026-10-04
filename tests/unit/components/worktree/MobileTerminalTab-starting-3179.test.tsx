/**
 * Issue #3179 — the phone's terminal tab while its agent is launching.
 *
 * The reported screen (Antigravity, phone): the launch line alone on the pane
 * and the Navigate pad under it. While `startingSince` is set the tab shows
 * "<agent> を起動中…" instead, draws no pad, and "ターミナルを見る" brings the
 * pane back.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { getMobileSurfaceModeStorageKey } from '@/config/surface-mode-config';
import { resetRevealedStartingTerminals } from '@/hooks/useSessionStartingGate';
import type { CLIToolType } from '@/lib/cli-tools/types';

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));
vi.mock('@/components/worktree/TerminalEscapeHatch', () => ({
  TerminalEscapeHatch: () => <div data-testid="terminal-escape-hatch" />,
}));
vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: () => (
    <div data-testid="chat-transcript">
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

const { useTerminalPanePollingMock, useSplitMessagesMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
}));

import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';

const WORKTREE_ID = 'wt-3179-mobile';
const TOOLS: readonly CLIToolType[] = [
  'claude', 'codex', 'antigravity', 'gemini', 'copilot', 'opencode', 'opencode-v2', 'command-code',
];

function mockPane(startingSince: number | null): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: "user@host wt % 'agy'",
      realtimeSnippet: "user@host wt % 'agy'",
      isRunning: true,
      isThinking: false,
      sessionStatus: 'running',
      isSelectionListActive: false,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: true,
      composerText: '',
      agentMode: 'unknown',
      startingSince,
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
}

beforeEach(() => {
  window.localStorage.clear();
  resetRevealedStartingTerminals();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('[#3179] the phone terminal tab while the agent is launching', () => {
  it.each(TOOLS)('%s: the starting notice replaces the pane and the Navigate pad', (tool) => {
    mockPane(Date.now());
    render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId={tool} />);

    expect(screen.getByTestId('session-starting-notice')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-display')).toBeNull();
    expect(screen.queryByTestId('terminal-escape-hatch')).toBeNull();
  });

  it('without a launch the same frame draws the pane and the pad, as before', () => {
    mockPane(null);
    render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="antigravity" />);

    expect(screen.queryByTestId('session-starting-notice')).toBeNull();
    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-escape-hatch')).toBeInTheDocument();
  });

  it('"ターミナルを見る" brings the pane back, still without the pad', () => {
    mockPane(Date.now());
    render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="antigravity" />);

    act(() => {
      fireEvent.click(screen.getByTestId('session-starting-show-terminal'));
    });

    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    expect(screen.queryByTestId('session-starting-notice')).toBeNull();
    expect(screen.queryByTestId('terminal-escape-hatch')).toBeNull();
  });

  it('on the chat surface: the starting strip and no dialog card', () => {
    window.localStorage.setItem(getMobileSurfaceModeStorageKey(WORKTREE_ID), 'chat');
    mockPane(Date.now());
    render(<MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="antigravity" />);

    expect(screen.getByTestId('chat-surface-starting')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-surface-live')).toBeNull();
  });
});
