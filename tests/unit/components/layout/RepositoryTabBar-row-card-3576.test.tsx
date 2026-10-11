/**
 * @vitest-environment jsdom
 */

/**
 * The tab strip's branch list uses the sidebar's own `BranchListItem`, so the
 * row card of Issue #3576 shows there too: the active row is the filled card
 * with "…", and picking from that "…" menu (portalled out of the popover) does
 * not close the popover underneath first.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/alpha-a',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: { getAll: vi.fn(), getById: vi.fn(), markAsViewed: vi.fn() },
    repositoryApi: { sync: vi.fn() },
  };
});

import { RepositoryTabBar } from '@/components/layout/RepositoryTabBar';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';

function worktree(id: string, name: string, repo: string): Worktree {
  return {
    id,
    name,
    path: `/repos/${repo}/${id}`,
    repositoryPath: `/repos/${repo}`,
    repositoryName: repo,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as Worktree;
}

const WORKTREES: Worktree[] = [
  worktree('alpha-a', 'a', 'alpha'),
  worktree('alpha-b', 'b', 'alpha'),
  worktree('beta-main', 'main', 'beta'),
];

async function openAlpha(): Promise<HTMLElement> {
  render(
    <SidebarProvider>
      <WorktreeSelectionProvider externalWorktrees={WORKTREES} externalRepositories={[]}>
        <RepositoryTabBar />
      </WorktreeSelectionProvider>
    </SidebarProvider>
  );
  await waitFor(() => expect(screen.getAllByTestId('repository-tab')).toHaveLength(2));
  const alpha = screen.getAllByTestId('repository-tab').find((t) => t.getAttribute('data-repository') === 'alpha')!;
  fireEvent.click(alpha);
  return screen.getByTestId('repository-tab-popover');
}

const originalFetch = global.fetch;

beforeAll(() => installRadixJsdomPolyfills());

beforeEach(() => {
  localStorage.clear();
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, order: [] }),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('tab strip branch list rows (Issue #3576)', () => {
  it('draws the active row as the filled card with "…", the others without', async () => {
    const popover = await openAlpha();
    const items = within(popover).getAllByTestId('branch-list-item');
    const active = items.find((el) => el.getAttribute('aria-current') === 'true')!;
    const other = items.find((el) => el !== active)!;

    expect(active.className).toMatch(/(^|\s)bg-sidebar-border(\s|$)/);
    expect(active.className).not.toMatch(/border-accent-500/);
    expect(other.className).not.toMatch(/(^|\s)bg-sidebar-border(\s|$)/);
    expect(within(popover).getAllByTestId('branch-row-actions')).toHaveLength(1);
    expect(active.parentElement!.contains(within(popover).getByTestId('branch-row-actions'))).toBe(true);
  });

  it('keeps the popover open while its row menu is used', async () => {
    const popover = await openAlpha();
    fireEvent.keyDown(within(popover).getByTestId('branch-row-actions'), { key: 'Enter' });
    const item = screen.getByRole('menuitem', { name: 'Copy branch name' });

    fireEvent.mouseDown(item);
    expect(screen.getByTestId('repository-tab-popover')).toBeInTheDocument();
  });

  it('still closes on a mousedown outside (negative control)', async () => {
    await openAlpha();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('repository-tab-popover')).not.toBeInTheDocument();
  });
});
