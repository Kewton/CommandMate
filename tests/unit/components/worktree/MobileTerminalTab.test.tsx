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
  /** Issue #1879: text sitting unsent in the CLI composer. */
  composerText?: string;
}

function mockPaneState({
  isUnclassifiedActive = false,
  isSelectionListActive = false,
  promptVisible = false,
  composerText = '',
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
      composerText,
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: promptVisible, data: null, messageId: null, answering: false },
    // Issue #2042: part of the hook's return. Kept here so the mock does
    // not claim a shape the hook never returns — the panes read
    // `agentSession.session` unconditionally.
    agentSession: { session: null, context: null },
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
/**
 * Issue #1879: mobile parity for the unsent-input bar.
 *
 * The PC footer got the bar; a phone is where a half-typed composer is most
 * likely to be found, and the Issue requires both surfaces to reach it. These
 * also pin the gate: it is the text, and only the text.
 */
describe('MobileTerminalTab unsent-input bar (Issue #1879)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('shows the bar when the composer holds unsent text', () => {
    mockPaneState({ composerText: '/work-plan' });
    render(<MobileTerminalTab worktreeId="w-1" cliToolId="claude" />);
    expect(screen.getByTestId('unsent-composer-bar')).toBeInTheDocument();
    expect(screen.getByTestId('unsent-composer-text')).toHaveTextContent('/work-plan');
  });

  it('hides the bar when the composer is empty — no Enter affordance', () => {
    mockPaneState({ composerText: '' });
    render(<MobileTerminalTab worktreeId="w-1" cliToolId="claude" />);
    expect(screen.queryByTestId('unsent-composer-bar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'worktree.unsentComposer.run' })).not.toBeInTheDocument();
  });

  it.each([
    ['classified/idle', { isUnclassifiedActive: false }],
    ['unclassified', { isUnclassifiedActive: true }],
    ['a selection list is up', { isSelectionListActive: true }],
    ['a prompt panel is up', { promptVisible: true }],
  ])('shows the bar regardless of detection state (%s)', (_label, flags) => {
    mockPaneState({ composerText: '/work-plan', ...flags });
    render(<MobileTerminalTab worktreeId="w-1" cliToolId="claude" />);
    expect(screen.getByTestId('unsent-composer-bar')).toBeInTheDocument();
  });

  it('leaves the navigation-hatch gate untouched (unclassified + empty composer)', () => {
    mockPaneState({ isUnclassifiedActive: true, composerText: '' });
    render(<MobileTerminalTab worktreeId="w-1" cliToolId="claude" />);
    expect(screen.getByLabelText('Send Escape')).toBeInTheDocument();
    expect(screen.queryByTestId('unsent-composer-bar')).not.toBeInTheDocument();
  });

  it('sends Enter through the existing special-keys endpoint', async () => {
    mockPaneState({ composerText: '/work-plan' });
    render(<MobileTerminalTab worktreeId="w-1" cliToolId="claude" instanceId="claude" />);
    fireEvent.click(screen.getByRole('button', { name: 'worktree.unsentComposer.run' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/worktrees/w-1/special-keys');
    expect(JSON.parse((options as RequestInit).body as string)).toEqual({
      cliToolId: 'claude',
      keys: ['Enter'],
    });
  });

  it('clears through the clear-composer endpoint', async () => {
    mockPaneState({ composerText: '/work-plan' });
    render(<MobileTerminalTab worktreeId="w-1" cliToolId="claude" instanceId="claude" />);
    fireEvent.click(screen.getByRole('button', { name: 'worktree.unsentComposer.clear' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/worktrees/w-1/clear-composer');
  });
});
