/**
 * Tests for MobileTerminalTab navigation-hatch parity (Issue #1494 / #1496).
 *
 * Mobile previously rendered only the read-only TerminalDisplay, so an
 * unclassified TUI overlay (e.g. Claude `/help`) had no on-screen keys at all.
 * These tests assert the shared TerminalEscapeHatch navigation pad now appears on
 * mobile under the same gate the PC footer uses, and drives the special-keys API.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Stub the heavy read-only terminal surface; this suite only cares about the hatch.
vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

const { useTerminalPanePollingMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));

import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';

interface PaneOverrides {
  isUnclassifiedActive?: boolean;
  isSelectionListActive?: boolean;
  promptVisible?: boolean;
}

function mockPaneState({
  isUnclassifiedActive = false,
  isSelectionListActive = false,
  promptVisible = false,
}: PaneOverrides) {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'output',
      realtimeSnippet: 'output',
      isRunning: true,
      isThinking: false,
      isSelectionListActive,
      isPagerActive: false,
      isUnclassifiedActive,
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: promptVisible, data: null, messageId: null, answering: false },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
}

describe('MobileTerminalTab navigation hatch (Issue #1494 / #1496)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('shows the navigation hatch when the frame is unclassified (e.g. /help)', () => {
    mockPaneState({ isUnclassifiedActive: true });
    render(<MobileTerminalTab worktreeId="w-1" cliToolId="claude" />);
    expect(screen.getByLabelText('Send Left')).toBeInTheDocument();
    expect(screen.getByLabelText('Send Right')).toBeInTheDocument();
    expect(screen.getByLabelText('Send Escape')).toBeInTheDocument();
  });

  it('hides the navigation hatch when the frame is classified/idle', () => {
    mockPaneState({ isUnclassifiedActive: false });
    render(<MobileTerminalTab worktreeId="w-1" cliToolId="claude" />);
    expect(screen.queryByLabelText('Send Left')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Send Escape')).not.toBeInTheDocument();
  });

  it('hides the navigation hatch while a prompt panel is driving the session (parity with PC, /model=#1495)', () => {
    mockPaneState({ isUnclassifiedActive: true, promptVisible: true });
    render(<MobileTerminalTab worktreeId="w-1" cliToolId="claude" />);
    expect(screen.queryByLabelText('Send Left')).not.toBeInTheDocument();
  });

  it('sends the arrow key through the special-keys API from the mobile hatch', async () => {
    mockPaneState({ isUnclassifiedActive: true });
    render(<MobileTerminalTab worktreeId="w-1" cliToolId="claude" instanceId="claude" />);
    fireEvent.click(screen.getByLabelText('Send Right'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/worktrees/w-1/special-keys');
    expect(JSON.parse((options as RequestInit).body as string)).toEqual({
      cliToolId: 'claude',
      keys: ['Right'],
    });
  });
});
