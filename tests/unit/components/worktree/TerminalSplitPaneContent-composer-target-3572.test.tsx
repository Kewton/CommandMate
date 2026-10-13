/**
 * Issue #3572: the "To: <agent> · <branch>" line (#3514) costs the terminal no
 * height. As a row of its own it took ~19px (11px of text plus the footer's
 * `space-y-2` gap) on top of #2598's second composer row, and the
 * `composer-two-row-2598` e2e budget (MAX_BODY_LOSS_PX = 48) went to 61px.
 * It now sits on the composer's top border, like a fieldset legend: taken out
 * of flow (`absolute`) inside a `relative` wrapper that it shares with the
 * composer, so the footer's gap is paid once, by the wrapper, as before #3514.
 *
 * jsdom has no layout; the height itself is measured by
 * tests/e2e/composer-two-row-2598.spec.ts. This pins the DOM it depends on.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
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

const WORKTREE_ID = 'wt-3572-split';

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


describe('[#3572] composer target line costs no height', () => {
  it('is out of flow, on a positioned wrapper shared with the composer only', () => {
    renderSplit({ branchName: 'feature/3572' });
    const line = screen.getByTestId('split-composer-target-0');
    const wrapper = line.parentElement!;
    expect(line.className).toMatch(/(^|\s)absolute(\s|$)/);
    // Above the composer's form, which is positioned too (#2598's handle).
    expect(line.className).toMatch(/(^|\s)z-10(\s|$)/);
    // Clicks and drags reach the height handle underneath.
    expect(line.className).toMatch(/(^|\s)pointer-events-none(\s|$)/);
    expect(wrapper.className).toMatch(/(^|\s)relative(\s|$)/);
    expect(wrapper).toHaveAttribute('data-testid', 'split-composer-0');
    expect(Array.from(wrapper.children)).toEqual([line, screen.getByTestId('message-input-0')]);
    expect(wrapper.parentElement).toBe(screen.getByTestId('split-footer-0'));
  });

  it('keeps the text, the label and the place directly above the input', () => {
    renderSplit({ branchName: 'feature/3572' });
    const line = screen.getByTestId('split-composer-target-0');
    expect(line).toHaveTextContent('worktree.terminal.composerTarget');
    expect(line).toHaveAttribute('aria-label', 'worktree.terminal.composerTargetLabel');
    expect(line).toHaveAttribute('title', 'worktree.terminal.composerTargetLabel');
    expect(line.nextElementSibling).toBe(screen.getByTestId('message-input-0'));
  });
});
