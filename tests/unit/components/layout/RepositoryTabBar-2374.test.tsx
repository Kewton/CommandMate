/**
 * @vitest-environment jsdom
 */

/**
 * The header's repository tab strip (Issue #2374).
 *
 * The acceptance criteria this Issue is judged on are all statements about
 * AGREEMENT with the sidebar — same tab order as the sidebar's groups, same
 * rows in the popover as in the sidebar's group, same status vocabulary. So the
 * tests that matter render the strip and the `Sidebar` **in one tree, under one
 * `SidebarProvider`**, and compare what the two actually paint. Asserting the
 * strip against a hand-written expected order would prove only that the test
 * author and the implementation agree.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';

const mockPush = vi.fn();
const mockPathname = vi.fn(() => '/');
/** Subscribers of the mocked `usePathname`; see `navigateTo`. */
const pathnameListeners = new Set<() => void>();
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useRouter: () => ({
      push: mockPush,
      replace: vi.fn(),
      prefetch: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
    }),
    // A store rather than a bare call, so that `navigateTo` re-renders the
    // strip the way the router's own pathname context does — the strip is a
    // prop-less `memo`, which a `rerender` would never reach.
    usePathname: () =>
      useSyncExternalStore(
        (listener) => {
          pathnameListeners.add(listener);
          return () => {
            pathnameListeners.delete(listener);
          };
        },
        () => mockPathname()
      ),
    useSearchParams: () => new URLSearchParams(),
  };
});

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

import { worktreeApi } from '@/lib/api-client';
import {
  RepositoryTabBar,
  resolveWheelScrollLeftDelta,
} from '@/components/layout/RepositoryTabBar';
import { Sidebar } from '@/components/layout/Sidebar';
import { ToastProvider } from '@/components/common/Toast';
import { SidebarProvider, useSidebarContext } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';
import { SIDEBAR_GROUP_ORDER_CACHE_STORAGE_KEY } from '@/lib/sidebar-utils';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Two repositories whose ALPHABETICAL order (`alpha-app`, `zebra-tools`) is the
 * reverse of the saved group order used below, so an assertion on the saved
 * order cannot pass by accident.
 */
function worktree(overrides: Partial<Worktree> & Pick<Worktree, 'id'>): Worktree {
  return {
    name: `branch-${overrides.id}`,
    path: `/repos/${overrides.id}`,
    repositoryPath: '/repos/alpha',
    repositoryName: 'alpha-app',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as Worktree;
}

const WORKTREES: Worktree[] = [
  worktree({
    id: 'alpha-main',
    name: 'main',
    repositoryPath: '/repos/alpha',
    repositoryName: 'alpha-app',
  }),
  worktree({
    id: 'alpha-feature',
    name: 'feature/tabs',
    repositoryPath: '/repos/alpha',
    repositoryName: 'alpha-app',
  }),
  worktree({
    id: 'zebra-main',
    name: 'main',
    repositoryPath: '/repos/zebra',
    repositoryName: 'zebra-tools',
    isSessionRunning: true,
    isWaitingForResponse: true,
    // The per-instance map is what the sidebar row's dot reads (Issue #878), so
    // it is what the tab's roll-up must read too. A fixture that set only the
    // worktree-level flags would render an idle dot in BOTH surfaces and prove
    // nothing about the roll-up.
    sessionStatusByInstance: {
      claude: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
    },
  }),
];

/** The order a user would have produced by dragging zebra above alpha. */
const SAVED_ORDER = ['zebra-tools', 'alpha-app'];

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as unknown as Response;
}

const originalFetch = global.fetch;

/** Lets a test drive the shared order the way the sidebar's DnD handler does. */
function OrderDriver() {
  const { setRepositoryOrder } = useSidebarContext();
  return (
    <button
      data-testid="drive-order"
      onClick={() => setRepositoryOrder(['alpha-app', 'zebra-tools'])}
    >
      reorder
    </button>
  );
}

function renderStrip(children?: React.ReactNode) {
  return render(
    <ToastProvider>
      <SidebarProvider>
        <WorktreeSelectionProvider>
          <RepositoryTabBar />
          {children}
        </WorktreeSelectionProvider>
      </SidebarProvider>
    </ToastProvider>
  );
}

