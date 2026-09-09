/**
 * The chat surface gets the History column beside it (Issue #2446).
 *
 * Before this Issue the chat surface (#2193) filled the split's output half on
 * its own and the Action bar's «History» toggle was disabled once every split
 * was in chat mode (#2259). That was tolerable only while the chat surface was
 * itself a full transcript; #2445 takes past sessions out of it, which would
 * leave chat mode with nowhere at all to read them.
 *
 * So both surfaces now compose the SAME row —
 * `[History column | PaneResizer | output]` — off the SAME
 * `useHistoryPaneState`. That last part is the load-bearing half: "is the
 * column showing" and "how wide is it" are one setting, so flipping the output
 * surface must never make the column appear, vanish or resize.
 *
 * The real `useHistoryPaneState` is used here on purpose. A stubbed one would
 * pass even if each surface had grown its own copy of the state, which is the
 * defect this file exists to catch.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { getSplitSurfaceModeStorageKey } from '@/config/surface-mode-config';
import {
  HISTORY_VISIBLE_STORAGE_KEY,
  HISTORY_WIDTH_STORAGE_KEY,
} from '@/hooks/useHistoryPaneState';
import { makeHistoryNamespace } from '@/lib/terminal-highlight';
import { makeChatSearchNamespace } from '@/lib/chat/chat-search-namespace';
import { MAX_SPLITS } from '@/config/terminal-split-config';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

/**
 * The column, publishing the props that decide WHAT it lists. `onCollapse` is
 * rendered as a real button because the column's own collapse affordance has to
 * keep working from the chat row (its `aria-controls` names the slot id, which
 * is the same id in either row).
 */
vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: ({
    splitIndex,
    cliToolId,
    messages,
    showArchived,
    historyUserOnly,
    historyDisplayLimit,
    onCollapse,
  }: {
    splitIndex?: number;
    cliToolId?: string;
    messages: Array<{ id: string }>;
    showArchived?: boolean;
    historyUserOnly?: boolean;
    historyDisplayLimit?: number;
    onCollapse?: () => void;
  }) => (
    <div
      data-testid="history-pane"
      data-split-index={String(splitIndex)}
      data-cli-tool-id={cliToolId}
      data-message-count={String(messages.length)}
      data-show-archived={String(showArchived)}
      data-user-only={String(historyUserOnly)}
      data-display-limit={String(historyDisplayLimit)}
    >
      <button
        type="button"
        data-testid="history-collapse"
        aria-controls={`split-history-slot-${splitIndex}`}
        onClick={onCollapse}
      />
    </div>
  ),
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));

vi.mock('@/components/worktree/ChatSurface', () => ({
  ChatSurface: ({
    history,
    messages,
  }: {
    history?: { splitIndex?: number; showArchived?: boolean };
    messages: Array<{ id: string }>;
  }) => (
    <div
      data-testid="chat-surface"
      data-split-index={String(history?.splitIndex)}
      data-message-count={String(messages.length)}
    />
  ),
}));

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: ({ splitIndex }: { splitIndex: number }) => (
    <div data-testid={`message-input-${splitIndex}`} />
  ),
}));

vi.mock('@/components/worktree/NavigationButtons', () => ({
  NavigationButtons: () => <div data-testid="navigation-buttons" />,
}));

vi.mock('@/components/worktree/TerminalEscapeHatch', () => ({
  TerminalEscapeHatch: () => <div data-testid="terminal-escape-hatch" />,
}));

