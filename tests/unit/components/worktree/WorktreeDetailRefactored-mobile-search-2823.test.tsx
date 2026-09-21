/**
 * Searching on the phone, wired through the whole screen (Issue #2823).
 *
 * The real `WorktreeDetailRefactored`, `MobileTerminalTab`,
 * `MobileTerminalActionsSheet` and `ChatTranscript`, because every claim is a
 * seam: the screen knows the surface, its sheet sits BESIDE the tab, and the
 * transcript that must answer is three components down inside the tab. The
 * chat case also pins the order against the sheet's focus trap, which restores
 * focus to "More actions" on close: the search input must end up focused.
 *
 * next-intl is the global echo mock: labels read as their keys.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { getMobileSurfaceModeStorageKey } from '@/config/surface-mode-config';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-2823',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => true, MOBILE_BREAKPOINT: 768 }));
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true, width: 288, isMobileDrawerOpen: false, toggle: vi.fn(),
    setWidth: vi.fn(), openMobileDrawer: vi.fn(), closeMobileDrawer: vi.fn(),
  }),
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(), isCatalogStale: false,
  }),
}));
vi.mock('@/components/error/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: ({ searchBarTopClassName }: { searchBarTopClassName?: string }) => (
    <div data-testid="terminal-display" data-search-bar-top={searchBarTopClassName}>
      <div role="log" />
    </div>
  ),
}));
vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));

const { useTerminalPanePollingMock, useSplitMessagesMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({ useTerminalPanePolling: useTerminalPanePollingMock }));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
  SPLIT_MESSAGES_POLL_INTERVAL_MS: 5000,
}));

import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';

const WORKTREE_ID = 'wt-2823';
const SEARCH_INPUT_LABEL = 'worktree.history.search.keywordLabel';
const heard = { terminal: vi.fn(), chat: vi.fn() };

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: `http://localhost/api/worktrees/${WORKTREE_ID}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'row 1', realtimeSnippet: 'row 1', isRunning: true, isThinking: false,
      sessionStatus: 'ready', isSelectionListActive: false, isPagerActive: false,
      isUnclassifiedActive: false, composerText: '', attaching: false, autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()) });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const u = String(url);
      if (u.includes('/current-output')) {
        return Promise.resolve(jsonResponse({ isRunning: true, fullOutput: 'row 1', realtimeSnippet: 'row 1', thinking: false, isPromptWaiting: false, promptData: null }));
      }
      if (u.includes('/messages')) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(
        jsonResponse({
          id: WORKTREE_ID,
          name: 'feature/2823',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
          selectedAgents: ['claude'],
          agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }],
          sessionStatusByCli: { claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false } },
        }),
      );
    }),
  );
  window.addEventListener('terminal-search-open', heard.terminal);
  window.addEventListener('chat-search-open', heard.chat);
});

afterEach(() => {
  window.removeEventListener('terminal-search-open', heard.terminal);
  window.removeEventListener('chat-search-open', heard.chat);
  heard.terminal.mockClear();
  heard.chat.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

async function renderScreen(surface: 'terminal' | 'chat'): Promise<void> {
  if (surface === 'chat') window.localStorage.setItem(getMobileSurfaceModeStorageKey(WORKTREE_ID), 'chat');
  render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
  await screen.findByTestId(surface === 'chat' ? 'mobile-chat-surface' : 'terminal-display');
}

/** Focus "More actions" (what the sheet's trap restores on close), open the sheet, return the row. */
function openSearchRow(): HTMLElement {
  const more = screen.getByTestId('mobile-more-actions-button');
  more.focus();
  fireEvent.click(more);
  return screen.getByTestId('actions-sheet-search');
}

describe('[#2823] the terminal surface keeps the pre-#2823 row', () => {
  it('reads "Search terminal", raises terminal-search-open only, and puts the bar below the pill', async () => {
    await renderScreen('terminal');
    expect(screen.getByTestId('terminal-display')).toHaveAttribute('data-search-bar-top', 'top-16');

    const row = openSearchRow();
    expect(row).toHaveTextContent('worktree.terminal.searchTerminal');
    fireEvent.click(row);

    expect(heard.terminal).toHaveBeenCalledTimes(1);
    expect(heard.chat).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mobile-terminal-actions-sheet')).toBeNull();
  });
});

describe('[#2823] the chat surface searches the conversation', () => {
  it('reads "Search this conversation" and opens the transcript bar, focused, below the pill', async () => {
    await renderScreen('chat');
    expect(screen.queryByTestId('chat-transcript-search-toggle')).toBeNull();

    const row = openSearchRow();
    expect(row).toHaveTextContent('worktree.chatTranscript.openSearch');
    fireEvent.click(row);

    expect(heard.chat).toHaveBeenCalledTimes(1);
    expect(heard.terminal).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mobile-terminal-actions-sheet')).toBeNull();
    const input = screen.getByLabelText(SEARCH_INPUT_LABEL);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole('search').parentElement?.parentElement?.className.split(' ')).toContain('top-16');
  });

  it('puts focus back in the input when the bar is already open', async () => {
    await renderScreen('chat');
    fireEvent.click(openSearchRow());
    const input = screen.getByLabelText(SEARCH_INPUT_LABEL);

    fireEvent.click(openSearchRow());

    expect(heard.chat).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(input);
    expect(screen.getAllByLabelText(SEARCH_INPUT_LABEL)).toHaveLength(1);
  });

  it('keeps the pre-#2823 row on another tab, where neither surface is mounted', async () => {
    await renderScreen('chat');
    fireEvent.click(screen.getByTestId('mobile-tab-history'));
    await screen.findByTestId('history-pane');

    expect(openSearchRow()).toHaveTextContent('worktree.terminal.searchTerminal');
  });
});
