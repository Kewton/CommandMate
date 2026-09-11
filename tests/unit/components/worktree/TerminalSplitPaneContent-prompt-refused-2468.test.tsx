/**
 * A split whose answer the route REFUSED keeps its card and says why
 * (Issue #2468).
 *
 * `POST /prompt-response` re-captures the pane before it types anything and
 * answers `200 { success: false, reason: 'prompt_no_longer_active' }` when the
 * frame no longer reads as the dialog. `handlePromptRespond` looked only at
 * `response.ok`, so it cleared the card on that refusal: the next poll put the
 * card straight back, the answer had gone nowhere, and nothing said so. Under
 * #2468 that was every press of Submit on the AskUserQuestion confirmation
 * screen.
 *
 * The polled state comes in through the `useTerminalPanePolling` seam the other
 * pane suites use, so `clearPrompt` is a spy and "the card stays" is a statement
 * about this handler rather than about the next poll.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

const CONFIRMATION_FRAME = [
  'Ready to submit your answers?',
  '',
  '❯ 1. Submit answers',
  '  2. Cancel',
].join('\n');

const clearPrompt = vi.fn();
const refresh = vi.fn(() => Promise.resolve());
const setPromptAnswering = vi.fn();

function mockPane() {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: CONFIRMATION_FRAME,
      realtimeSnippet: CONFIRMATION_FRAME,
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
        question: 'Ready to submit your answers?',
        status: 'pending',
        options: [
          { number: 1, label: 'Submit answers', isDefault: true },
          { number: 2, label: 'Cancel', isDefault: false },
        ],
      },
      messageId: 'prompt-2468',
      answering: false,
    },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering,
    clearPrompt,
    refresh,
  });
}

describe('[#2468] a refused answer from a split', () => {
  const posted: string[] = [];

  beforeEach(() => {
    posted.length = 0;
    clearPrompt.mockClear();
    refresh.mockClear();
    setPromptAnswering.mockClear();
    mockPane();
  });

  /** Render the split with `/prompt-response` answering `result`; returns the toast spy. */
  function arrange(result: Record<string, unknown>) {
    const showToast = vi.fn();
    global.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push(String(input));
        return Promise.resolve({ ok: true, status: 200, json: async () => result });
      }
      // Nothing else this split fetches is under test; leave it pending.
      return new Promise(() => {});
    }) as unknown as typeof fetch;

    render(
      <TerminalSplitPaneContent
        worktreeId="w-1"
        splitIndex={0}
        cliToolId="claude"
        availableInstances={[inst('claude')]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        autoYes={{ onToggle: vi.fn() }}
        history={{ showToast }}
      />,
    );
    return showToast;
  }

  it('keeps the card and tells the user why when the route answers success:false', async () => {
    const showToast = arrange({ success: false, reason: 'prompt_no_longer_active', answer: '1' });

    fireEvent.click(screen.getByTestId('prompt-panel'));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('worktree.promptResponse.refused', 'warning');
    });
    expect(posted).toEqual(['/api/worktrees/w-1/prompt-response']);
    expect(clearPrompt).not.toHaveBeenCalled();
    // Not stuck "answering" either: the card can be pressed again.
    await waitFor(() => {
      expect(setPromptAnswering).toHaveBeenLastCalledWith(false);
    });
  });

  it('still clears the card when the route answered (the control)', async () => {
    const showToast = arrange({ success: true });

    fireEvent.click(screen.getByTestId('prompt-panel'));

    await waitFor(() => {
      expect(clearPrompt).toHaveBeenCalledTimes(1);
    });
    expect(showToast).not.toHaveBeenCalledWith('worktree.promptResponse.refused', expect.anything());
  });

  it('has the message in both locales', () => {
    for (const locale of ['ja', 'en']) {
      const file = path.resolve(__dirname, `../../../../locales/${locale}/worktree.json`);
      const messages = JSON.parse(readFileSync(file, 'utf8')) as {
        promptResponse?: { refused?: unknown };
      };
      expect(typeof messages.promptResponse?.refused, locale).toBe('string');
      expect(String(messages.promptResponse?.refused).trim(), locale).not.toBe('');
    }
  });
});
