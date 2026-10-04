/**
 * Issue #3179 — a Sessions tile while its agent is launching: the notice in
 * the terminal's place, a composer told the session is starting, and the pane
 * back on "ターミナルを見る".
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: ({ isSessionStarting }: { isSessionStarting?: boolean }) => (
    <div data-testid="tile-message-input" data-starting={String(Boolean(isSessionStarting))} />
  ),
}));

const useTerminalPanePollingMock = vi.hoisted(() => vi.fn());
const useSplitMessagesMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
}));

import { SessionTile } from '@/components/sessions/SessionTile';
import { resetRevealedStartingTerminals } from '@/hooks/useSessionStartingGate';
import type { Worktree } from '@/types/models';

function worktree(): Worktree {
  return {
    id: 'wt-1',
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    selectedAgents: ['antigravity'],
  } as Worktree;
}

function mockPane(startingSince: number | null) {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: "user@host wt % 'agy'",
      realtimeSnippet: '',
      isRunning: true,
      isThinking: false,
      sessionStatus: 'running',
      isSelectionListActive: false,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      agentMode: 'unknown',
      startingSince,
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
}

function showTerminalSurface() {
  act(() => {
    fireEvent.click(screen.getByTestId('session-tile-surface-terminal-wt-1'));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  resetRevealedStartingTerminals();
  useTerminalPanePollingMock.mockReset();
  useSplitMessagesMock.mockReset();
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
});

describe('[#3179] SessionTile while the agent is launching', () => {
  it('shows the starting notice in the terminal\'s place and keeps stop / mode down', () => {
    mockPane(Date.now());
    render(<SessionTile worktree={worktree()} enabled />);
    showTerminalSurface();

    expect(screen.getByTestId('session-starting-notice')).toHaveTextContent('Starting Antigravity…');
    expect(screen.queryByTestId('terminal-display')).toBeNull();
    expect(screen.getByTestId('tile-message-input')).toHaveAttribute('data-starting', 'true');
  });

  it('"Show terminal" brings the pane back', () => {
    mockPane(Date.now());
    render(<SessionTile worktree={worktree()} enabled />);
    showTerminalSurface();

    act(() => {
      fireEvent.click(screen.getByTestId('session-starting-show-terminal'));
    });
    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
  });

  it('draws the pane as before once the launch is over', () => {
    mockPane(null);
    render(<SessionTile worktree={worktree()} enabled />);
    showTerminalSurface();

    expect(screen.queryByTestId('session-starting-notice')).toBeNull();
    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    expect(screen.getByTestId('tile-message-input')).toHaveAttribute('data-starting', 'false');
  });
});
