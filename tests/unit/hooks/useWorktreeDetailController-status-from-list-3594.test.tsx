/**
 * The detail screen follows a status set from a branch row's "…" (Issue #3594).
 *
 * The row saves and re-fetches the worktree LIST. The screen's own copy of the
 * worktree (which the Info field reads) comes from the detail poll, so without
 * help it would show the old status until the next poll. The controller carries
 * a change of the cached list value into its copy at once.
 *
 * The detail endpoint keeps answering the OLD status here, so only the list
 * change can move the screen's value.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { Worktree } from '@/types/models';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-3594',
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
}));

const cache = vi.hoisted(() => ({ worktrees: [] as unknown[] }));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => ({
    worktrees: cache.worktrees,
    repositories: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/components/common/Toast', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useToast: () => ({ showToast: vi.fn() }) };
});

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';

const WORKTREE_ID = 'wt-3594';

const WORKTREE = {
  id: WORKTREE_ID,
  name: 'feature/3594',
  path: '/path/to/wt',
  repositoryPath: '/path/to/repo',
  repositoryName: 'MyRepo',
  status: 'in_progress',
} as Worktree;

function jsonReply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function stubFetch(): void {
  global.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/current-output')) return Promise.resolve(jsonReply(200, { isRunning: false }));
    if (url.includes('/messages')) return Promise.resolve(jsonReply(200, []));
    if (url.includes('/auto-yes')) return Promise.resolve(jsonReply(200, { instances: {} }));
    if (url.includes(`/api/worktrees/${WORKTREE_ID}`)) return Promise.resolve(jsonReply(200, WORKTREE));
    return Promise.resolve(jsonReply(404, {}));
  }) as unknown as typeof fetch;
}

afterEach(() => {
  cache.worktrees = [];
  vi.restoreAllMocks();
});

describe('[#3594] the detail screen follows the list status', () => {
  it('takes a new status from the list at once', async () => {
    stubFetch();
    cache.worktrees = [{ ...WORKTREE }];
    const { result, rerender } = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));
    await waitFor(() => expect(result.current.worktree?.status).toBe('in_progress'));

    cache.worktrees = [{ ...WORKTREE, status: 'done' }];
    rerender();
    await waitFor(() => expect(result.current.worktree?.status).toBe('done'));
  });

  it('leaves the screen alone while the list value does not change (negative control)', async () => {
    stubFetch();
    cache.worktrees = [{ ...WORKTREE }];
    const { result, rerender } = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));
    await waitFor(() => expect(result.current.worktree?.status).toBe('in_progress'));

    // Another worktree's change is not this screen's.
    cache.worktrees = [{ ...WORKTREE }, { ...WORKTREE, id: 'wt-other', status: 'done' }];
    rerender();
    expect(result.current.worktree?.status).toBe('in_progress');
  });
});
