/**
 * The worktree list does not undo a status save with an older reply
 * (Issue #3594, review follow-up).
 *
 * A list fetch that left BEFORE a save landed read the server before it, so
 * its reply carries the old status. Applying it would flip the row back
 * (Done → Ready) until the next poll. A fetch that left AFTER the save shows
 * whatever the server says.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useWorktreesCache } from '@/hooks/useWorktreesCache';
import {
  __resetWorktreeStatusSaves,
  currentWorktreeStatusGeneration,
  saveWorktreeStatus,
  worktreeListFetchedSince,
} from '@/lib/worktree-status';

vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: () => ({
    status: 'disconnected' as const,
    connected: false,
    subscribe: () => {},
    unsubscribe: () => {},
    addListener: () => () => {},
  }),
}));

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

function list(status: string | null) {
  return {
    worktrees: [{ id: 'wt-1', name: 'feature/a', path: '/p', repositoryPath: '/r', repositoryName: 'r', status }],
    repositories: [],
  };
}

const originalFetch = globalThis.fetch;
let listReplies: Array<(body: unknown, status?: number) => void>;

beforeEach(() => {
  __resetWorktreeStatusSaves();
  listReplies = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const status = JSON.parse(String(init.body)).status;
      return Promise.resolve(jsonResponse({ id: 'wt-1', status }));
    }
    // Every list GET waits until the test answers it.
    return new Promise((resolve) =>
      listReplies.push((body, status = 200) => resolve(jsonResponse(body, status)))
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetWorktreeStatusSaves();
  vi.restoreAllMocks();
});

async function mountWithReady() {
  const hook = renderHook(() => useWorktreesCache());
  await waitFor(() => expect(listReplies).toHaveLength(1));
  await act(async () => listReplies[0](list('ready')));
  await waitFor(() => expect(hook.result.current.worktrees[0]?.status).toBe('ready'));
  return hook;
}

describe('useWorktreesCache vs. a status save (Issue #3594)', () => {
  it('keeps Done when a fetch that started before the save answers Ready', async () => {
    const { result } = await mountWithReady();
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = result.current.refresh();
    });
    await waitFor(() => expect(listReplies).toHaveLength(2));

    await act(async () => {
      await saveWorktreeStatus('wt-1', 'done');
    });
    await act(async () => {
      listReplies[1](list('ready'));
      await refreshing;
    });
    expect(result.current.worktrees[0].status).toBe('done');
  });

  it('shows the server value for a fetch that started after the save (negative control)', async () => {
    const { result } = await mountWithReady();
    await act(async () => {
      await saveWorktreeStatus('wt-1', 'done');
    });
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = result.current.refresh();
    });
    await waitFor(() => expect(listReplies).toHaveLength(2));
    await act(async () => {
      // Changed again elsewhere after our save.
      listReplies[1](list('in_review'));
      await refreshing;
    });
    expect(result.current.worktrees[0].status).toBe('in_review');
  });
});

describe('useWorktreesCache tells whether a re-fetch went through (Issue #3594)', () => {
  /** Save Done, then re-fetch the list and answer it with `status`. */
  async function saveThenRefresh(status: number) {
    const { result } = await mountWithReady();
    await act(async () => {
      await saveWorktreeStatus('wt-1', 'done');
    });
    const savedAt = currentWorktreeStatusGeneration();
    expect(worktreeListFetchedSince(savedAt)).toBe(false);
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = result.current.refresh();
    });
    await waitFor(() => expect(listReplies).toHaveLength(2));
    await act(async () => {
      listReplies[1](list('done'), status);
      await refreshing;
    });
    return savedAt;
  }

  it('does not count a failed re-fetch (refresh still resolves)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const savedAt = await saveThenRefresh(500);
    expect(worktreeListFetchedSince(savedAt)).toBe(false);
  });

  it('counts a successful re-fetch that started after the save (negative control)', async () => {
    const savedAt = await saveThenRefresh(200);
    expect(worktreeListFetchedSince(savedAt)).toBe(true);
  });
});
