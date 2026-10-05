/**
 * The PC split's column of the shared table (Issue #3292) — see `./cases`.
 *
 * `TerminalSplitPaneContent`'s `handlePromptRespond` is the PC's one handler:
 * `PromptPanel` sits in the composer footer on the terminal surface AND on the
 * chat surface (#2254 left it ungated on purpose), so both are driven here.
 *
 * The polled state comes in through the `useTerminalPanePolling` seam the other
 * pane suites use, so `clearPrompt` and `refresh` are spies: "the card stays"
 * and "the screen was fetched again" are statements about this handler rather
 * than about the next poll.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { getSplitSurfaceModeStorageKey } from '@/config/surface-mode-config';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import {
  PROMPT_RESPONSE_ROWS,
  promptResponseToast,
  replyOf,
  type PromptResponseCase,
  type PromptResponseObserved,
} from './cases';

beforeAll(() => installRadixJsdomPolyfills());

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));
vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: () => (
    <div data-testid="chat-transcript">
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
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

// The panel hands back whatever it was given; this stand-in lets the test press
// the answer.
vi.mock('@/components/worktree/PromptPanel', () => ({
  PromptPanel: ({
    visible,
    onRespond,
  }: {
    visible: boolean;
    onRespond: (answer: string, decisionId?: string | null) => Promise<void>;
  }) =>
    visible ? (
      <button type="button" data-testid="prompt-panel" onClick={() => { void onRespond('1'); }} />
    ) : null,
}));

const useTerminalPanePollingMock = vi.fn();
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: (...args: unknown[]) => useTerminalPanePollingMock(...args),
  UNCLASSIFIED_CONFIRMATION_COUNT: 2,
  UNCLASSIFIED_CONFIRMATION_DELAY_MS: 500,
}));

const WORKTREE_ID = 'w-3292';
const FRAME = ['Do you want to proceed?', '', '❯ 1. Yes', '  2. No'].join('\n');

const clearPrompt = vi.fn();
const refresh = vi.fn(() => Promise.resolve());
const setPromptAnswering = vi.fn();
const showToast = vi.fn();

function mockPane(): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: FRAME,
      realtimeSnippet: FRAME,
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
        question: 'Do you want to proceed?',
        status: 'pending',
        options: [
          { number: 1, label: 'Yes', isDefault: true },
          { number: 2, label: 'No', isDefault: false },
        ],
      },
      messageId: 'prompt-3292',
      answering: false,
    },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering,
    clearPrompt,
    refresh,
  });
}

/** Press the answer on a split whose POST gets `testCase.reply`; report what the user was left with. */
async function observe(
  testCase: PromptResponseCase,
  surface: 'terminal' | 'chat',
): Promise<PromptResponseObserved> {
  window.localStorage.setItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0), surface);
  const posted: string[] = [];
  global.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posted.push(String(input));
      return replyOf(testCase);
    }
    // Nothing else this split fetches is under test; leave it pending.
    return new Promise(() => {});
  }) as unknown as typeof fetch;

  render(
    <TerminalSplitPaneContent
      worktreeId={WORKTREE_ID}
      splitIndex={0}
      cliToolId="claude"
      availableInstances={[inst('claude')]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
      history={{ showToast }}
    />,
  );
  // The surface under test is the one on screen.
  expect(screen.getByTestId(surface === 'chat' ? 'chat-transcript' : 'terminal-display')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('prompt-panel'));

  // The handler is done once the card can be pressed again.
  await waitFor(() => {
    expect(setPromptAnswering).toHaveBeenLastCalledWith(false);
  });
  expect(posted).toEqual([`/api/worktrees/${WORKTREE_ID}/prompt-response`]);

  return {
    toast: promptResponseToast(showToast),
    cardKept: clearPrompt.mock.calls.length === 0,
    refetched: refresh.mock.calls.length > 0,
  };
}

describe.each(['terminal', 'chat'] as const)('[#3292] an answer from the PC split — %s surface', (surface) => {
  beforeEach(() => {
    window.localStorage.clear();
    clearPrompt.mockClear();
    refresh.mockClear();
    setPromptAnswering.mockClear();
    showToast.mockClear();
    mockPane();
    // The handler logs a request that got no reply; that line is not the result.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(PROMPT_RESPONSE_ROWS)('%s', async (_name, testCase) => {
    expect(await observe(testCase, surface)).toEqual(testCase.expected);
  });
});
