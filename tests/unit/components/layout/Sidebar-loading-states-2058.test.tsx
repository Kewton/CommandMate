/**
 * Sidebar hover-freeze and list loading states (Issue #2058, Issue #2059).
 *
 * Issue #2058 — the hover-freeze snapshots the branch ORDER while the cursor is
 * inside the list. Three defects are pinned here:
 *   1. it also froze an EMPTY list, so a cursor resting over the sidebar during
 *      the first fetch hid the arriving branches behind `[]`;
 *   2. the first arrival of data was treated as a reorder rather than as the
 *      initial load;
 *   3. releasing the freeze (1s after mouseleave) forced no re-render, so the
 *      frozen order stayed on screen until the next poll — up to 60s.
 *
 * Issue #2059 — "No branches available" was the only thing the list could say,
 * whether it was still loading, had failed to load, or was genuinely empty.
 *
 * The freeze itself is load-bearing (it stops rows jumping under the pointer),
 * so a test that proves it still suppresses a poll reorder sits alongside the
 * fixes. Without it, any of the three fixes could "pass" by disabling freezing.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { ToastProvider } from '@/components/common/Toast';
import { SidebarProvider, SIDEBAR_VIEW_MODE_STORAGE_KEY } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';
import { WorktreesCacheProvider } from '@/components/providers/WorktreesCacheProvider';
import type { Worktree } from '@/types/models';

// Wording is part of what these tests assert ("No branches available" must
// narrow to a genuinely empty list), so resolve through the real dictionary.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** `toBranchItem` maps `updatedAt` to `lastActivity`, the default sort key. */
function worktree(id: string, updatedAt: string): Worktree {
  return {
    id,
    name: id,
    path: `/path/to/${id}`,
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    isSessionRunning: false,
    isWaitingForResponse: false,
    updatedAt: new Date(updatedAt),
  } as Worktree;
}

/** Default sort is `updatedAt` desc, so this list renders alpha → beta → gamma. */
const ALPHA_FIRST: Worktree[] = [
  worktree('alpha', '2026-08-29T03:00:00.000Z'),
  worktree('beta', '2026-08-29T02:00:00.000Z'),
  worktree('gamma', '2026-08-29T01:00:00.000Z'),
];

/** Same three worktrees after a poll moved gamma to the top. */
const GAMMA_FIRST: Worktree[] = [
  worktree('alpha', '2026-08-29T03:00:00.000Z'),
  worktree('beta', '2026-08-29T02:00:00.000Z'),
  worktree('gamma', '2026-08-29T04:00:00.000Z'),
];

/** Branch names in rendered DOM order. */
function renderedOrder(): string[] {
  return screen
    .queryAllByTestId('branch-list-item')
    .map((item) => item.querySelector('p')?.textContent ?? '');
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: 'http://localhost/api/worktrees',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as Response;
}

/**
 * Sidebar under a caller-controlled selection context — the same props
 * WorktreesCacheProvider passes in production, so a `rerender` reproduces
 * exactly what a poll or a first payload does to the component.
 */
function Harness({
  worktrees,
  isLoading = false,
  error = null,
  refresh,
}: {
  worktrees: Worktree[];
  isLoading?: boolean;
  error?: Error | null;
  refresh?: () => Promise<void>;
}) {
  return (
    <ToastProvider>
      <SidebarProvider>
        <WorktreeSelectionProvider
          externalWorktrees={worktrees}
          externalRepositories={[]}
          externalIsLoading={isLoading}
          externalError={error}
          externalRefresh={refresh}
        >
          <Sidebar />
        </WorktreeSelectionProvider>
      </SidebarProvider>
    </ToastProvider>
  );
}

const originalFetch = global.fetch;

