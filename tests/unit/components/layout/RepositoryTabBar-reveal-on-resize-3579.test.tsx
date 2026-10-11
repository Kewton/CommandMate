/**
 * @vitest-environment jsdom
 */

/**
 * The current tab stays in view when the strip's width changes (Issue #3579).
 *
 * Since #3579 the strip sits in <main>, right of the sidebar, so opening the
 * sidebar (in "always" mode) or dragging its width narrows the strip. The tab
 * marked current was only re-revealed when the overflow flag flipped, so a
 * strip that already overflowed and only got narrower left the current tab
 * scrolled out of sight. Now any change of the strip's width reveals it again;
 * a data refresh (the worktree poll) at the same width still does not move the
 * strip the user may be scrolling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => '/worktrees/zebra-main',
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
import { RepositoryTabBar } from '@/components/layout/RepositoryTabBar';
import { ToastProvider } from '@/components/common/Toast';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider, useWorktreeSelection } from '@/contexts/WorktreeSelectionContext';

function wt(id: string, repositoryName: string, extra: Partial<Worktree> = {}): Worktree {
  return {
    id,
    name: 'main',
    path: `/repos/${id}`,
    repositoryPath: `/repos/${repositoryName}`,
    repositoryName,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  } as Worktree;
}

const WORKTREES: Worktree[] = [wt('alpha-main', 'alpha-app'), wt('zebra-main', 'zebra-tools')];

let refresh: (() => Promise<void>) | null = null;
function RefreshHandle() {
  refresh = useWorktreeSelection().refreshWorktrees;
  return null;
}

function renderStrip() {
  return render(
    <ToastProvider>
      <SidebarProvider>
        <WorktreeSelectionProvider>
          <RepositoryTabBar />
          <RefreshHandle />
        </WorktreeSelectionProvider>
      </SidebarProvider>
    </ToastProvider>,
  );
}

const originalScrollIntoView = Element.prototype.scrollIntoView;
const originalFetch = global.fetch;
const scrollIntoView = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();

function revealed(): string[] {
  return scrollIntoView.mock.contexts.map((el) => (el as Element).getAttribute('data-repository') ?? '');
}

function setStripSize(strip: HTMLElement, clientWidth: number): void {
  Object.defineProperty(strip, 'scrollWidth', { value: 1200, configurable: true });
  Object.defineProperty(strip, 'clientWidth', { value: clientWidth, configurable: true });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  localStorage.clear();
  refresh = null;
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
  (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({ worktrees: WORKTREES, repositories: [] });
  (worktreeApi.getById as ReturnType<typeof vi.fn>).mockResolvedValue(WORKTREES[1]);
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, order: null }) })) as unknown as typeof fetch;
});

afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function overflowingStrip(): Promise<HTMLElement> {
  renderStrip();
  await waitFor(() => expect(revealed()).toContain('zebra-tools'));
  const strip = screen.getByTestId('repository-tab-strip');
  setStripSize(strip, 600);
  expect(screen.getByTestId('repository-tab-overflow')).toBeInTheDocument();
  scrollIntoView.mockClear();
  return strip;
}

describe('current tab after a strip width change (Issue #3579)', () => {
  // Positive control: the overflow flag stays true, only the width changes
  // (the sidebar opened beside an "always" strip, or its edge was dragged).
  it('reveals the current tab again when an overflowing strip gets narrower', async () => {
    const strip = await overflowingStrip();
    setStripSize(strip, 360);
    expect(revealed()).toEqual(['zebra-tools']);
  });

  it('reveals it again when the strip gets wider (sidebar closed / dragged narrower)', async () => {
    const strip = await overflowingStrip();
    setStripSize(strip, 800);
    expect(revealed()).toEqual(['zebra-tools']);
  });

  it('does not scroll on a resize event that leaves the width as it was (negative control)', async () => {
    const strip = await overflowingStrip();
    setStripSize(strip, 600);
    expect(revealed()).toEqual([]);
  });

  it('does not scroll on a data refresh at the same width (negative control)', async () => {
    await overflowingStrip();
    const callsBefore = (worktreeApi.getAll as ReturnType<typeof vi.fn>).mock.calls.length;
    (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      worktrees: [
        WORKTREES[0],
        wt('zebra-main', 'zebra-tools', { isSessionRunning: true, isWaitingForResponse: true }),
      ],
      repositories: [],
    });
    await act(async () => {
      await refresh?.();
    });
    expect((worktreeApi.getAll as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
    expect(revealed()).toEqual([]);
  });
});
