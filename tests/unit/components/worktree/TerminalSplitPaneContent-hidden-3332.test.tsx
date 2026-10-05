/**
 * A split hidden behind another split's maximize counts no prompt window
 * (Issue #3332), so the #2869 stuck hint follows the 10 s rule.
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
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { TerminalSplitHiddenProvider } from '@/components/worktree/TerminalSplitHiddenContext';
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

function split(hidden = false): React.ReactElement {
  return (
    <TerminalSplitHiddenProvider value={hidden}>
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
    </TerminalSplitHiddenProvider>
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


afterEach(() => {
  vi.restoreAllMocks();
});

/** The hook's 10 s reset timers, captured so a test can fire them by hand. */
function captureResetTimers(): Array<() => void> {
  const fired: Array<() => void> = [];
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === 10_000) {
      fired.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return real(fn, ms, ...rest);
  }) as typeof setTimeout);
  return fired;
}

async function reachHint(rerender: (ui: React.ReactElement) => void): Promise<void> {
  await pressSend();
  await act(async () => rerender(split()));
  await pressSend();
  await act(async () => rerender(split()));
  expect(screen.getByTestId('prompt-stuck-hint')).toBeInTheDocument();
}

describe('[#3332] a split hidden by another split\'s maximize', () => {
  it('keeps drawing the prompt panel while hidden (display:none by the parent)', async () => {
    const { rerender } = render(split());
    await act(async () => rerender(split(true)));
    expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
  });

  describe.each([
    ['under 10 s', false],
    ['10 s or more', true],
  ])('the answer being edited, hidden %s', (_label, fire) => {
    it('is still selected after the split comes back', async () => {
      const { rerender } = render(split());
      const resets = captureResetTimers();
      const radios = screen.getAllByRole('radio');
      expect(radios.length).toBeGreaterThan(1);
      fireEvent.click(radios[1]);
      expect(screen.getAllByRole('radio')[1]).toBeChecked();
      await act(async () => rerender(split(true)));
      if (fire) {
        await act(async () => {
          resets.forEach((r) => r());
        });
      }
      await act(async () => rerender(split(false)));
      expect(screen.getAllByRole('radio')[1]).toBeChecked();
    });
  });

  it('starts over when hidden for 10 s (no hint on return)', async () => {
    const { rerender } = render(split());
    const resets = captureResetTimers();
    await reachHint(rerender);
    await act(async () => rerender(split(true)));
    expect(resets).toHaveLength(1);
    await act(async () => {
      resets[0]();
    });
    await act(async () => rerender(split(false)));
    expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('prompt-stuck-hint')).not.toBeInTheDocument();
  });

  it('keeps the hint when restored before the 10 s are up', async () => {
    const { rerender } = render(split());
    const resets = captureResetTimers();
    await reachHint(rerender);
    await act(async () => rerender(split(true)));
    expect(resets).toHaveLength(1);
    await act(async () => rerender(split(false)));
    expect(await screen.findByTestId('prompt-stuck-hint')).toBeInTheDocument();
  });

  it('keeps polling while hidden (the poller is still called)', async () => {
    const { rerender } = render(split());
    useTerminalPanePollingMock.mockClear();
    await act(async () => rerender(split(true)));
    expect(useTerminalPanePollingMock).toHaveBeenCalled();
    const args = useTerminalPanePollingMock.mock.calls.at(-1)?.[0] as { disabled?: boolean } | undefined;
    expect(args?.disabled).not.toBe(true);
  });
});
