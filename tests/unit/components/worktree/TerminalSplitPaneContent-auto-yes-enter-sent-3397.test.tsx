/**
 * The PC split's prompt window says "Auto-Yes sent Enter" for a window Auto-Yes
 * sent its Enter to (Issue #3397).
 *
 * `useTerminalPanePolling`'s `prompt.autoYesEnterSent` reaches the real
 * `PromptPanel`. How the hook derives it from the poll and the push is pinned
 * in `tests/unit/hooks/useTerminalPanePolling-enter-fallback-3397.test.ts`.
 * Harness copied from `TerminalSplitPaneContent-prompt-unanswerable-2870.test.tsx`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
let autoYesEnterSent: boolean | undefined;

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
      messageId: 'prompt-3397',
      answering: false,
      answerable,
      autoYesEnterSent,
    },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(() => Promise.resolve()),
  }));
}

function split(autoYesEnabled?: boolean): React.ReactElement {
  return (
    <TerminalSplitPaneContent
      worktreeId="w-3397"
      splitIndex={0}
      cliToolId="codex"
      availableInstances={[inst('codex')]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn(), ...(autoYesEnabled === undefined ? {} : { enabled: autoYesEnabled }) }}
      history={{ showToast: vi.fn() }}
    />
  );
}

beforeEach(() => {
  answerable = false;
  autoYesEnterSent = undefined;
  mockPane();
  global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
});

describe('[#3397] the PC prompt window and the Enter record', () => {
  it('says Auto-Yes sent Enter, in place of the warning and the link', () => {
    autoYesEnterSent = true;
    render(split());
    expect(screen.getByTestId('prompt-auto-yes-enter-sent')).toHaveTextContent(
      'worktree.promptResponse.autoYesEnterSent',
    );
    expect(screen.queryByTestId('prompt-unanswerable-hint')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prompt-stuck-hint-link')).not.toBeInTheDocument();
  });

  it.each([[false], [undefined]])('autoYesEnterSent %s: the warning and the link, as before', (value) => {
    autoYesEnterSent = value;
    render(split());
    expect(screen.getByTestId('prompt-unanswerable-hint')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-stuck-hint-link')).toBeInTheDocument();
    expect(screen.queryByTestId('prompt-auto-yes-enter-sent')).not.toBeInTheDocument();
  });

  it('follows the hook when the record arrives after the window was drawn', () => {
    autoYesEnterSent = false;
    const { rerender } = render(split());
    expect(screen.queryByTestId('prompt-auto-yes-enter-sent')).not.toBeInTheDocument();

    autoYesEnterSent = true;
    rerender(split());
    expect(screen.getByTestId('prompt-auto-yes-enter-sent')).toBeInTheDocument();

    autoYesEnterSent = false;
    rerender(split());
    expect(screen.queryByTestId('prompt-auto-yes-enter-sent')).not.toBeInTheDocument();
    expect(screen.getByTestId('prompt-stuck-hint-link')).toBeInTheDocument();
  });
});

/**
 * Review round 3: Auto-Yes ON. The panel is hidden under Auto-Yes for a prompt
 * Auto-Yes answers, and the Enter only goes out under Auto-Yes — so the
 * `answerable === false` exception is what makes any of this visible.
 */
describe('[#3397] the PC prompt window under Auto-Yes', () => {
  it('unreadable screen, Enter sent: shown, and says so', () => {
    answerable = false;
    autoYesEnterSent = true;
    render(split(true));
    expect(screen.getByTestId('prompt-auto-yes-enter-sent')).toBeInTheDocument();
    expect(screen.queryByTestId('prompt-stuck-hint-link')).not.toBeInTheDocument();
  });

  it.each([[false], [undefined]])('unreadable screen, autoYesEnterSent %s: shown with the warning and the link', (value) => {
    answerable = false;
    autoYesEnterSent = value;
    render(split(true));
    expect(screen.getByTestId('prompt-unanswerable-hint')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-stuck-hint-link')).toBeInTheDocument();
  });

  it.each([[true], [undefined]])('readable screen (answerable %s): hidden as before', (value) => {
    answerable = value;
    autoYesEnterSent = false;
    render(split(true));
    expect(screen.queryByTestId('prompt-panel')).not.toBeInTheDocument();
  });

  it('control: Auto-Yes off, the readable screen is shown', () => {
    answerable = true;
    render(split(false));
    expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
  });
});

