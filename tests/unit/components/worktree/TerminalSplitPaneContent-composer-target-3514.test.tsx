/**
 * Issue #3514: each split's composer names where it sends — "To: <agent> ·
 * <branch>" directly above the input — on the terminal surface and on the chat
 * surface alike (the footer is shared by both). The composer itself stays per
 * split.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { getSplitSurfaceModeStorageKey } from '@/config/surface-mode-config';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: ({ output }: { output: string }) => (
    <div data-testid="terminal-display">{output}</div>
  ),
}));

vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: ({ splitIndex }: { splitIndex: number }) => (
    <div data-testid={`message-input-${splitIndex}`} />
  ),
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

vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({ visible: true, width: 40, toggle: vi.fn(), setWidth: vi.fn() }),
  DEFAULT_HISTORY_WIDTH: 40,
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

const { useTerminalPanePollingMock, useSplitMessagesMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: (...args: unknown[]) => useTerminalPanePollingMock(...args),
  UNCLASSIFIED_CONFIRMATION_COUNT: 2,
  UNCLASSIFIED_CONFIRMATION_DELAY_MS: 500,
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: (...args: unknown[]) => useSplitMessagesMock(...args),
}));

const WORKTREE_ID = 'wt-3514-split';

/** The pane, as the polling hook reports it. Defaults to a HEALTHY session. */
function mockPane(extra: Record<string, unknown> = {}): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: '',
      realtimeSnippet: '',
      isRunning: true,
      isThinking: false,
      sessionStatus: 'ready',
      isSelectionListActive: false,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: false,
      autoScroll: true,
      ...extra,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
}

function renderSplit(props: Partial<React.ComponentProps<typeof TerminalSplitPaneContent>> = {}) {
  return render(
    <TerminalSplitPaneContent
      worktreeId={WORKTREE_ID}
      splitIndex={0}
      cliToolId="claude"
      instanceId="claude-2"
      instance={{ id: 'claude-2', cliTool: 'claude', alias: 'Review', order: 1 }}
      availableInstances={[inst('claude')]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
      {...props}
    />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: async () => ({}) }),
  ) as unknown as typeof fetch;
  mockPane();
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('[#3514] composer target line', () => {
  it('names the agent and the branch above this split\'s input', () => {
    renderSplit({ branchName: 'feature/3514' });
    const line = screen.getByTestId('split-composer-target-0');
    expect(line).toHaveTextContent('worktree.terminal.composerTarget');
    expect(line).toHaveAttribute('aria-label', 'worktree.terminal.composerTargetLabel');
    // Directly above the composer.
    expect(line.nextElementSibling).toBe(screen.getByTestId('message-input-0'));
  });

  it('falls back to the agent alone without a branch', () => {
    renderSplit({ branchName: '  ' });
    expect(screen.getByTestId('split-composer-target-0')).toHaveTextContent(
      'worktree.terminal.composerTargetNoBranch',
    );
  });

  it('is shown on the chat surface too', () => {
    window.localStorage.setItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0), 'chat');
    renderSplit({ branchName: 'feature/3514' });
    expect(screen.getByTestId('split-composer-target-0')).toBeInTheDocument();
    expect(screen.getByTestId('message-input-0')).toBeInTheDocument();
  });

  it('passes the selected-split frame through to the title bar', () => {
    renderSplit({ showFocusFrame: true });
    expect(screen.getByTestId('terminal-split-pane-0')).toHaveAttribute('data-focused', 'true');
  });
});
