/**
 * A split whose prompt window `/prompt-response` would refuse offers no Send
 * (Issue #2870).
 *
 * `promptAnswerable: false` on the poll reaches the real `PromptPanel` through
 * `useTerminalPanePolling`'s `prompt.answerable`: the options stay on screen,
 * Send and the options are disabled, and the direct-input hint and its link are
 * drawn up front — no failed Send has to come first.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));
vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: () => <div data-testid="message-input" />,
}));
vi.mock('@/components/worktree/NavigationButtons', () => ({
  NavigationButtons: () => <div data-testid="navigation-buttons" />,
}));
vi.mock('@/components/worktree/TerminalEscapeHatch', () => ({
  TerminalEscapeHatch: () => <div data-testid="terminal-escape-hatch" />,
}));
vi.mock('@/components/worktree/AutoYesToggle', () => ({
  AutoYesToggle: () => <div data-testid="auto-yes-toggle" />,
}));
vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(),
  }),
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()) }),
}));
vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({ visible: false, width: 40, toggle: vi.fn(), setWidth: vi.fn() }),
  DEFAULT_HISTORY_WIDTH: 40,
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));

const useTerminalPanePollingMock = vi.fn();
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: (...args: unknown[]) => useTerminalPanePollingMock(...args),
  UNCLASSIFIED_CONFIRMATION_COUNT: 2,
  UNCLASSIFIED_CONFIRMATION_DELAY_MS: 500,
}));

const MODEL_FRAME = ['Select Model', '', '› 1. gpt-5.5', '  2. gpt-5.5-mini'].join('\n');

let answerable: boolean | undefined;

function mockPane() {
  useTerminalPanePollingMock.mockImplementation(() => ({
    terminal: {
      output: MODEL_FRAME,
      realtimeSnippet: MODEL_FRAME,
      isRunning: true,
      isThinking: false,
      sessionStatus: 'waiting',
      isSelectionListActive: false,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: false,
      autoScroll: true,
    },
    prompt: {
      visible: true,
      data: {
        type: 'multiple_choice',
        question: 'Select Model',
        status: 'pending',
        options: [
          { number: 1, label: 'gpt-5.5', isDefault: true },
          { number: 2, label: 'gpt-5.5-mini', isDefault: false },
        ],
      },
      messageId: 'prompt-2870',
      answering: false,
      answerable,
    },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(() => Promise.resolve()),
  }));
}

function split(): React.ReactElement {
  return (
    <TerminalSplitPaneContent
      worktreeId="w-2870"
      splitIndex={0}
      cliToolId="codex"
      availableInstances={[inst('codex')]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
      history={{ showToast: vi.fn() }}
    />
  );
}

let posted: string[];

beforeEach(() => {
  answerable = undefined;
  posted = [];
  mockPane();
  global.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') posted.push(String(input));
    return new Promise(() => {});
  }) as unknown as typeof fetch;
});

describe('[#2870] a split whose prompt is not answerable', () => {
  it('keeps the options, disables Send, and shows the hint with its link', () => {
    answerable = false;
    render(split());

    expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    const send = screen.getByRole('button', { name: 'prompt.submit' });
    expect(send).toBeDisabled();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();

    fireEvent.click(send);
    expect(posted).toEqual([]);

    expect(screen.getByTestId('prompt-unanswerable-hint')).toHaveTextContent(
      'worktree.promptResponse.unanswerable',
    );
    expect(screen.queryByTestId('prompt-stuck-hint')).not.toBeInTheDocument();
  });

  it('opens the direct-input bar from the link', () => {
    answerable = false;
    render(split());

    expect(screen.queryByTestId('direct-input-bar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'worktree.promptResponse.stuckHintLink' }));
    expect(screen.getByTestId('direct-input-bar')).toBeInTheDocument();
  });

  it.each([[undefined], [true]])('is unchanged when answerable is %s', (value) => {
    answerable = value;
    render(split());

    expect(screen.getByRole('button', { name: 'prompt.submit' })).not.toBeDisabled();
    expect(screen.queryByTestId('prompt-unanswerable-hint')).not.toBeInTheDocument();
  });
});
