/**
 * Escape on the second row's floating layers over the overlaid activity pane
 * (Issue #3660, follow-up to #3650)
 *
 * #3650 made the file tree's display-settings menu keep its own Escape from
 * also closing the pane underneath. Two more layers close on a document
 * Escape: the Verification chip's reason popover (`VerificationStatusChip`)
 * and the second row's "…" panel (`ActionBarItemsOverflow`). Both sit in the
 * pane's Esc regions (`[data-activity-entry]` / the "…" button), and the
 * pane's document listener is registered when the pane opens — before theirs
 * — so without a claim one Escape closed the layer AND the pane.
 *
 * Wired through the whole PC screen like the #3591 entry-point test:
 * `WorktreeDetailRefactored` → `WorktreeDetailDesktop` (the real ignore list)
 * → `PaneOverlayFrame` / `usePaneOverlayDismiss`, the real chip and the real
 * "…". The stubbed `TerminalSplitContainer` draws `actionBarItems` inline, or
 * folded into the "…" panel when `foldChip` is set.
 *
 * The phone path (inline reason popover, no overlaid pane) is pinned on the
 * chip alone at the end.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-3660',
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

/** Draw the chip inside the "…" panel (a bar too narrow for it). */
let foldChip = false;

vi.mock('@/components/worktree/TerminalSplitContainer', async () => {
  const actual = await vi.importActual<typeof import('@/components/worktree/TerminalSplitContainer')>(
    '@/components/worktree/TerminalSplitContainer',
  );
  return {
    ...actual,
    TerminalSplitContainer: ({ actionBarItems }: { actionBarItems?: React.ReactNode }) => (
      <div data-testid="split-action-bar">
        {!foldChip && <span data-testid="split-action-bar-items">{actionBarItems}</span>}
        <actual.ActionBarItemsOverflow label="More">
          {foldChip ? (
            actionBarItems
          ) : (
            <button type="button" data-testid="folded-item">
              folded
            </button>
          )}
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
import { VerificationStatusChip } from '@/components/worktree/VerificationStatusChip';

const WORKTREE_ID = 'wt-3660';

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
  foldChip = false;
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
          name: 'feature/3660',
          path: '/tmp/wt-3660',
          repositoryPath: '/tmp/repo',
          repositoryName: 'Repo',
        }),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
});

/** The PC screen with the Files pane open over the body (unpinned). */
async function renderWithFilesPane(): Promise<void> {
  render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
  await screen.findByTestId('terminal-column');
  fireEvent.click(screen.getByTestId('header-tool-files'));
  await screen.findByTestId('activity-pane-slot');
}

function paneOpen(): boolean {
  return screen.queryByTestId('activity-pane-slot') !== null;
}

/** Escape on `target`; returns whether some layer claimed it. */
function pressEscape(target: Element | Document): boolean {
  let claimed = false;
  const seen = (event: KeyboardEvent): void => {
    claimed = event.defaultPrevented;
  };
  window.addEventListener('keydown', seen);
  try {
    act(() => {
      fireEvent.keyDown(target, { key: 'Escape' });
    });
  } finally {
    window.removeEventListener('keydown', seen);
  }
  return claimed;
}

function openReason(): HTMLElement {
  const toggle = screen.getByTestId('verification-chip-reason-toggle');
  fireEvent.mouseDown(toggle);
  fireEvent.click(toggle);
  expect(screen.getByTestId('verification-chip-reason-popover')).toBeInTheDocument();
  return toggle;
}

function openOverflow(): HTMLElement {
  const more = screen.getByTestId('split-action-bar-items-overflow');
  fireEvent.pointerDown(more);
  fireEvent.mouseDown(more);
  fireEvent.click(more);
  expect(screen.getByTestId('split-action-bar-items-panel')).toBeInTheDocument();
  return more;
}

describe('[#3660] Verification chip reason over the overlaid Files pane (PC)', () => {
  it('closes only the reason on the first Escape, then the pane on the second', async () => {
    await renderWithFilesPane();
    const toggle = openReason();
    expect(paneOpen()).toBe(true);

    expect(pressEscape(toggle)).toBe(true);
    expect(screen.queryByTestId('verification-chip-reason-popover')).toBeNull();
    expect(paneOpen()).toBe(true);

    expect(pressEscape(toggle)).toBe(false);
    await waitFor(() => expect(paneOpen()).toBe(false));
  });

  it('moves focus to the toggle when the reason opens, so Escape reaches the chip', async () => {
    await renderWithFilesPane();
    const toggle = openReason();
    expect(document.activeElement).toBe(toggle);
  });

  it('closes the pane on the first Escape with the reason closed (negative control)', async () => {
    await renderWithFilesPane();
    expect(pressEscape(screen.getByTestId('verification-chip-reason-toggle'))).toBe(false);
    await waitFor(() => expect(paneOpen()).toBe(false));
  });

  it('still closes the reason on an Escape pressed elsewhere (negative control)', async () => {
    await renderWithFilesPane();
    openReason();
    pressEscape(document);
    expect(screen.queryByTestId('verification-chip-reason-popover')).toBeNull();
  });
});

