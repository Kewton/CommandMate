/**
 * The answer panel stays up for a CHECKBOX question while Auto-Yes is ON
 * (Issue #2755 §3).
 *
 * Auto-Yes hides `PromptPanel` because the poller is supposed to be answering
 * instead. On a checkbox question it is measured never to answer — a digit
 * ticks a box and the confirm is a separate row, so `resolveBaseAnswer` returns
 * null rather than send half an answer — and hiding the panel there left a
 * screen that could be answered neither automatically nor by hand until the
 * operator noticed and turned Auto-Yes off.
 *
 * So the rule is narrow: this ONE payload shape is shown whatever Auto-Yes is
 * doing, and every other prompt keeps the gate exactly as it was.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
vi.mock('@/components/worktree/PromptPanel', () => ({
  PromptPanel: ({ visible }: { visible: boolean }) =>
    visible ? <div data-testid="prompt-panel" /> : null,
}));

function getUrlString(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** `/current-output` for a checkbox question, or for the single-select one. */
function payload(multiSelect: boolean): Record<string, unknown> {
  return {
    isRunning: true,
    fullOutput: '',
    thinking: false,
    isPromptWaiting: true,
    promptData: {
      type: 'multiple_choice',
      status: 'pending',
      question: 'Which caches should I clear?',
      isAskUserQuestion: true,
      ...(multiSelect ? { multiSelect: true } : {}),
      options: [
        { number: 1, label: 'node_modules', isDefault: true, ...(multiSelect ? { checked: false } : {}) },
        { number: 2, label: 'dist', isDefault: false, ...(multiSelect ? { checked: true } : {}) },
      ],
    },
  };
}

describe('[#2755] Auto-Yes and the checkbox answer panel', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function arrange(options: { multiSelect: boolean; autoYesEnabled: boolean }) {
    mockFetch.mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = getUrlString(input);
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
      }
      if (url.includes('/current-output')) {
        return Promise.resolve({ ok: true, json: async () => payload(options.multiSelect) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(
      <TerminalSplitPaneContent
        worktreeId="w-1"
        splitIndex={0}
        cliToolId="command-code"
        availableInstances={[inst('command-code')]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        autoYes={{ enabled: options.autoYesEnabled, onToggle: vi.fn() }}
      />,
    );
  }

  it('shows the panel for a checkbox question even with Auto-Yes ON', async () => {
    arrange({ multiSelect: true, autoYesEnabled: true });
    await waitFor(() => {
      expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
    });
  });

  it('shows it with Auto-Yes OFF too, which is the unchanged half', async () => {
    arrange({ multiSelect: true, autoYesEnabled: false });
    await waitFor(() => {
      expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
    });
  });

  it('still hides the panel for a SINGLE-select prompt under Auto-Yes', async () => {
    // The gate this Issue narrowed rather than removed: Auto-Yes does answer a
    // single-select prompt, and showing the panel for one would put a human
    // and the poller on the same dialog.
    arrange({ multiSelect: false, autoYesEnabled: true });

    // The panel is gated on the payload, so wait for the payload to have
    // arrived before concluding it is absent: assert the pane rendered, then
    // that no panel came with it.
    await waitFor(() => {
      expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('prompt-panel')).not.toBeInTheDocument();
  });

  it('shows the single-select panel again once Auto-Yes is off', async () => {
    arrange({ multiSelect: false, autoYesEnabled: false });
    await waitFor(() => {
      expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
    });
  });
});
