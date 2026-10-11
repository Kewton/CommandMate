/**
 * Sidebar selection follows the URL (Issue #3578): a direct open, reload or
 * back/forward changes `pathname` without calling `selectWorktree`.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

let mockPathname = '/';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: {
      getAll: vi.fn(),
      getById: vi.fn().mockResolvedValue(null),
      markAsViewed: vi.fn().mockResolvedValue(undefined),
    },
    repositoryApi: { sync: vi.fn() },
  };
});

import { Sidebar } from '@/components/layout/Sidebar';
import { SidebarProvider, SIDEBAR_VIEW_MODE_STORAGE_KEY } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';
import { resolveActiveWorktreeId } from '@/lib/sidebar-utils';

const REPO = '/repos/app';

function wt(overrides: Record<string, unknown> & { id: string }): Worktree {
  return {
    name: overrides.id,
    path: `${REPO}/${overrides.id}`,
    repositoryPath: REPO,
    repositoryName: 'App',
    isSessionRunning: false,
    ...overrides,
  } as unknown as Worktree;
}

const WORKTREES: Worktree[] = [
  wt({ id: 'main', name: 'main' }),
  wt({
    id: 'feat',
    name: 'feature/x',
    isSessionRunning: true,
    agentInstances: [{ id: 'claude', cliTool: 'claude', order: 0 }],
    sessionStatusByInstance: { claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false } },
  }),
  wt({ id: 'd-idle', name: 'detached-aaaa111' }),
  wt({ id: 'd-idle-2', name: 'detached-bbbb222' }),
];

function tree() {
  return (
    <SidebarProvider>
      <WorktreeSelectionProvider externalWorktrees={WORKTREES} externalRepositories={[]}>
        <Sidebar />
      </WorktreeSelectionProvider>
    </SidebarProvider>
  );
}

const currentRows = () =>
  screen
    .queryAllByTestId(/^(branch|session)-list-item$/)
    .filter((el) => el.getAttribute('aria-current'))
    .map((el) => el.querySelector('p')?.textContent ?? el.textContent);

beforeEach(() => {
  localStorage.clear();
  mockPathname = '/';
  global.fetch = vi.fn().mockResolvedValue({ json: async () => ({ success: true, order: null }) }) as unknown as typeof fetch;
});

describe('resolveActiveWorktreeId', () => {
  it('prefers the worktree route over the context selection', () => {
    expect(resolveActiveWorktreeId('/worktrees/a%20b/chat', 'other')).toBe('a b');
  });
  it('falls back to the context selection off worktree routes (negative control)', () => {
    expect(resolveActiveWorktreeId('/sessions', 'other')).toBe('other');
    expect(resolveActiveWorktreeId('/sessions', null)).toBeNull();
  });
});

describe('Sidebar selection by pathname (Issue #3578)', () => {
  it.each(['grouped', 'flat', 'sessions'] as const)('marks the open worktree in the %s view on a direct open', async (mode) => {
    localStorage.setItem(SIDEBAR_VIEW_MODE_STORAGE_KEY, mode);
    mockPathname = '/worktrees/feat';
    render(tree());

    await screen.findAllByTestId(/^(branch|session)-list-item$/);
    const rows = currentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('feature/x');
  });

  it('marks nothing off a worktree route with no selection (negative control)', async () => {
    render(tree());
    await screen.findAllByTestId('branch-list-item');
    expect(currentRows()).toEqual([]);
  });

  it('follows back/forward: the mark moves when only pathname changes', async () => {
    mockPathname = '/worktrees/feat';
    const { rerender } = render(tree());
    await screen.findAllByTestId('branch-list-item');
    expect(currentRows()).toEqual(['feature/x']);

    mockPathname = '/worktrees/main';
    rerender(tree());
    expect(currentRows()).toEqual(['main']);
  });

  it('takes a detached worktree opened directly out of "Other"', async () => {
    render(tree());
    expect(await screen.findByTestId('branch-group-other-toggle')).toHaveTextContent('Other (2)');

    mockPathname = '/worktrees/d-idle';
    render(tree());
    const toggles = await screen.findAllByTestId('branch-group-other-toggle');
    expect(toggles[toggles.length - 1]).toHaveTextContent('Other (1)');
    expect(currentRows()).toContain('detached-aaaa111');
  });
});