describe('[#3660] the second row "…" panel over the overlaid Files pane (PC)', () => {
  it('closes only the panel on the first Escape, then the pane on the second', async () => {
    // The chip folded in is the panel's first control, so opening puts focus
    // on an `[data-activity-entry]` — one of the pane's Esc regions.
    foldChip = true;
    await renderWithFilesPane();
    const more = openOverflow();
    const chip = await screen.findByTestId('verification-status-chip');
    await waitFor(() => expect(document.activeElement).toBe(chip));

    pressEscape(chip);
    expect(screen.queryByTestId('split-action-bar-items-panel')).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(paneOpen()).toBe(true);

    expect(pressEscape(more)).toBe(false);
    await waitFor(() => expect(paneOpen()).toBe(false));
  });

  it('marks the open panel as a floating layer the pane stands down for', async () => {
    await renderWithFilesPane();
    openOverflow();
    expect(screen.getByTestId('split-action-bar-items-panel')).toHaveAttribute(
      'data-floating-layer',
      'open',
    );
  });

  it('closes only the panel on a press outside, keeping the pane', async () => {
    await renderWithFilesPane();
    openOverflow();
    const composer = screen.getByTestId('composer');
    fireEvent.pointerDown(composer);
    fireEvent.mouseDown(composer);
    expect(screen.queryByTestId('split-action-bar-items-panel')).toBeNull();
    expect(paneOpen()).toBe(true);
  });

  it('closes only the panel from a control outside the pane regions (negative control)', async () => {
    await renderWithFilesPane();
    openOverflow();
    const item = screen.getByTestId('folded-item');
    await waitFor(() => expect(document.activeElement).toBe(item));
    pressEscape(item);
    expect(screen.queryByTestId('split-action-bar-items-panel')).toBeNull();
    expect(paneOpen()).toBe(true);
  });

  it('closes the pane on the first Escape with the panel closed (negative control)', async () => {
    await renderWithFilesPane();
    expect(pressEscape(screen.getByTestId('split-action-bar-items-overflow'))).toBe(false);
    await waitFor(() => expect(paneOpen()).toBe(false));
  });
});

describe('[#3660] the chip folded into the "…" panel (PC, three layers)', () => {
  it('peels one layer per Escape: reason, then panel, then pane', async () => {
    foldChip = true;
    await renderWithFilesPane();
    openOverflow();
    await screen.findByTestId('verification-status-chip');
    const toggle = openReason();
    expect(screen.getByTestId('verification-chip-reason-popover').parentElement).toBe(
      document.body,
    );

    pressEscape(toggle);
    expect(screen.queryByTestId('verification-chip-reason-popover')).toBeNull();
    expect(screen.getByTestId('split-action-bar-items-panel')).toBeInTheDocument();
    expect(paneOpen()).toBe(true);

    pressEscape(document.activeElement ?? document.body);
    expect(screen.queryByTestId('split-action-bar-items-panel')).toBeNull();
    expect(paneOpen()).toBe(true);

    pressEscape(document.activeElement ?? document.body);
    await waitFor(() => expect(paneOpen()).toBe(false));
  });
});

describe('[#3660] the chip reason on the phone (inline popover)', () => {
  it('claims the Escape it closes on, so window-level layers below leave it alone', () => {
    render(<VerificationStatusChip task={null} latestRun={null} onOpen={vi.fn()} />);
    const toggle = openReason();
    expect(screen.getByTestId('verification-chip-reason-popover').parentElement).not.toBe(
      document.body,
    );
    expect(pressEscape(toggle)).toBe(true);
    expect(screen.queryByTestId('verification-chip-reason-popover')).toBeNull();
    // Negative control: with the reason closed the press is left unclaimed.
    expect(pressEscape(toggle)).toBe(false);
  });

  it('leaves an Escape a layer above already handled alone', () => {
    render(<VerificationStatusChip task={null} latestRun={null} onOpen={vi.fn()} />);
    const toggle = openReason();
    const claim = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') event.preventDefault();
    };
    document.addEventListener('keydown', claim, true);
    try {
      pressEscape(toggle);
    } finally {
      document.removeEventListener('keydown', claim, true);
    }
    expect(screen.getByTestId('verification-chip-reason-popover')).toBeInTheDocument();
  });
});