vi.mock('@/components/worktree/PromptPanel', () => ({
  PromptPanel: () => null,
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

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({
    messages: [{ id: 'm1', content: 'hello' }],
    isLoading: false,
    refresh: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

const WORKTREE_ID = 'wt-2446';

function renderSplit(
  splitIndex: number,
  history?: Record<string, unknown>,
): React.ReactElement {
  return (
    <TerminalSplitPaneContent
      worktreeId={WORKTREE_ID}
      splitIndex={splitIndex}
      cliToolId="claude"
      availableInstances={[inst('claude'), inst('codex')]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
      history={history}
    />
  );
}

/** Open the split in chat mode from the start (the persisted deep link). */
function seedChatMode(splitIndex: number): void {
  window.localStorage.setItem(
    getSplitSurfaceModeStorageKey(WORKTREE_ID, splitIndex),
    'chat',
  );
}

describe('[#2446] the History column in chat mode', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ isRunning: true, fullOutput: 'frame', thinking: false }),
      }),
    ) as unknown as typeof fetch;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('lays the chat row out as [column | resizer | chat surface]', async () => {
    seedChatMode(0);
    render(renderSplit(0));

    await waitFor(() => {
      expect(screen.getByTestId('split-chat-slot-0')).toBeInTheDocument();
    });
    const row = screen.getByTestId('split-chat-row-0');
    expect(row.children).toHaveLength(3);
    expect(row.children[0]).toBe(screen.getByTestId('split-history-slot-0'));
    expect(row.children[1]).toHaveAttribute('role', 'separator');
    expect(row.children[2]).toBe(screen.getByTestId('split-chat-output-0'));
  });

  it('hands the column the same filters the terminal row does', async () => {
    const history = {
      showArchived: true,
      historyUserOnly: true,
      historyDisplayLimit: 25,
    };
    render(renderSplit(0, history));
    const inTerminalMode = screen.getByTestId('history-pane').dataset;
    const terminalSnapshot = {
      showArchived: inTerminalMode.showArchived,
      userOnly: inTerminalMode.userOnly,
      displayLimit: inTerminalMode.displayLimit,
      messageCount: inTerminalMode.messageCount,
      cliToolId: inTerminalMode.cliToolId,
    };
    expect(terminalSnapshot).toEqual({
      showArchived: 'true',
      userOnly: 'true',
      displayLimit: '25',
      messageCount: '1',
      cliToolId: 'claude',
    });

    fireEvent.click(screen.getByTestId('surface-mode-chat-0'));
    await waitFor(() => {
      expect(screen.getByTestId('split-chat-slot-0')).toBeInTheDocument();
    });

    // "Show archived" is a History-column control, and it still reaches the
    // column when the output half is chat. What the chat surface does with the
    // archived rows is Issue #2445's question, not this one's.
    const inChatMode = screen.getByTestId('history-pane').dataset;
    expect({
      showArchived: inChatMode.showArchived,
      userOnly: inChatMode.userOnly,
      displayLimit: inChatMode.displayLimit,
      messageCount: inChatMode.messageCount,
      cliToolId: inChatMode.cliToolId,
    }).toEqual(terminalSnapshot);
  });

  it('keeps the column visible and the same width across a mode switch', async () => {
    window.localStorage.setItem(HISTORY_WIDTH_STORAGE_KEY, '55');
    render(renderSplit(0));

    await waitFor(() => {
      expect(screen.getByTestId('split-history-slot-0').style.width).toBe('55%');
    });

    fireEvent.click(screen.getByTestId('surface-mode-chat-0'));
    await waitFor(() => {
      expect(screen.getByTestId('split-chat-slot-0')).toBeInTheDocument();
    });
    expect(screen.getByTestId('split-history-slot-0').style.width).toBe('55%');

    // ...and back. A per-surface copy of the state would drift on this leg.
    fireEvent.click(screen.getByTestId('surface-mode-terminal-0'));
    await waitFor(() => {
      expect(screen.getByTestId('split-terminal-row-0')).toBeInTheDocument();
    });
    expect(screen.getByTestId('split-history-slot-0').style.width).toBe('55%');
  });

  it('honours a column hidden in terminal mode when chat opens', async () => {
    window.localStorage.setItem(HISTORY_VISIBLE_STORAGE_KEY, 'false');
    seedChatMode(0);
    render(renderSplit(0));

    await waitFor(() => {
      expect(screen.getByTestId('split-chat-slot-0')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('split-history-slot-0')).not.toBeInTheDocument();
    expect(screen.getByTestId('split-chat-output-0').style.width).toBe('100%');
  });

  it("collapses from the column's own button, leaving the chat surface full width", async () => {
    seedChatMode(0);
    render(renderSplit(0));

    await waitFor(() => {
      expect(screen.getByTestId('split-history-slot-0')).toBeInTheDocument();
    });
    // The collapse button names the slot it closes, and that slot is in the
    // chat row — same DOM id the terminal row uses.
    expect(screen.getByTestId('history-collapse')).toHaveAttribute(
      'aria-controls',
      'split-history-slot-0',
    );

    fireEvent.click(screen.getByTestId('history-collapse'));

    await waitFor(() => {
      expect(screen.queryByTestId('split-history-slot-0')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('split-chat-output-0').style.width).toBe('100%');
    // The collapse is the shared setting, so the terminal row agrees.
    expect(window.localStorage.getItem(HISTORY_VISIBLE_STORAGE_KEY)).toBe('false');
  });

  it('gives each split its own column slot id in chat mode', async () => {
    seedChatMode(0);
    seedChatMode(1);
    render(
      <>
        {renderSplit(0)}
        {renderSplit(1)}
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('split-chat-slot-1')).toBeInTheDocument();
    });
    expect(document.getElementById('split-history-slot-0')).toBeInTheDocument();
    expect(document.getElementById('split-history-slot-1')).toBeInTheDocument();
    expect(screen.getAllByTestId('history-pane')).toHaveLength(2);
  });
});

/**
 * `CSS.highlights` is ONE global registry, so the column and the transcript
 * beside it must never write the same entry — one surface's search would erase
 * the other's marks. They were already separate namespaces (#744 / #2232); what
 * changed with #2446 is that they are now guaranteed to be on screen together,
 * which is what makes this a standing requirement rather than a coincidence.
 */
describe('[#2446] History and chat search highlights cannot collide', () => {
  it('gives the two surfaces disjoint highlight names for every split', () => {
    const names = new Set<string>();
    for (let i = 0; i < MAX_SPLITS; i += 1) {
      for (const ns of [makeHistoryNamespace(i), makeChatSearchNamespace(i)]) {
        for (const name of [
          ns.highlightName,
          ns.currentHighlightName,
          ns.fallbackOverlayId,
        ]) {
          expect(names.has(name), `duplicate highlight name: ${name}`).toBe(false);
          names.add(name);
        }
      }
    }
    expect(names.size).toBe(MAX_SPLITS * 2 * 3);
  });
});
