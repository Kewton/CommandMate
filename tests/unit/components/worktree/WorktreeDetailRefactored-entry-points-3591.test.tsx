/**
 * Issue #3591 (2nd contract): the activity pane's entry points on the second
 * row, wired into the whole PC screen.
 *
 * Real pieces: `WorktreeDetailRefactored` → `WorktreeDetailDesktop` (its
 * outside-press ignore list, the chip's handler) → `usePaneOverlayDismiss`,
 * the real `VerificationStatusChip` and the real second-row "…"
 * (`ActionBarItemsOverflow`). Stubbed: `TerminalContainer` / `FilePanelSplit`
 * pass the terminal region through, and `TerminalSplitContainer` draws only
 * its `actionBarItems` and a "…" (as when the chip is folded), so the chip and
 * "…" sit where the screen puts them without a real terminal.
 *
 * - A press on the second row's "…" does not close the open pane (it is how
 *   the chip is reached on a narrow window).
 * - The chip toggles Verification like the header's tools: open → close; with
 *   another pane open it switches.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-3589',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
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
    groups: [],
    filteredGroups: [],
    allCommands: [],
    loading: false,
    error: null,
    filter: '',
    setFilter: vi.fn(),
    refresh: vi.fn(),
    isCatalogStale: false,
  }),
}));

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: vi.fn() }),
  SPLIT_MESSAGES_POLL_INTERVAL_MS: 5000,
}));

vi.mock('@/hooks/useFileTabs', () => ({
  useFileTabs: () => [
    { tabs: [], activeIndex: null },
    {
      dispatch: vi.fn(),
      openFile: vi.fn(),
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

vi.mock('@/components/worktree/TerminalContainer', () => ({
  TerminalContainer: ({ terminal }: { terminal: React.ReactNode }) => (
    <div data-testid="terminal-column">
      <textarea data-testid="composer" />
      {terminal}
    </div>
  ),
}));

vi.mock('@/components/worktree/FilePanelSplit', () => ({
  FilePanelSplit: ({ terminal }: { terminal: React.ReactNode }) => <>{terminal}</>,
}));

vi.mock('@/components/worktree/TerminalSplitContainer', async () => {
  const actual = await vi.importActual<typeof import('@/components/worktree/TerminalSplitContainer')>(
    '@/components/worktree/TerminalSplitContainer',
  );
  return {
    ...actual,
    TerminalSplitContainer: ({ actionBarItems }: { actionBarItems?: React.ReactNode }) => (
      <div data-testid="split-action-bar">
        <span data-testid="split-action-bar-items">{actionBarItems}</span>
        <actual.ActionBarItemsOverflow label="More">
          <span data-testid="folded-item">folded</span>
        </actual.ActionBarItemsOverflow>
      </div>
    ),
  };
});

vi.mock('@/components/worktree/FileTreeView', () => ({
  FileTreeView: () => <div data-testid="file-tree-view" />,
}));
vi.mock('@/components/worktree/GitPane', () => ({
  GitPane: () => <div data-testid="git-pane" />,
}));
vi.mock('@/components/worktree/VerificationPane', () => ({
  VerificationPane: () => <div data-testid="verification-pane" />,
}));

import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';

const WORKTREE_ID = 'wt-3591';

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
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/messages')) {
        return Promise.resolve(jsonResponse([]));
      }
      return Promise.resolve(
        jsonResponse({
          id: WORKTREE_ID,
          name: 'feature/3591',
          path: '/tmp/wt-3591',
          repositoryPath: '/tmp/repo',
          repositoryName: 'Repo',
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
});

async function renderScreen() {
  render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
  await screen.findByTestId('terminal-column');
  return screen.findByTestId('verification-status-chip');
}

function activePane(): string | null {
  return screen.queryByTestId('activity-pane')?.getAttribute('data-active') ?? null;
}

describe('[#3591] the second row "…" is an entry point, not an outside press', () => {
  it('keeps Verification open when the second row "…" is pressed', async () => {
    const chip = await renderScreen();
    fireEvent.click(chip);
    await screen.findByTestId('activity-pane-slot');
    expect(activePane()).toBe('verification');

    const more = screen.getByTestId('split-action-bar-items-overflow');
    fireEvent.pointerDown(more);
    fireEvent.mouseDown(more);
    fireEvent.click(more);
    expect(screen.getByTestId('split-action-bar-items-panel')).toBeInTheDocument();
    expect(screen.getByTestId('activity-pane-slot')).toBeInTheDocument();
    expect(activePane()).toBe('verification');
  });

  it('still closes on a press in the terminal composer (negative control)', async () => {
    const chip = await renderScreen();
    fireEvent.click(chip);
    await screen.findByTestId('activity-pane-slot');
    fireEvent.pointerDown(screen.getByTestId('composer'));
    await waitFor(() => expect(screen.queryByTestId('activity-pane-slot')).toBeNull());
  });
});

describe('[#3591] the Verification chip toggles like the header tools', () => {
  it('closes the Verification pane when pressed again', async () => {
    const chip = await renderScreen();
    fireEvent.click(chip);
    await screen.findByTestId('activity-pane-slot');
    expect(activePane()).toBe('verification');

    fireEvent.pointerDown(screen.getByTestId('verification-status-chip'));
    fireEvent.click(screen.getByTestId('verification-status-chip'));
    await waitFor(() => expect(screen.queryByTestId('activity-pane-slot')).toBeNull());
  });

  it('switches to Verification when another pane is open (negative control)', async () => {
    await renderScreen();
    fireEvent.click(screen.getByTestId('header-tool-git'));
    await screen.findByTestId('activity-pane-slot');
    expect(activePane()).toBe('git');

    fireEvent.pointerDown(screen.getByTestId('verification-status-chip'));
    fireEvent.click(screen.getByTestId('verification-status-chip'));
    await waitFor(() => expect(activePane()).toBe('verification'));
    expect(screen.getByTestId('activity-pane-slot')).toBeInTheDocument();
  });
});
