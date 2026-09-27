/**
 * A split whose prompt window survives two Sends points the user at direct
 * input (Issue #2869).
 *
 * The real `PromptPanel` is rendered, so "the hint is there" is a statement
 * about what the user sees. `/prompt-response` refuses every answer
 * (`{ success: false }`), which is the codex `/model` case: the window stays.
 *
 * Every poll that still sees the window hands over a freshly parsed
 * `promptData`, so the mocked poller does the same (a new object per call with
 * the same content) and `poll()` re-renders the split the way the next poll
 * would.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
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

let isRunning = true;

function mockPane() {
  // A new `promptData` object per render, same content: what a poll does.
  useTerminalPanePollingMock.mockImplementation(() => ({
    terminal: {
      output: MODEL_FRAME,
      realtimeSnippet: MODEL_FRAME,
      isRunning,
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
      messageId: 'prompt-2869',
      answering: false,
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
      worktreeId="w-2869"
      splitIndex={0}
      cliToolId="codex"
      availableInstances={[inst('codex')]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
      history={{ showToast }}
    />
  );
}

const showToast = vi.fn();
let posted: string[];

beforeEach(() => {
  isRunning = true;
  posted = [];
  showToast.mockClear();
  mockPane();
  global.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posted.push(String(input));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: false, reason: 'prompt_no_longer_active', answer: '1' }),
      });
    }
    return new Promise(() => {});
  }) as unknown as typeof fetch;
});

/** Press the panel's Send and wait for the refusal to land. */
async function pressSend(): Promise<void> {
  const before = posted.length;
  fireEvent.click(screen.getByRole('button', { name: 'prompt.submit' }));
  await waitFor(() => expect(posted.length).toBe(before + 1));
  await waitFor(() => expect(showToast).toHaveBeenCalledTimes(before + 1));
}

describe('[#2869] the stuck-prompt hint on a split', () => {
  it('is not shown after one Send that left the window up', async () => {
    const { rerender } = render(split());
    expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();

    await pressSend();
    await act(async () => rerender(split()));

    expect(screen.queryByTestId('prompt-stuck-hint')).not.toBeInTheDocument();
  });

  it('appears after the second Send, and its link opens the direct-input bar', async () => {
    const { rerender } = render(split());

    await pressSend();
    await act(async () => rerender(split()));
    await pressSend();
    await act(async () => rerender(split()));

    const hint = screen.getByTestId('prompt-stuck-hint');
    expect(hint).toHaveTextContent('worktree.promptResponse.stuckHint');
    const link = screen.getByRole('button', { name: 'worktree.promptResponse.stuckHintLink' });
    expect(link).toHaveAttribute('type', 'button');
    expect(screen.queryByTestId('direct-input-bar')).not.toBeInTheDocument();

    fireEvent.click(link);
    expect(screen.getByTestId('direct-input-bar')).toBeInTheDocument();
    expect(posted).toEqual([
      '/api/worktrees/w-2869/prompt-response',
      '/api/worktrees/w-2869/prompt-response',
    ]);
  });

  it('offers no link while the session is not running', async () => {
    const { rerender } = render(split());
    await pressSend();
    await act(async () => rerender(split()));
    await pressSend();
    isRunning = false;
    await act(async () => rerender(split()));

    expect(screen.queryByTestId('prompt-stuck-hint')).not.toBeInTheDocument();
  });
});