describe('Sidebar list states (Issue #2058, #2059)', () => {
  beforeEach(() => {
    localStorage.clear();
    // Flat view keeps the assertions about ORDER about order, with no group
    // headers or DnD wrappers in between.
    localStorage.setItem(SIDEBAR_VIEW_MODE_STORAGE_KEY, 'flat');
    // Sidebar fetches its saved group order on mount; unrelated to these tests.
    global.fetch = vi.fn(async () => jsonResponse({ success: false, order: null })) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Issue #2058
  // -------------------------------------------------------------------------

  describe('hover-freeze (Issue #2058)', () => {
    it('renders the first payload that arrives while the cursor is over an empty list', async () => {
      const { rerender } = render(<Harness worktrees={[]} />);

      await waitFor(() => {
        expect(screen.getByText(/No branches available/i)).toBeInTheDocument();
      });

      // The cursor comes to rest over the (still empty) branch list.
      fireEvent.mouseEnter(screen.getByTestId('branch-list'));

      // The first fetch lands. Before the fix, mouseEnter had frozen `[]` with
      // `expiresAt: Infinity`, so these rows stayed invisible until a poll
      // happened to re-run the memo — often the full 30s/60s away.
      rerender(<Harness worktrees={ALPHA_FIRST} />);

      await waitFor(() => {
        expect(renderedOrder()).toEqual(['alpha', 'beta', 'gamma']);
      });
      expect(screen.queryByText(/No branches available/i)).not.toBeInTheDocument();
    });

    it('re-freezes normally once real rows exist, so a later poll cannot reorder under the cursor', async () => {
      const { rerender } = render(<Harness worktrees={[]} />);

      fireEvent.mouseEnter(screen.getByTestId('branch-list'));
      rerender(<Harness worktrees={ALPHA_FIRST} />);
      await waitFor(() => {
        expect(renderedOrder()).toEqual(['alpha', 'beta', 'gamma']);
      });

      // Cursor is still inside the list. Discarding the empty snapshot must not
      // leave the list permanently unfrozen: this poll must not reorder.
      fireEvent.mouseEnter(screen.getByTestId('branch-list'));
      rerender(<Harness worktrees={GAMMA_FIRST} />);

      await waitFor(() => {
        expect(screen.queryAllByTestId('branch-list-item')).toHaveLength(3);
      });
      expect(renderedOrder()).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('holds the display order while the cursor is inside the list and a poll reorders it', async () => {
      const { rerender } = render(<Harness worktrees={ALPHA_FIRST} />);

      await waitFor(() => {
        expect(renderedOrder()).toEqual(['alpha', 'beta', 'gamma']);
      });

      fireEvent.mouseEnter(screen.getByTestId('branch-list'));

      // A poll promotes gamma to the top. The row under the pointer must not
      // move: this is the behaviour the freeze exists for.
      rerender(<Harness worktrees={GAMMA_FIRST} />);

      await waitFor(() => {
        expect(screen.queryAllByTestId('branch-list-item')).toHaveLength(3);
      });
      expect(renderedOrder()).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('shows the live order 1s after the cursor leaves, with no further data update', async () => {
      const { rerender } = render(<Harness worktrees={ALPHA_FIRST} />);

      await waitFor(() => {
        expect(renderedOrder()).toEqual(['alpha', 'beta', 'gamma']);
      });

      fireEvent.mouseEnter(screen.getByTestId('branch-list'));
      rerender(<Harness worktrees={GAMMA_FIRST} />);
      await waitFor(() => {
        expect(screen.queryAllByTestId('branch-list-item')).toHaveLength(3);
      });
      expect(renderedOrder()).toEqual(['alpha', 'beta', 'gamma']);

      fireEvent.mouseLeave(screen.getByTestId('branch-list'));

      // Nothing else re-renders the sidebar from here — no rerender(), no poll.
      // Before the fix the release nulled a ref silently and the stale order
      // stayed on screen until the next poll (30s, or 60s over a live socket).
      await waitFor(
        () => {
          expect(renderedOrder()).toEqual(['gamma', 'alpha', 'beta']);
        },
        { timeout: 4000 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Issue #2059
  // -------------------------------------------------------------------------

  describe('loading / error / empty states (Issue #2059)', () => {
    it('shows skeletons — not "No branches available" — during the first load', async () => {
      render(<Harness worktrees={[]} isLoading />);

      expect(screen.getByTestId('branch-list-skeleton')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.queryByText(/No branches available/i)).not.toBeInTheDocument();
      });
    });

    it('shows "No branches available" only when the load finished with genuinely zero branches', async () => {
      render(<Harness worktrees={[]} isLoading={false} error={null} />);

      await waitFor(() => {
        expect(screen.getByText(/No branches available/i)).toBeInTheDocument();
      });
      expect(screen.queryByTestId('branch-list-skeleton')).not.toBeInTheDocument();
      expect(screen.queryByTestId('branch-list-error')).not.toBeInTheDocument();
    });

    it('shows a retry action instead of the empty message when the load failed', async () => {
      const refresh = vi.fn(async () => {});
      render(<Harness worktrees={[]} error={new Error('boom')} refresh={refresh} />);

      await waitFor(() => {
        expect(screen.getByTestId('branch-list-error')).toBeInTheDocument();
      });
      expect(screen.getByText(/Failed to load branches/i)).toBeInTheDocument();
      expect(screen.queryByText(/No branches available/i)).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('branch-list-retry'));
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('keeps a rendered list up when a later fetch fails, instead of swapping in the error panel', async () => {
      render(<Harness worktrees={ALPHA_FIRST} error={new Error('boom')} />);

      await waitFor(() => {
        expect(renderedOrder()).toEqual(['alpha', 'beta', 'gamma']);
      });
      expect(screen.queryByTestId('branch-list-error')).not.toBeInTheDocument();
      expect(screen.queryByTestId('branch-list-skeleton')).not.toBeInTheDocument();
    });

    it('leaves the happy-path list untouched: rows only, no skeleton, no error panel', async () => {
      render(<Harness worktrees={ALPHA_FIRST} isLoading={false} error={null} />);

      await waitFor(() => {
        expect(renderedOrder()).toEqual(['alpha', 'beta', 'gamma']);
      });
      const branchList = screen.getByTestId('branch-list');
      expect(branchList.querySelectorAll('[data-testid="branch-list-item"]')).toHaveLength(3);
      expect(screen.queryByTestId('branch-list-skeleton')).not.toBeInTheDocument();
      expect(screen.queryByTestId('branch-list-error')).not.toBeInTheDocument();
      expect(screen.queryByText(/No branches available/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end through the real cache provider (Issue #2059)
  // -------------------------------------------------------------------------

  describe('skeleton → error → retry, through WorktreesCacheProvider', () => {
    it('walks the full transition against a 500 from /api/worktrees', async () => {
      let worktreesShouldFail = true;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : String(input);
        if (url.startsWith('/api/worktrees')) {
          return worktreesShouldFail
            ? jsonResponse({ error: 'boom' }, 500)
            : jsonResponse({ worktrees: ALPHA_FIRST, repositories: [] });
        }
        return jsonResponse({ success: false, order: null });
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      // The failed fetch is reported on the console by design (Issue #2059) —
      // silence it so the expected path does not look like a test failure.
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(
        <ToastProvider>
          <SidebarProvider>
            <WorktreesCacheProvider>
              <Sidebar />
            </WorktreesCacheProvider>
          </SidebarProvider>
        </ToastProvider>,
      );

      // 1. Skeletons while the very first request is still in flight.
      expect(screen.getByTestId('branch-list-skeleton')).toBeInTheDocument();
      expect(screen.queryByText(/No branches available/i)).not.toBeInTheDocument();

      // 2. The 500 lands: an error with a retry, never "No branches available".
      await waitFor(() => {
        expect(screen.getByTestId('branch-list-error')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('branch-list-skeleton')).not.toBeInTheDocument();
      expect(screen.queryByText(/No branches available/i)).not.toBeInTheDocument();
      expect(consoleError).toHaveBeenCalled();

      // 3. Retry succeeds and the list appears.
      worktreesShouldFail = false;
      await act(async () => {
        fireEvent.click(screen.getByTestId('branch-list-retry'));
      });

      await waitFor(() => {
        expect(renderedOrder()).toEqual(['alpha', 'beta', 'gamma']);
      });
      expect(screen.queryByTestId('branch-list-error')).not.toBeInTheDocument();
    });
  });
});