/**
 * Prime the localStorage order cache.
 *
 * The `/api/sidebar/group-order` fetch belongs to `Sidebar` (which AppShell
 * mounts on every route); the strip reads the order through `SidebarContext`
 * and, on the very first frame, through this cache. Seeding it is how a test
 * gives the strip an order without also mounting the sidebar.
 */
function seedOrderCache(order: string[] = SAVED_ORDER): void {
  localStorage.setItem(
    SIDEBAR_GROUP_ORDER_CACHE_STORAGE_KEY,
    JSON.stringify(order)
  );
}

function tabNames(): string[] {
  return screen
    .queryAllByTestId('repository-tab')
    .map((tab) => tab.getAttribute('data-repository') ?? '');
}

describe('RepositoryTabBar (Issue #2374)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockPathname.mockReturnValue('/');
    (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      worktrees: WORKTREES,
      repositories: [],
    });
    (worktreeApi.getById as ReturnType<typeof vi.fn>).mockResolvedValue(WORKTREES[0]);
    global.fetch = vi.fn(async () =>
      jsonResponse({ success: true, order: SAVED_ORDER })
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('tabs', () => {
    it('renders one tab per repository', async () => {
      renderStrip();
      await waitFor(() => expect(tabNames()).toHaveLength(2));
      expect(tabNames().sort()).toEqual(['alpha-app', 'zebra-tools']);
    });

    it('renders nothing at all when no repository is visible', async () => {
      (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        worktrees: [],
        repositories: [],
      });
      renderStrip();
      await waitFor(() => {
        expect(worktreeApi.getAll).toHaveBeenCalled();
      });
      expect(screen.queryByTestId('repository-tab-bar')).toBeNull();
    });

    it('leaves out a repository the user has hidden (Issue #690 visibility)', async () => {
      (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        worktrees: WORKTREES,
        repositories: [
          { id: 'r1', name: 'alpha-app', path: '/repos/alpha', visible: true },
          { id: 'r2', name: 'zebra-tools', path: '/repos/zebra', visible: false },
        ],
      });
      renderStrip();
      await waitFor(() => expect(tabNames()).toEqual(['alpha-app']));
    });

    it('paints the saved order on the first frame, from the cache', async () => {
      seedOrderCache();
      renderStrip();
      await waitFor(() => expect(tabNames()).toEqual(SAVED_ORDER));
    });

    it('never wraps, so the band stays one row however many repositories exist', async () => {
      renderStrip();
      await waitFor(() => expect(tabNames()).toHaveLength(2));
      const strip = screen.getByTestId('repository-tab-strip');
      expect(strip.className).toContain('flex-nowrap');
      expect(strip.className).toContain('overflow-x-auto');
    });

    it('marks the repository of the worktree in the URL as current', async () => {
      mockPathname.mockReturnValue('/worktrees/zebra-main');
      renderStrip();
      await waitFor(() => expect(tabNames()).toHaveLength(2));

      const [zebra] = screen
        .getAllByTestId('repository-tab')
        .filter((tab) => tab.getAttribute('data-repository') === 'zebra-tools');
      expect(zebra).toHaveAttribute('aria-current', 'true');
      const [alpha] = screen
        .getAllByTestId('repository-tab')
        .filter((tab) => tab.getAttribute('data-repository') === 'alpha-app');
      expect(alpha).not.toHaveAttribute('aria-current');
    });
  });

  describe('agreement with the sidebar', () => {
    it('orders the tabs exactly like the sidebar orders its groups', async () => {
      renderStrip(<Sidebar />);

      await waitFor(() => {
        expect(screen.getAllByTestId('group-header')).toHaveLength(2);
      });

      const sidebarOrder = screen
        .getAllByTestId('group-header')
        .map((header) => header.textContent ?? '');

      // Saved order first — proving the tabs read it rather than falling back to
      // the alphabetical order `groupBranches` produces.
      expect(tabNames()).toEqual(SAVED_ORDER);
      expect(sidebarOrder[0]).toContain(SAVED_ORDER[0]);
      expect(sidebarOrder[1]).toContain(SAVED_ORDER[1]);
    });

    it('follows a sidebar reorder without a reload', async () => {
      renderStrip(
        <>
          <Sidebar />
          <OrderDriver />
        </>
      );
      await waitFor(() => expect(tabNames()).toEqual(SAVED_ORDER));
      await waitFor(() => expect(screen.getAllByTestId('group-header')).toHaveLength(2));

      act(() => {
        screen.getByTestId('drive-order').click();
      });

      const reordered = ['alpha-app', 'zebra-tools'];
      expect(tabNames()).toEqual(reordered);
      const sidebarOrder = screen
        .getAllByTestId('group-header')
        .map((header) => header.textContent ?? '');
      expect(sidebarOrder[0]).toContain(reordered[0]);
      expect(sidebarOrder[1]).toContain(reordered[1]);
    });

    it('lists the same branches, in the same order, as the sidebar group', async () => {
      renderStrip(<Sidebar />);
      await waitFor(() => expect(tabNames()).toEqual(SAVED_ORDER));
      // The sidebar's rows arrive on their own schedule; under a loaded suite
      // they can trail the tabs by a tick, and reading them early would fail
      // for a reason that has nothing to do with what this test asserts.
      await waitFor(() =>
        expect(screen.getAllByTestId('branch-list-item')).toHaveLength(WORKTREES.length)
      );

      // Rows are identified by their accessible name ("<branch> - <repository>")
      // rather than their visible text: both repositories have a `main`, and
      // matching on text alone would happily pair the wrong two rows.
      const sidebarRows = screen
        .getAllByTestId('branch-list-item')
        .map((row) => row.getAttribute('aria-label') ?? '');

      fireEvent.click(
        screen
          .getAllByTestId('repository-tab')
          .find((tab) => tab.getAttribute('data-repository') === 'alpha-app')!
      );

      const popover = screen.getByTestId('repository-tab-popover');
      const popoverRows = within(popover)
        .getAllByTestId('branch-list-item')
        .map((row) => row.getAttribute('aria-label') ?? '');

      expect(popoverRows).toEqual(['main - alpha-app', 'feature/tabs - alpha-app']);
      // The sidebar renders both repositories; the popover renders one. Compare
      // the popover against the sidebar's alpha-app slice, in order.
      expect(sidebarRows.filter((label) => label.endsWith(' - alpha-app'))).toEqual(
        popoverRows
      );
    });
  });

  describe('status roll-up', () => {
    it('shows the waiting colour on a tab whose repository has a waiting branch', async () => {
      renderStrip();
      await waitFor(() => expect(tabNames()).toHaveLength(2));

      const zebra = screen
        .getAllByTestId('repository-tab')
        .find((tab) => tab.getAttribute('data-repository') === 'zebra-tools')!;
      const dot = within(zebra).getByTestId('repository-tab-status');
      expect(dot.className).toContain('bg-warning');
      expect(dot).toHaveAttribute('aria-label', 'common.status.waiting');

      const alpha = screen
        .getAllByTestId('repository-tab')
        .find((tab) => tab.getAttribute('data-repository') === 'alpha-app')!;
      const idleDot = within(alpha).getByTestId('repository-tab-status');
      expect(idleDot.className).not.toContain('bg-warning');
      expect(idleDot).toHaveAttribute('aria-label', 'common.status.idle');
    });

    it('badges the tab with how many of its branches are waiting', async () => {
      renderStrip();
      await waitFor(() => expect(tabNames()).toHaveLength(2));

      const zebra = screen
        .getAllByTestId('repository-tab')
        .find((tab) => tab.getAttribute('data-repository') === 'zebra-tools')!;
      expect(within(zebra).getByTestId('repository-tab-attention-count')).toHaveTextContent(
        '1'
      );

      const alpha = screen
        .getAllByTestId('repository-tab')
        .find((tab) => tab.getAttribute('data-repository') === 'alpha-app')!;
      expect(within(alpha).queryByTestId('repository-tab-attention-count')).toBeNull();
    });
  });

  describe('popover', () => {
    async function openAlpha() {
      renderStrip();
      await waitFor(() => expect(tabNames()).toHaveLength(2));
      const alpha = screen
        .getAllByTestId('repository-tab')
        .find((tab) => tab.getAttribute('data-repository') === 'alpha-app')!;
      fireEvent.click(alpha);
      return alpha;
    }

    it('opens under the tab and reports itself expanded', async () => {
      const alpha = await openAlpha();
      expect(alpha).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('repository-tab-popover')).toHaveAttribute(
        'data-repository',
        'alpha-app'
      );
    });

    it('opens on ArrowDown as well as click, so it is reachable from the keyboard', async () => {
      renderStrip();
      await waitFor(() => expect(tabNames()).toHaveLength(2));
      const alpha = screen
        .getAllByTestId('repository-tab')
        .find((tab) => tab.getAttribute('data-repository') === 'alpha-app')!;
      fireEvent.keyDown(alpha, { key: 'ArrowDown' });
      expect(screen.getByTestId('repository-tab-popover')).toBeInTheDocument();
    });

    it('navigates to the branch and closes when a row is clicked', async () => {
      await openAlpha();
      const popover = screen.getByTestId('repository-tab-popover');
      fireEvent.click(within(popover).getAllByTestId('branch-list-item')[0]);

      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush.mock.calls[0][0]).toMatch(/^\/worktrees\/alpha-/);
      expect(screen.queryByTestId('repository-tab-popover')).toBeNull();
    });

    it('closes on Escape and hands focus back to the tab', async () => {
      const alpha = await openAlpha();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('repository-tab-popover')).toBeNull();
      expect(document.activeElement).toBe(alpha);
    });

    it('closes when the user clicks outside it', async () => {
      await openAlpha();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByTestId('repository-tab-popover')).toBeNull();
    });

    it('closes when the same tab is clicked again', async () => {
      const alpha = await openAlpha();
      fireEvent.click(alpha);
      expect(screen.queryByTestId('repository-tab-popover')).toBeNull();
    });

    it('scrolls internally rather than growing past the viewport', async () => {
      await openAlpha();
      const list = screen.getByTestId('repository-tab-popover-list');
      expect(list.className).toContain('overflow-y-auto');
      // 10 rows at the medium factor (1.0).
      expect(list.style.maxHeight).toBe('520px');
    });

    it('has no search box — that job belongs to the command palette', async () => {
      await openAlpha();
      const popover = screen.getByTestId('repository-tab-popover');
      expect(within(popover).queryByRole('textbox')).toBeNull();
    });
  });

  describe('overflow', () => {
    it('offers no overflow menu while every tab fits', async () => {
      renderStrip();
      await waitFor(() => expect(tabNames()).toHaveLength(2));
      expect(screen.queryByTestId('repository-tab-overflow')).toBeNull();
    });

    it('offers every repository through the overflow menu once the strip is too narrow', async () => {
      seedOrderCache();
      renderStrip();
      await waitFor(() => expect(tabNames()).toEqual(SAVED_ORDER));

      const strip = screen.getByTestId('repository-tab-strip');
      Object.defineProperty(strip, 'scrollWidth', { value: 1200, configurable: true });
      Object.defineProperty(strip, 'clientWidth', { value: 400, configurable: true });
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });

      const trigger = screen.getByTestId('repository-tab-overflow');
      fireEvent.click(trigger);

      const menu = screen.getByTestId('repository-tab-overflow-menu');
      expect(
        within(menu)
          .getAllByTestId('repository-tab-overflow-item')
          .map((item) => item.getAttribute('data-repository'))
      ).toEqual(SAVED_ORDER);
    });
  });

  /**
   * Issue #2374 follow-up: the tab used to mark a repository with an 8px
   * colour chip, which sat a few pixels from the aggregated `StatusDot` and
   * read as a second status dot. The tab now uses the sidebar's folder glyph.
   *
   * The assertion compares the two surfaces rather than a hand-written path:
   * "same icon as the sidebar" is the requirement, so a test that pinned a
   * literal `d` would keep passing if only one of the two ever changed.
   */
  describe('repository glyph agrees with the sidebar', () => {
    it('marks a tab with the sidebar\'s folder icon, not a second dot', async () => {
      renderStrip(<Sidebar />);
      await waitFor(() => expect(tabNames()).toEqual(SAVED_ORDER));
      await waitFor(() =>
        expect(screen.getAllByTestId('group-header')).toHaveLength(2)
      );

      // A group header paints two glyphs — the expand chevron and the folder —
      // so the assertion is that the tab's glyph is ONE OF the sidebar's, not
      // that it is the first one.
      const sidebarPaths = Array.from(
        screen.getAllByTestId('group-header')[0].querySelectorAll('svg path')
      ).map((path) => path.getAttribute('d'));
      expect(sidebarPaths.length).toBeGreaterThan(1);

      const tab = screen.getAllByTestId('repository-tab')[0];
      const tabPath = tab.querySelector('svg path')?.getAttribute('d');

      expect(tabPath).toBeTruthy();
      expect(sidebarPaths).toContain(tabPath);

      // The old chip was the only `rounded-sm` box in the tab; the status dot
      // it was confused with is `rounded-full`, so its absence is what says
      // the two shapes are no longer the same.
      expect(tab.querySelector('span.rounded-sm')).toBeNull();
    });

    it('marks an overflow row with the same folder icon', async () => {
      renderStrip(<Sidebar />);
      await waitFor(() => expect(tabNames()).toEqual(SAVED_ORDER));
      await waitFor(() =>
        expect(screen.getAllByTestId('group-header')).toHaveLength(2)
      );
      const sidebarPaths = Array.from(
        screen.getAllByTestId('group-header')[0].querySelectorAll('svg path')
      ).map((path) => path.getAttribute('d'));

      // jsdom has no layout, so the overflow menu only exists once the strip is
      // told it does not fit — the same stubbing the `overflow` suite uses.
      const strip = screen.getByTestId('repository-tab-strip');
      Object.defineProperty(strip, 'scrollWidth', { value: 1200, configurable: true });
      Object.defineProperty(strip, 'clientWidth', { value: 400, configurable: true });
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });

      fireEvent.click(screen.getByTestId('repository-tab-overflow'));
      const menu = screen.getByTestId('repository-tab-overflow-menu');
      const rowPath = within(menu)
        .getAllByTestId('repository-tab-overflow-item')[0]
        .querySelector('svg path')
        ?.getAttribute('d');

      expect(rowPath).toBeTruthy();
      expect(sidebarPaths).toContain(rowPath);
    });
  });

  /**
   * Issue #2480: a mouse-connected macOS draws a classic, always-visible
   * scrollbar, which took 15 of the band's 32px and squashed the tabs into
   * the top half. The strip now hides it, so these pin what replaces it: the
   * class that hides it, a wheel that scrolls without it, and the current tab
   * kept in view, since nothing else shows where the strip is scrolled to.
   */
  describe('scrolling with the scrollbar hidden (Issue #2480)', () => {
    /** Change the route the way the App Router does: new pathname, subscribers told. */
    function navigateTo(pathname: string): void {
      mockPathname.mockReturnValue(pathname);
      act(() => {
        pathnameListeners.forEach((listener) => listener());
      });
    }

    it('hides the scrollbar but still scrolls', async () => {
      renderStrip();
      await waitFor(() => expect(tabNames()).toHaveLength(2));
      const strip = screen.getByTestId('repository-tab-strip');
      expect(strip.className).toContain('scrollbar-hide');
      expect(strip.className).toContain('overflow-x-auto');
    });

    describe('mouse wheel', () => {
      it('turns a vertical wheel over a tab into a sideways scroll of the strip', async () => {
        renderStrip();
        await waitFor(() => expect(tabNames()).toHaveLength(2));
        const strip = screen.getByTestId('repository-tab-strip');
        const tab = screen.getAllByTestId('repository-tab')[0];

        fireEvent.wheel(tab, { deltaY: 120 });
        expect(strip.scrollLeft).toBe(120);
        fireEvent.wheel(strip, { deltaY: -50 });
        expect(strip.scrollLeft).toBe(70);
        // The strip scrolls, not the tab the pointer happened to be over.
        expect(tab.scrollLeft).toBe(0);
      });

      it('leaves a trackpad swipe to the browser, which already scrolls the strip', async () => {
        renderStrip();
        await waitFor(() => expect(tabNames()).toHaveLength(2));
        const strip = screen.getByTestId('repository-tab-strip');

        fireEvent.wheel(strip, { deltaX: 80, deltaY: 12 });
        expect(strip.scrollLeft).toBe(0);
      });
    });

    describe('resolveWheelScrollLeftDelta', () => {
      function wheel(
        init: Partial<Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey' | 'shiftKey'>>
      ) {
        return { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, shiftKey: false, ...init };
      }

      it('passes a pixel-mode vertical delta straight through, in both directions', () => {
        expect(resolveWheelScrollLeftDelta(wheel({ deltaY: 100 }), 400)).toBe(100);
        expect(resolveWheelScrollLeftDelta(wheel({ deltaY: -100 }), 400)).toBe(-100);
      });

      it('turns a line-mode notch (Firefox with a mouse) into about a pixel-mode notch', () => {
        // Three lines is one notch; a pixel-mode browser reports ~100px for it.
        const delta = resolveWheelScrollLeftDelta(wheel({ deltaY: 3, deltaMode: 1 }), 400);
        expect(delta).toBeGreaterThanOrEqual(60);
        expect(delta).toBeLessThanOrEqual(150);
      });

      it('takes a page-mode delta as one visible width of the strip', () => {
        expect(resolveWheelScrollLeftDelta(wheel({ deltaY: 1, deltaMode: 2 }), 400)).toBe(400);
      });

      it('leaves a mostly-horizontal gesture to the browser', () => {
        expect(resolveWheelScrollLeftDelta(wheel({ deltaX: 40, deltaY: 10 }), 400)).toBe(0);
        expect(resolveWheelScrollLeftDelta(wheel({ deltaX: -30, deltaY: 30 }), 400)).toBe(0);
      });

      it('leaves Shift+wheel and Ctrl+wheel (a trackpad pinch-zoom) to the browser', () => {
        expect(resolveWheelScrollLeftDelta(wheel({ deltaY: 100, shiftKey: true }), 400)).toBe(0);
        expect(resolveWheelScrollLeftDelta(wheel({ deltaY: 100, ctrlKey: true }), 400)).toBe(0);
      });
    });

    describe('current tab', () => {
      const originalScrollIntoView = Element.prototype.scrollIntoView;
      const scrollIntoView = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();

      beforeEach(() => {
        // jsdom does not implement scrollIntoView.
        scrollIntoView.mockClear();
        Element.prototype.scrollIntoView = scrollIntoView;
      });

      afterEach(() => {
        Element.prototype.scrollIntoView = originalScrollIntoView;
      });

      /** Repositories whose tab was scrolled into view, in call order. */
      function revealed(): string[] {
        return scrollIntoView.mock.contexts.map(
          (el) => (el as Element).getAttribute('data-repository') ?? ''
        );
      }

      it('scrolls the current repository\'s tab into view on first paint', async () => {
        mockPathname.mockReturnValue('/worktrees/zebra-main');
        renderStrip();

        await waitFor(() => expect(revealed()).toContain('zebra-tools'));
        expect(revealed()).not.toContain('alpha-app');
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
      });

      it('scrolls the new repository\'s tab into view after a navigation', async () => {
        mockPathname.mockReturnValue('/worktrees/alpha-main');
        renderStrip();
        await waitFor(() => expect(revealed()).toContain('alpha-app'));
        scrollIntoView.mockClear();

        navigateTo('/worktrees/zebra-main');

        expect(revealed()).toEqual(['zebra-tools']);
      });

      it('brings the tab back after a navigation within the same repository', async () => {
        // The user may have scrolled the strip away since the last reveal, so
        // a new branch of the same repository must reveal its tab again.
        mockPathname.mockReturnValue('/worktrees/alpha-main');
        renderStrip();
        await waitFor(() => expect(revealed()).toContain('alpha-app'));
        scrollIntoView.mockClear();

        navigateTo('/worktrees/alpha-feature');

        expect(revealed()).toEqual(['alpha-app']);
      });

      it('scrolls it into view again once the "…" button narrows the strip', async () => {
        mockPathname.mockReturnValue('/worktrees/zebra-main');
        renderStrip();
        await waitFor(() => expect(revealed()).toContain('zebra-tools'));
        scrollIntoView.mockClear();

        const strip = screen.getByTestId('repository-tab-strip');
        Object.defineProperty(strip, 'scrollWidth', { value: 1200, configurable: true });
        Object.defineProperty(strip, 'clientWidth', { value: 400, configurable: true });
        act(() => {
          window.dispatchEvent(new Event('resize'));
        });

        expect(screen.getByTestId('repository-tab-overflow')).toBeInTheDocument();
        expect(revealed()).toEqual(['zebra-tools']);
      });

      it('scrolls nothing while no worktree is on screen', async () => {
        renderStrip();
        await waitFor(() => expect(tabNames()).toHaveLength(2));
        expect(scrollIntoView).not.toHaveBeenCalled();
      });
    });
  });
});
