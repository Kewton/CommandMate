/**
 * Issue #4031 (item 3): the answer panel tells an answer stopped part-way from
 * any other failure.
 *
 * `/prompt-response` and `/respond` answer an InputLost as a 500 with
 * `reason: answer_input_lost` and `keysSent: true` (#3982): some keys may be on
 * the pane, so answering again blindly could type them twice. Before #4031
 * `readPromptResponseReply` made every non-2xx `failed`, and the user saw
 * "please try again". Driven on the PC split (`TerminalSplitPaneContent`) with
 * the table's harness (`../prompt-response-outcome-3292/cases`).
 *
 * - positive: InputLost 500 → the `partial` toast (warning), card kept
 * - negative: a plain 500, and a 500 with `keysSent: false` → the `failed` toast as before
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
  promptResponseToast,
  replyOf,
  type PromptResponseCase,
  type PromptResponseObserved,
} from '../prompt-response-outcome-3292/cases';

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

const WORKTREE_ID = 'w-4031';
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

const PARTIAL = ['worktree.promptResponse.partial', 'warning'] as const;
const FAILED = ['worktree.promptResponse.failed', 'error'] as const;

const CASES: ReadonlyArray<readonly [string, PromptResponseCase]> = [
  [
    'positive: 500 answer_input_lost with keysSent: true — the partial toast',
    {
      name: 'input lost',
      reply: {
        status: 500,
        body: { error: 'Failed to send answer to tmux: stopped part-way', reason: 'answer_input_lost', keysSent: true },
      },
      outcome: 'failed',
      expected: { toast: PARTIAL, cardKept: true, refetched: true },
    },
  ],
  [
    'negative: a plain 500 — the failed toast as before',
    {
      name: 'plain 500',
      reply: { status: 500, body: { error: 'Failed to send answer to tmux: no server running' } },
      outcome: 'failed',
      expected: { toast: FAILED, cardKept: true, refetched: true },
    },
  ],
  [
    'negative: a 500 with another reason (answer_aborted, keysSent: true) — the failed toast',
    {
      name: 'aborted',
      reply: { status: 500, body: { error: 'x', reason: 'answer_aborted', keysSent: true } },
      outcome: 'failed',
      expected: { toast: FAILED, cardKept: true, refetched: true },
    },
  ],
];

describe('[#4031] an InputLost reply on the PC split', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearPrompt.mockClear();
    refresh.mockClear();
    setPromptAnswering.mockClear();
    showToast.mockClear();
    mockPane();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(CASES)('%s', async (_name, testCase) => {
    expect(await observe(testCase, 'terminal')).toEqual(testCase.expected);
  });
});
