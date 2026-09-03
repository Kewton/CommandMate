/**
 * The phone's DOCKED navigation pad stands down for the dialog card (Issue #2254).
 *
 * This is the seam #2254 could most easily have got wrong, because the two
 * controls have no common owner. `NavigationButtons` is docked above the
 * composer in `WorktreeDetailRefactored`, gated on the screen's own
 * `isSelectionListActive`; the surface mode that decides whether the chat card
 * is drawing a pad of its own belongs to `MobileTerminalTab`, several components
 * below it. Nothing in the tree carried that fact upwards before this Issue.
 *
 * So the whole screen is rendered — the real `MobileContent`, the real
 * `MobileTerminalTab`, the real `ChatSurface` — because a test that stubbed
 * either end would prove the wiring by assuming it. Both pads resolve to the
 * same mocked component, which makes the property a COUNT: exactly one arrow pad
 * on screen, in the right place, in each mode.
 *
 * Three cases, and the third is the one a naive implementation fails:
 *
 *  1. terminal mode → the docked pad, as before #2254;
 *  2. chat mode reached by tapping the toggle → the card's pad only;
 *  3. chat mode RESTORED from localStorage with no tap at all → the card's pad
 *     only. The mode is resolved in an effect, so a screen that only listened
 *     for the toggle would show both here.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { getMobileSurfaceModeStorageKey } from '@/config/surface-mode-config';
import type { ChatMessage } from '@/types/models';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-2254-dock',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => true,
  MOBILE_BREAKPOINT: 768,
}));

vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true,
    width: 288,
    isMobileDrawerOpen: false,
    toggle: vi.fn(),
    setWidth: vi.fn(),
    openMobileDrawer: vi.fn(),
    closeMobileDrawer: vi.fn(),
  }),
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(), isCatalogStale: false,
  }),
}));

vi.mock('@/hooks/useUpdateCheck', () => ({
  useUpdateCheck: () => ({ data: null, loading: false, error: null }),
}));

vi.mock('@/hooks/useFileTabs', () => ({
  useFileTabs: () => [
    { tabs: [], activeIndex: null },
    {
      dispatch: vi.fn(),
      openFile: vi.fn().mockReturnValue('opened'),
      closeTab: vi.fn(),
      activateTab: vi.fn(),
      onFileRenamed: vi.fn(),
      onFileDeleted: vi.fn(),
      moveToFront: vi.fn(),
    },
  ],
}));

vi.mock('@/components/error/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({ messages }: { messages: ChatMessage[] }) => (
    <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

// ONE mock for BOTH mounts — the docked pad and the card's. That is what turns
// "which one is showing" into a count that cannot be satisfied by drawing both.
vi.mock('@/components/worktree/NavigationButtons', () => ({
  NavigationButtons: ({ showPagerKeys }: { showPagerKeys?: boolean }) => (
    <div data-testid="navigation-buttons" data-pager-keys={String(showPagerKeys ?? false)} />
  ),
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
  SPLIT_MESSAGES_POLL_INTERVAL_MS: 5000,
}));

import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';

const WORKTREE_ID = 'wt-2254-dock';
const STORAGE_KEY = getMobileSurfaceModeStorageKey(WORKTREE_ID);
const FRAME = ['Select model', '❯ 1. Default', '  2. Opus', 'Esc to cancel'].join('\n');

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: `http://localhost/api/worktrees/${WORKTREE_ID}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * The TAB's pane state (mocked hook) — what the chat surface's card renders from.
 *
 * The DOCKED pad is gated on the screen's own `isSelectionListActive`, which the
 * controller reads from its `/current-output` fetch below, so both halves of the
 * "one pad, not two" property have to be armed independently. That split is not
 * an artefact of the test: it is exactly why the duplication existed.
 */
function mockPaneState(): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: FRAME,
      realtimeSnippet: FRAME,
      isRunning: true,
      isThinking: false,
      sessionStatus: 'waiting',
      isSelectionListActive: true,
      isPagerActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
  useSplitMessagesMock.mockReturnValue({
    messages: [],
    isLoading: false,
    refresh: vi.fn(() => Promise.resolve()),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  mockPaneState();

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/current-output')) {
        // The screen's own poll. `isSelectionListActive` here is what arms the
        // DOCKED pad.
        return Promise.resolve(
          jsonResponse({
            isRunning: true,
            fullOutput: FRAME,
            realtimeSnippet: FRAME,
            thinking: false,
            sessionStatus: 'waiting',
            isSelectionListActive: true,
            isPagerActive: false,
            isUnclassifiedActive: false,
            isPromptWaiting: false,
            promptData: null,
          }),
        );
      }
      if (typeof url === 'string' && url.includes('/messages')) {
        return Promise.resolve(jsonResponse([]));
      }
      return Promise.resolve(
        jsonResponse({
          id: WORKTREE_ID,
          name: 'feature/2254',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('[#2254] the phone shows exactly one navigation pad', () => {
  it('draws the docked pad in terminal mode, unchanged from before #2254', async () => {
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId('navigation-buttons')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('navigation-buttons')).toHaveLength(1);
    // It is NOT the card's: there is no card in terminal mode.
    expect(screen.queryByTestId('chat-dialog-card')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
  });

  it('moves the pad into the card when the toggle switches to chat', async () => {
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId('mobile-surface-mode-chat')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('mobile-surface-mode-chat'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-dialog-card')).toBeInTheDocument();
    });
    const pads = screen.getAllByTestId('navigation-buttons');
    expect(pads).toHaveLength(1);
    expect(screen.getByTestId('chat-dialog-card-actions')).toContainElement(pads[0]);
  });

  it('stands the docked pad down for a tab RESTORED in chat mode, with no tap', async () => {
    // The case a change-only listener misses: nothing is toggled here. The mode
    // comes out of localStorage inside `MobileTerminalTab`'s effect, and the
    // screen learns it through `onSurfaceModeChange` firing on mount.
    window.localStorage.setItem(STORAGE_KEY, 'chat');
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-dialog-card')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('navigation-buttons')).toHaveLength(1);
    });
    expect(screen.getByTestId('chat-dialog-card-actions')).toContainElement(
      screen.getByTestId('navigation-buttons'),
    );
  });

  it('keeps the docked composer and prompt sheet where they were', async () => {
    // #2254 gated ONE control. The composer half is #2193's contract and must
    // not have been swept up in it.
    window.localStorage.setItem(STORAGE_KEY, 'chat');
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-dialog-card')).toBeInTheDocument();
    });
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});
