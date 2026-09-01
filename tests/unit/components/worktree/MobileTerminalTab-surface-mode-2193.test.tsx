/**
 * Mobile output-surface switching (Issue #2193).
 *
 * Epic #2192 decided the phone gets a toggle INSIDE the terminal tab rather than
 * a fifth tab, because the composer is docked below the tab content
 * (`WorktreeDetailRefactored`) — so a chat surface here keeps the send box, the
 * prompt sheet and Auto-Yes exactly where they already are. What that decision
 * costs is a control on the most cramped screen in the app, which is why the
 * ≥44px hit area and `touch-manipulation` are asserted here and not left to a
 * visual review.
 *
 * The transcript is sourced from `useSplitMessages`, the same instance-scoped
 * fetch the PC split uses, so it matches the instance whose terminal this tab is
 * showing rather than the parent's active-CLI-scoped `messages`.
 *
 * The control is a floating pill rather than a row because it has to satisfy
 * #1127's 44px AND #2106's >250px terminal floor at 360x640, and the flex column
 * has 33px between the two. That is a LAYOUT fact, so the real proof is
 * `tests/e2e/mobile-opencode-quick-keys-2106.spec.ts` in a browser; jsdom has no
 * layout, and what is asserted here is the structure that produces it — absolute
 * positioning, a `relative` column, and the pointer-events split.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { getMobileSurfaceModeStorageKey } from '@/config/surface-mode-config';

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: ({
    messages,
    cliToolId,
    worktreeId,
  }: {
    messages: Array<{ id: string }>;
    cliToolId?: string;
    worktreeId: string;
  }) => (
    <div
      data-testid="history-pane"
      data-cli-tool-id={cliToolId}
      data-worktree-id={worktreeId}
      data-message-count={String(messages.length)}
    />
  ),
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));

const { useTerminalPanePollingMock, useSplitMessagesMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
}));

import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';

const WORKTREE_ID = 'wt-mobile-2193';
const STORAGE_KEY = getMobileSurfaceModeStorageKey(WORKTREE_ID);

function mockPaneState(): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'output',
      realtimeSnippet: 'output',
      isRunning: true,
      isThinking: false,
      isSelectionListActive: false,
      isPagerActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
}

function renderTab(instanceId?: string) {
  return render(
    <MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" instanceId={instanceId} />,
  );
}

describe('[#2193] MobileTerminalTab output surface', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
    mockPaneState();
    useSplitMessagesMock.mockReturnValue({
      messages: [{ id: 'm1' }, { id: 'm2' }],
      isLoading: false,
      refresh: vi.fn(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('shows the terminal by default, with the toggle floating over it', () => {
    renderTab();

    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-chat-surface')).not.toBeInTheDocument();
    expect(screen.getByTestId('mobile-surface-mode-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-surface-mode-terminal')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('mobile-surface-mode-chat')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('does not start the history poll while the terminal is showing', () => {
    renderTab();
    // The chat surface is a separate component precisely so its hook does not
    // mount here: a terminal-mode tab must not run a second 5s fetch loop it
    // never renders.
    expect(useSplitMessagesMock).not.toHaveBeenCalled();
  });

  it('swaps the terminal for the transcript', async () => {
    renderTab();

    fireEvent.click(screen.getByTestId('mobile-surface-mode-chat'));

    await waitFor(() => {
      expect(screen.getByTestId('mobile-chat-surface')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('terminal-display')).not.toBeInTheDocument();
    const pane = screen.getByTestId('history-pane');
    expect(pane.getAttribute('data-message-count')).toBe('2');
    expect(pane.getAttribute('data-cli-tool-id')).toBe('claude');
    expect(screen.getByTestId('mobile-surface-mode-chat')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('scopes the transcript to the tab active instance', async () => {
    renderTab('claude-2');

    fireEvent.click(screen.getByTestId('mobile-surface-mode-chat'));

    await waitFor(() => {
      expect(useSplitMessagesMock).toHaveBeenCalled();
    });
    expect(useSplitMessagesMock).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      cliToolId: 'claude',
      instanceId: 'claude-2',
    });
  });

  it('switches back to the terminal', async () => {
    renderTab();

    fireEvent.click(screen.getByTestId('mobile-surface-mode-chat'));
    await waitFor(() => {
      expect(screen.getByTestId('mobile-chat-surface')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mobile-surface-mode-terminal'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('mobile-chat-surface')).not.toBeInTheDocument();
  });

  it('persists the choice, and restores it on remount', async () => {
    const { unmount } = renderTab();
    fireEvent.click(screen.getByTestId('mobile-surface-mode-chat'));

    await waitFor(() => {
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe('chat');
    });
    unmount();

    renderTab();
    await waitFor(() => {
      expect(screen.getByTestId('mobile-chat-surface')).toBeInTheDocument();
    });
  });

  it('falls back to the terminal for a corrupt persisted value', () => {
    window.localStorage.setItem(STORAGE_KEY, 'xterm');
    renderTab();
    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-chat-surface')).not.toBeInTheDocument();
  });

  it('honours ?view=chat', async () => {
    window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}?view=chat`);
    renderTab();

    await waitFor(() => {
      expect(screen.getByTestId('mobile-chat-surface')).toBeInTheDocument();
    });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('chat');
  });

  it('ignores an invalid ?view=', () => {
    window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}?view=nope`);
    renderTab();
    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
  });

  it('gives both segments a >=44px tap target and touch-manipulation', () => {
    // Issue #1127's rule for every dense mobile row. Asserted on the class list
    // because jsdom has no layout — the same approach mobile-tap-targets.test.ts
    // takes for the rows it cannot render.
    renderTab();
    for (const id of ['mobile-surface-mode-terminal', 'mobile-surface-mode-chat']) {
      const button = screen.getByTestId(id);
      expect(button.className, id).toContain('min-h-[44px]');
      expect(button.className, id).toContain('min-w-[44px]');
      expect(button.className, id).toContain('touch-manipulation');
    }
  });

  it('costs the flex column no height (Issue #2106 regression guard)', () => {
    // The first cut of #2193 put this control in the flex flow as a full-width
    // row. It cost ~53px, which came out of TerminalDisplay and left it 231px at
    // 360x640 — under the >250px floor `mobile-opencode-quick-keys-2106.spec.ts`
    // asserts. There is no in-flow placement that also keeps #1127's 44px, so
    // the control has to be absolutely positioned. jsdom has no layout, so this
    // is asserted structurally: the region must be the flex column's ONLY
    // in-flow child above the footer rows.
    renderTab();
    const toggle = screen.getByTestId('mobile-surface-mode-toggle');
    expect(toggle.className).toContain('absolute');
    expect(toggle.className).not.toContain('shrink-0');
    expect(screen.getByTestId('mobile-terminal-region').className).toContain('flex-1');

    // ...and it is a *previous sibling* of the region inside a `relative`
    // column, so it is positioned against the column and survives the region
    // collapsing to zero height.
    const column = toggle.parentElement!;
    expect(column.className).toContain('relative');
    expect(column.className).toContain('flex-col');
  });

  it('leaves the terminal clickable everywhere but the two buttons', () => {
    // The pill floats over the output, so it must not swallow taps meant for
    // the terminal (scrolling, selection) outside its own 44px squares.
    renderTab();
    expect(screen.getByTestId('mobile-surface-mode-toggle').className).toContain(
      'pointer-events-none',
    );
    for (const id of ['mobile-surface-mode-terminal', 'mobile-surface-mode-chat']) {
      expect(screen.getByTestId(id).className, id).toContain('pointer-events-auto');
    }
  });

  it('clips the output region so a collapsed terminal cannot steal clicks below it', () => {
    // TerminalDisplay's `role="log"` carries `p-4` + a border, and border-box
    // sizing cannot shrink a box below its own padding — so a zero-height region
    // still PAINTED 34px over the quick-keys toggle underneath, which made
    // `opencode-quick-keys-toggle` unclickable while reporting itself visible.
    renderTab();
    expect(screen.getByTestId('mobile-terminal-region').className).toContain('overflow-hidden');
  });

  it('names both segments for assistive tech now that they are icon-only', () => {
    renderTab();
    const group = screen.getByTestId('mobile-surface-mode-toggle');
    expect(group).toHaveAttribute('role', 'group');
    expect(group).toHaveAttribute('aria-label');
    for (const id of ['mobile-surface-mode-terminal', 'mobile-surface-mode-chat']) {
      // The visible label was dropped to keep the pill narrow, so the
      // accessible name is now the ONLY name.
      expect(screen.getByTestId(id), id).toHaveAttribute('aria-label');
      expect(screen.getByTestId(id), id).toHaveAttribute('title');
    }
  });
});
