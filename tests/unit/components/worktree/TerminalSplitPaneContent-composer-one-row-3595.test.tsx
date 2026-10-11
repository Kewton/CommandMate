/**
 * Issue #3595: the PC worktree screen's split pane asks its composer for the
 * one-row layout (`oneRowWhenWide`). The other two mounts of `MessageInput` —
 * the phone's docked composer (WorktreeDetailRefactored) and the /sessions
 * tile (SessionTile) — do not, so they are drawn as before; the DOM that
 * follows from the prop is pinned in MessageInput-one-row-3595.test.tsx.
 *
 * @vitest-environment jsdom
 */

import fs from 'fs';
import path from 'path';
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

const { messageInputProps } = vi.hoisted(() => ({
  messageInputProps: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: (props: { splitIndex: number } & Record<string, unknown>) => {
    messageInputProps.push(props);
    return <div data-testid={`message-input-${props.splitIndex}`} />;
  },
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

const WORKTREE_ID = 'wt-3595-split';

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
  messageInputProps.length = 0;
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


describe('[#3595] the split pane asks for the one-row composer', () => {
  it('passes oneRowWhenWide to its MessageInput', () => {
    renderSplit({ branchName: 'feature/3595' });
    expect(screen.getByTestId('message-input-0')).toBeInTheDocument();
    expect(messageInputProps.length).toBeGreaterThan(0);
    expect(messageInputProps.at(-1)!.oneRowWhenWide).toBe(true);
  });

  it('keeps the target line on the composer border, unchanged by the one-row layout', () => {
    renderSplit({ branchName: 'feature/3595' });
    const line = screen.getByTestId('split-composer-target-0');
    expect(line.className).toMatch(/(^|\s)absolute(\s|$)/);
    expect(line.nextElementSibling).toBe(screen.getByTestId('message-input-0'));
  });

  // Negative control: the phone and the /sessions tile never ask for it, so
  // their composer is the one MessageInput draws without the prop.
  it.each([
    'src/components/worktree/WorktreeDetailRefactored.tsx',
    'src/components/sessions/SessionTile.tsx',
  ])('is not asked for by %s', file => {
    const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
    expect(source).toMatch(/<MessageInput\b/);
    expect(source).not.toMatch(/oneRowWhenWide/);
  });
});
