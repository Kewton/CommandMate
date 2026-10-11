/**
 * @vitest-environment jsdom
 */

/**
 * When the repository strip is on screen, and who decides (Issue #2374).
 *
 * Two things are pinned here that `shouldShowRepositoryTabBar`'s own unit test
 * cannot pin, because they are about the shell rather than the rule:
 *
 *   1. The strip is a DESKTOP surface. The phone keeps its bottom tab bar and
 *      drawer, so the mobile branch of `AppShell` must not render it at all —
 *      a `hidden md:flex` class would still mount the component and start its
 *      polling-adjacent work on a device that can never show it.
 *   2. The fixed sidebar has to move down when the band appears. `AppShell`
 *      positions it with `top-16` / `top-0` classes, which know nothing about a
 *      32px band above the header, so the band's height has to reach the
 *      `<aside>` — and must NOT be written when the band is down (Issue #1070's
 *      class assertions still stand).
 *
 *      Issue #3579: the band (and the header row) moved into <main>, so the
 *      sidebar no longer moves at all: `top-0 h-full`, no inline offset, with
 *      or without the band, on every route. Point 2 is now that it stays put.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';

const mockPathname = vi.fn(() => '/');
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => mockPathname(),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
  MOBILE_BREAKPOINT: 768,
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: {
      getAll: vi.fn(),
      getById: vi.fn(),
    },
    repositoryApi: { sync: vi.fn() },
  };
});

import { useIsMobile } from '@/hooks/useIsMobile';
import { worktreeApi } from '@/lib/api-client';
import { AppShell } from '@/components/layout/AppShell';
import { ToastProvider } from '@/components/common/Toast';
import { CommandPaletteProvider } from '@/contexts/CommandPaletteContext';
import { KeyboardShortcutsProvider } from '@/contexts/KeyboardShortcutsContext';
import { SidebarProvider, useSidebarContext } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';
import type { RepoTabBarMode } from '@/lib/sidebar-utils';

const WORKTREES: Worktree[] = [
  {
    id: 'alpha-main',
    name: 'main',
    path: '/repos/alpha/main',
    repositoryPath: '/repos/alpha',
    repositoryName: 'alpha-app',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as Worktree,
];

/** Drives the two preferences the shell reads, from inside the provider. */
function ShellControls() {
  const { toggle, setRepoTabBarMode } = useSidebarContext();
  return (
    <>
      <button data-testid="toggle-sidebar" onClick={toggle}>
        toggle
      </button>
      {(['always', 'collapsed', 'hidden'] as RepoTabBarMode[]).map((mode) => (
        <button
          key={mode}
          data-testid={`mode-${mode}`}
          onClick={() => setRepoTabBarMode(mode)}
        >
          {mode}
        </button>
      ))}
    </>
  );
}

function renderShell() {
  return render(
    <ToastProvider>
      <SidebarProvider>
        <WorktreeSelectionProvider>
          <CommandPaletteProvider>
            <KeyboardShortcutsProvider>
              <AppShell>
                <ShellControls />
              </AppShell>
            </KeyboardShortcutsProvider>
          </CommandPaletteProvider>
        </WorktreeSelectionProvider>
      </SidebarProvider>
    </ToastProvider>
  );
}

const originalFetch = global.fetch;

describe('repository tab bar visibility in AppShell (Issue #2374)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockPathname.mockReturnValue('/');
    (useIsMobile as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      worktrees: WORKTREES,
      repositories: [],
    });
    (worktreeApi.getById as ReturnType<typeof vi.fn>).mockResolvedValue(WORKTREES[0]);
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, order: null }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('is absent while the sidebar is open, and appears when it is collapsed', async () => {
    renderShell();
    await waitFor(() => expect(worktreeApi.getAll).toHaveBeenCalled());

    expect(screen.queryByTestId('repository-tab-bar')).toBeNull();

    act(() => {
      screen.getByTestId('toggle-sidebar').click();
    });
    expect(screen.getByTestId('repository-tab-bar')).toBeInTheDocument();

    act(() => {
      screen.getByTestId('toggle-sidebar').click();
    });
    expect(screen.queryByTestId('repository-tab-bar')).toBeNull();
  });

  it('stays up with the sidebar open when the mode is "always"', async () => {
    renderShell();
    await waitFor(() => expect(worktreeApi.getAll).toHaveBeenCalled());

    act(() => {
      screen.getByTestId('mode-always').click();
    });
    expect(screen.getByTestId('repository-tab-bar')).toBeInTheDocument();
  });

  it('never appears when the mode is "hidden", collapsed or not', async () => {
    renderShell();
    await waitFor(() => expect(worktreeApi.getAll).toHaveBeenCalled());

    act(() => {
      screen.getByTestId('mode-hidden').click();
    });
    expect(screen.queryByTestId('repository-tab-bar')).toBeNull();

    act(() => {
      screen.getByTestId('toggle-sidebar').click();
    });
    expect(screen.queryByTestId('repository-tab-bar')).toBeNull();
  });

  it('is not rendered on a phone, even with the sidebar collapsed', async () => {
    (useIsMobile as ReturnType<typeof vi.fn>).mockReturnValue(true);
    renderShell();
    await waitFor(() => expect(worktreeApi.getAll).toHaveBeenCalled());

    act(() => {
      screen.getByTestId('toggle-sidebar').click();
    });
    expect(screen.queryByTestId('repository-tab-bar')).toBeNull();
  });

  it('appears on a worktree route, where the global header is hidden', async () => {
    mockPathname.mockReturnValue('/worktrees/alpha-main');
    renderShell();
    await waitFor(() => expect(worktreeApi.getAll).toHaveBeenCalled());

    act(() => {
      screen.getByTestId('toggle-sidebar').click();
    });
    expect(screen.getByTestId('repository-tab-bar')).toBeInTheDocument();
  });

  describe('fixed sidebar offset', () => {
    it('leaves the sidebar exactly where it was while the band is down', async () => {
      renderShell();
      await waitFor(() => expect(worktreeApi.getAll).toHaveBeenCalled());

      const aside = screen.getByTestId('sidebar-container');
      expect(aside).toHaveClass('top-0', 'h-full');
      expect(aside.style.top).toBe('');
      expect(aside.style.height).toBe('');
    });

    it('pushes the sidebar below the band once it is up', async () => {
      renderShell();
      await waitFor(() => expect(worktreeApi.getAll).toHaveBeenCalled());

      act(() => {
        screen.getByTestId('mode-always').click();
      });

      // Issue #3579: the band is the first row of <main>, beside the sidebar,
      // which therefore stays at the top of the screen.
      const aside = screen.getByTestId('sidebar-container');
      expect(screen.getByRole('main').contains(screen.getByTestId('repository-tab-bar'))).toBe(true);
      expect(aside).toHaveClass('top-0', 'h-full');
      expect(aside.style.top).toBe('');
      expect(aside.style.height).toBe('');
    });

    it('offsets by the band alone on a route with no header', async () => {
      mockPathname.mockReturnValue('/worktrees/alpha-main');
      renderShell();
      await waitFor(() => expect(worktreeApi.getAll).toHaveBeenCalled());

      act(() => {
        screen.getByTestId('mode-always').click();
      });

      // Issue #3579: no offset here either — same placement as the list screens.
      const aside = screen.getByTestId('sidebar-container');
      expect(screen.getByRole('main').contains(screen.getByTestId('repository-tab-bar'))).toBe(true);
      expect(aside).toHaveClass('top-0', 'h-full');
      expect(aside.style.top).toBe('');
      expect(aside.style.height).toBe('');
    });
  });
});
