/**
 * Issue #3179 — the PC split while its agent is launching, for every tool.
 *
 * The polled state is handed in directly (the same seam the other split suites
 * use), so what is asserted is the split's own gating: the starting notice in
 * the terminal's box, no Navigate pad / escape hatch / answer panel, and a
 * composer told the session is starting (no stop button, no mode control).
 *
 * The dialog flags are raised on purpose: the server already zeroes them while
 * a launch is recorded, and the split must not depend on that alone.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { getSplitSurfaceModeStorageKey } from '@/config/surface-mode-config';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { resetRevealedStartingTerminals } from '@/hooks/useSessionStartingGate';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: ({ output }: { output: string }) => (
    <div data-testid="terminal-display">{output}</div>
  ),
}));

vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: ({
    splitIndex,
    isSessionRunning,
    isSessionStarting,
  }: {
    splitIndex: number;
    isSessionRunning?: boolean;
    isSessionStarting?: boolean;
  }) => (
    <div
      data-testid={`message-input-${splitIndex}`}
      data-running={String(Boolean(isSessionRunning))}
      data-starting={String(Boolean(isSessionStarting))}
    />
  ),
}));

vi.mock('@/components/worktree/NavigationButtons', () => ({
  NavigationButtons: () => <div data-testid="navigation-buttons" />,
}));
vi.mock('@/components/worktree/TerminalEscapeHatch', () => ({
  TerminalEscapeHatch: () => <div data-testid="terminal-escape-hatch" />,
}));
vi.mock('@/components/worktree/PromptPanel', () => ({
  PromptPanel: () => <div data-testid="prompt-panel" />,
}));
vi.mock('@/components/worktree/AutoYesToggle', () => ({
  AutoYesToggle: () => <div data-testid="auto-yes-toggle" />,
}));
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(),
  }),
}));
vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));
vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: () => (
    <div data-testid="chat-transcript">
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: vi.fn() }),
}));
vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({ visible: true, width: 40, toggle: vi.fn(), setWidth: vi.fn() }),
  DEFAULT_HISTORY_WIDTH: 40,
}));
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

const useTerminalPanePollingMock = vi.fn();
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: (...args: unknown[]) => useTerminalPanePollingMock(...args),
  UNCLASSIFIED_CONFIRMATION_COUNT: 2,
  UNCLASSIFIED_CONFIRMATION_DELAY_MS: 500,
}));

const WORKTREE_ID = 'wt-3179-split';
const TOOLS: readonly CLIToolType[] = [
  'claude', 'codex', 'antigravity', 'gemini', 'copilot', 'opencode', 'opencode-v2', 'command-code',
];
const LAUNCH_FRAME = "user@host wt % CM_HOOK_URL='http://127.0.0.1:3000' 'agy'";

function mockPane(startingSince: number | null) {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: LAUNCH_FRAME,
      realtimeSnippet: LAUNCH_FRAME,
      isRunning: true,
      isThinking: false,
      sessionStatus: 'running',
      isSelectionListActive: true,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: true,
      composerText: '',
      agentMode: 'unknown',
      startingSince,
      attaching: false,
      autoScroll: true,
    },
    prompt: {
      visible: true,
      data: { type: 'yes_no', question: 'Trust?', options: ['yes', 'no'], status: 'pending' },
      messageId: 'p-1',
      answering: false,
    },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
}

function renderSplit(cliToolId: CLIToolType) {
  const instance: AgentInstance = { id: cliToolId, cliTool: cliToolId, alias: cliToolId, order: 0 };
  return render(
    <TerminalSplitPaneContent
      worktreeId={WORKTREE_ID}
      splitIndex={0}
      cliToolId={cliToolId}
      availableInstances={[instance]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
    />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  resetRevealedStartingTerminals();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: async () => ({}) }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('[#3179] the PC split while the agent is launching', () => {
  it.each(TOOLS)('%s: notice instead of the pane, no pad / hatch / panel, no stop button', (tool) => {
    mockPane(Date.now());
    renderSplit(tool);

    expect(screen.getByTestId('session-starting-notice')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-display')).toBeNull();
    expect(screen.queryByTestId('navigation-buttons')).toBeNull();
    expect(screen.queryByTestId('terminal-escape-hatch')).toBeNull();
    expect(screen.queryByTestId('prompt-panel')).toBeNull();
    expect(screen.getByTestId('message-input-0')).toHaveAttribute('data-starting', 'true');
  });

  it.each(TOOLS)('%s: the same flags draw the controls once the launch is over', (tool) => {
    mockPane(null);
    renderSplit(tool);

    expect(screen.queryByTestId('session-starting-notice')).toBeNull();
    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    expect(screen.getByTestId('navigation-buttons')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
    expect(screen.getByTestId('message-input-0')).toHaveAttribute('data-starting', 'false');
  });

  it('"ターミナルを見る" shows the pane, and the controls stay down while starting', () => {
    mockPane(Date.now());
    renderSplit('antigravity');

    act(() => {
      fireEvent.click(screen.getByTestId('session-starting-show-terminal'));
    });

    expect(screen.queryByTestId('session-starting-notice')).toBeNull();
    expect(screen.getByTestId('terminal-display')).toHaveTextContent('agy');
    expect(screen.queryByTestId('navigation-buttons')).toBeNull();
    expect(screen.getByTestId('message-input-0')).toHaveAttribute('data-starting', 'true');
  });

  it('a new launch of the same instance shows the notice again', () => {
    mockPane(1_000);
    const { rerender } = renderSplit('claude');
    act(() => {
      fireEvent.click(screen.getByTestId('session-starting-show-terminal'));
    });
    expect(screen.queryByTestId('session-starting-notice')).toBeNull();

    mockPane(2_000);
    const instance: AgentInstance = { id: 'claude', cliTool: 'claude', alias: 'claude', order: 0 };
    rerender(
      <TerminalSplitPaneContent
        worktreeId={WORKTREE_ID}
        splitIndex={0}
        cliToolId="claude"
        availableInstances={[instance]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        autoYes={{ onToggle: vi.fn() }}
      />,
    );
    expect(screen.getByTestId('session-starting-notice')).toBeInTheDocument();
  });

  it('on the chat surface: the starting strip, and no dialog card', () => {
    window.localStorage.setItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0), 'chat');
    mockPane(Date.now());
    renderSplit('codex');

    expect(screen.getByTestId('chat-surface-starting')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-surface-live')).toBeNull();
  });
});
