/**
 * @vitest-environment jsdom
 */

/**
 * The tab strip's two drop-down lists stay inside the viewport (Issue #3513).
 *
 * Since #3512 the strip can sit below the 64px header (beside the icon rail),
 * so its lists start ~96px down. Their cap used to be a fixed ten rows (520px
 * at the medium size) whatever the window height, and on a 580px-high window
 * the last rows ran off the bottom. The rule pinned here: neither list is
 * taller than the room left under its anchor; a tall window keeps the cap.
 *
 * Positive control — a short window and many branches/repositories: fails on
 * the fixed 520px. Negative control — a tall window: still exactly 520px.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: { getAll: vi.fn(), getById: vi.fn() },
    repositoryApi: { sync: vi.fn() },
  };
});

import { worktreeApi } from '@/lib/api-client';
import {
  RepositoryTabBar,
  resolvePopoverMaxHeight,
} from '@/components/layout/RepositoryTabBar';
import { ToastProvider } from '@/components/common/Toast';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';

/** The band beside the rail: 64px header + 32px band. */
const ANCHOR_BOTTOM = 96;
/** The fixed cap the lists had (ten 52px rows at the medium size). */
const CAP = 520;
/** Gap between anchor and list, and the bottom margin (RepositoryTabBar). */
const GAP = 4;

/**
 * 30 branches in `repo-00` (its branch list is longer than ten rows) and one
 * in each of 11 more repositories (12 rows in the overflow menu).
 */
const WORKTREES: Worktree[] = Array.from({ length: 41 }, (_, i) => {
  const repo = i < 30 ? 'repo-00' : `repo-${String(i - 29).padStart(2, '0')}`;
  return {
    id: `${repo}-b${i}`,
    name: `branch-${i}`,
    path: `/repos/${repo}/b${i}`,
    repositoryPath: `/repos/${repo}`,
    repositoryName: repo,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as Worktree;
});

const originalInnerHeight = window.innerHeight;
const originalFetch = global.fetch;

function setViewportHeight(height: number): void {
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
}

function renderStrip() {
  return render(
    <ToastProvider>
      <SidebarProvider>
        <WorktreeSelectionProvider>
          <RepositoryTabBar />
        </WorktreeSelectionProvider>
      </SidebarProvider>
    </ToastProvider>
  );
}

/** Every element's rect reads as sitting in the band below the header. */
function placeEverythingInBand(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 56,
    right: 200,
    top: ANCHOR_BOTTOM - 32,
    bottom: ANCHOR_BOTTOM,
    width: 144,
    height: 32,
    x: 56,
    y: ANCHOR_BOTTOM - 32,
    toJSON: () => ({}),
  } as DOMRect);
}

async function openRepo00(): Promise<HTMLElement> {
  renderStrip();
  await waitFor(() => expect(screen.getAllByTestId('repository-tab').length).toBeGreaterThan(1));
  const tab = screen
    .getAllByTestId('repository-tab')
    .find((t) => t.getAttribute('data-repository') === 'repo-00')!;
  fireEvent.click(tab);
  return screen.getByTestId('repository-tab-popover-list');
}

async function openOverflowMenu(): Promise<HTMLElement> {
  renderStrip();
  await waitFor(() => expect(screen.getAllByTestId('repository-tab').length).toBeGreaterThan(1));
  const strip = screen.getByTestId('repository-tab-strip');
  Object.defineProperty(strip, 'scrollWidth', { value: 2400, configurable: true });
  Object.defineProperty(strip, 'clientWidth', { value: 400, configurable: true });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  fireEvent.click(screen.getByTestId('repository-tab-overflow'));
  return screen.getByTestId('repository-tab-overflow-list');
}

function px(value: string): number {
  return Number.parseFloat(value);
}

describe('resolvePopoverMaxHeight (Issue #3513)', () => {
  it('caps by the room under the anchor on a short window', () => {
    const height = resolvePopoverMaxHeight(ANCHOR_BOTTOM, CAP, 580);
    expect(height).toBeLessThan(CAP);
    expect(ANCHOR_BOTTOM + GAP + height).toBeLessThanOrEqual(580);
  });

  it('keeps the cap exactly on a tall window', () => {
    expect(resolvePopoverMaxHeight(ANCHOR_BOTTOM, CAP, 1080)).toBe(CAP);
  });

  it('never goes negative', () => {
    expect(resolvePopoverMaxHeight(ANCHOR_BOTTOM, CAP, 50)).toBe(0);
  });
});

describe('RepositoryTabBar lists fit the viewport (Issue #3513)', () => {
  beforeEach(() => {
    localStorage.clear();
    (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      worktrees: WORKTREES,
      repositories: [],
    });
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, order: [] }),
    })) as unknown as typeof fetch;
    placeEverythingInBand();
  });

  afterEach(() => {
    setViewportHeight(originalInnerHeight);
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('short window (580px, header + band above the list)', () => {
    beforeEach(() => setViewportHeight(580));

    it("keeps the branch list's last row on screen", async () => {
      const list = await openRepo00();
      const maxHeight = px(list.style.maxHeight);
      expect(maxHeight).toBeLessThan(CAP);
      expect(ANCHOR_BOTTOM + GAP + maxHeight).toBeLessThanOrEqual(580);
    });

    it("keeps the overflow menu's last row on screen", async () => {
      const list = await openOverflowMenu();
      const maxHeight = px(list.style.maxHeight);
      expect(maxHeight).toBeLessThan(CAP);
      expect(ANCHOR_BOTTOM + GAP + maxHeight).toBeLessThanOrEqual(580);
    });
  });

  describe('tall window (1080px)', () => {
    beforeEach(() => setViewportHeight(1080));

    it('keeps the branch list at the ten-row cap', async () => {
      const list = await openRepo00();
      expect(list.style.maxHeight).toBe(`${CAP}px`);
    });

    it('keeps the overflow menu at the ten-row cap', async () => {
      const list = await openOverflowMenu();
      expect(list.style.maxHeight).toBe(`${CAP}px`);
    });
  });
});

describe('RepositoryTabBar look (Issue #3513)', () => {
  beforeEach(() => {
    localStorage.clear();
    (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      worktrees: WORKTREES.slice(30),
      repositories: [],
    });
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, order: [] }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("shares the icon rail's surface", async () => {
    renderStrip();
    await waitFor(() => expect(screen.getByTestId('repository-tab-bar')).toBeInTheDocument());
    expect(screen.getByTestId('repository-tab-bar').className).toMatch(/\bbg-sidebar\b/);
  });
});
