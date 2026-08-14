/**
 * The sidebar cache applying the waiting edge (Issue #1788).
 * @vitest-environment jsdom
 *
 * Covers the three things that can silently go wrong here:
 *
 *  1. the waiting frame is dropped because it carries no `isRunning` (the old
 *     guard did exactly that, and the badge would then only ever move on a poll);
 *  2. one instance finishing clears a worktree whose sibling instance is still
 *     waiting;
 *  3. the push path quietly replaces the poll, so a client with no WebSocket
 *     stops learning about waits altogether.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useWorktreesCache, POLLING_INTERVAL_ACTIVE } from '@/hooks/useWorktreesCache';
import type { Worktree } from '@/types/models';

const realtimeMock = vi.hoisted(() => {
  const listeners: Array<(e: unknown) => void> = [];
  const api = {
    status: 'connected' as const,
    connected: true,
    subscribe: () => {},
    unsubscribe: () => {},
    addListener: (l: (e: unknown) => void) => {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
  return {
    listeners,
    emit: (event: unknown) => {
      for (const l of [...listeners]) l(event);
    },
    useRealtime: () => api,
    setConnected: (v: boolean) => {
      (api as { connected: boolean }).connected = v;
      (api as { status: string }).status = v ? 'connected' : 'disconnected';
    },
  };
});
vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: realtimeMock.useRealtime,
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function respondWith(worktrees: Worktree[]) {
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ worktrees, repositories: [] }) });
}

function waitingFrame(overrides: Record<string, unknown>) {
  return {
    type: 'session_status_changed',
    worktreeId: 'wt-1',
    cliTool: 'claude',
    instance: 'claude',
    isWaitingForResponse: true,
    waitingKind: 'prompt',
    waitingSince: 1_760_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  realtimeMock.listeners.length = 0;
  realtimeMock.setConnected(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useWorktreesCache: waiting edge (Issue #1788)', () => {
  it('flips the targeted worktree to waiting on a push, without a refetch', async () => {
    respondWith([
      { id: 'wt-1', name: 'a', path: '/a', repositoryPath: '/r', repositoryName: 'R' },
      { id: 'wt-2', name: 'b', path: '/b', repositoryPath: '/r', repositoryName: 'R' },
    ]);
    const { result } = renderHook(() => useWorktreesCache());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const fetchesAfterLoad = mockFetch.mock.calls.length;

    act(() => realtimeMock.emit(waitingFrame({})));

    await waitFor(() => {
      expect(result.current.worktrees[0].isWaitingForResponse).toBe(true);
    });
    expect(result.current.worktrees[1].isWaitingForResponse).toBeUndefined();
    // The frame carries the answer; re-asking the server would defeat the point.
    expect(mockFetch.mock.calls.length).toBe(fetchesAfterLoad);
  });

  it('updates the per-instance entry it already knows about', async () => {
    respondWith([
      {
        id: 'wt-1',
        name: 'a',
        path: '/a',
        repositoryPath: '/r',
        repositoryName: 'R',
        sessionStatusByInstance: {
          claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
        },
      },
    ]);
    const { result } = renderHook(() => useWorktreesCache());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => realtimeMock.emit(waitingFrame({})));

    await waitFor(() => {
      expect(result.current.worktrees[0].sessionStatusByInstance?.claude).toMatchObject({
        isRunning: true,
        isWaitingForResponse: true,
        waitingKind: 'prompt',
      });
    });
  });

  it('does not invent a per-instance entry for an instance it has never seen', async () => {
    // Creating one would mean making up `isRunning` / `isProcessing`, and those
    // drive the sidebar dot.
    respondWith([{ id: 'wt-1', name: 'a', path: '/a', repositoryPath: '/r', repositoryName: 'R' }]);
    const { result } = renderHook(() => useWorktreesCache());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => realtimeMock.emit(waitingFrame({ instance: 'codex-7', cliTool: 'codex' })));

    await waitFor(() => expect(result.current.worktrees[0].isWaitingForResponse).toBe(true));
    expect(result.current.worktrees[0].sessionStatusByInstance).toBeUndefined();
  });

  it('leaves the per-CLI aggregate to the poll', async () => {
    // One instance's edge cannot decide a tool-level OR: an alias going quiet
    // says nothing about the primary. A stale dot beats a wrong one.
    respondWith([
      {
        id: 'wt-1',
        name: 'a',
        path: '/a',
        repositoryPath: '/r',
        repositoryName: 'R',
        sessionStatusByCli: {
          claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
        },
      },
    ]);
    const { result } = renderHook(() => useWorktreesCache());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => realtimeMock.emit(waitingFrame({})));

    await waitFor(() => expect(result.current.worktrees[0].isWaitingForResponse).toBe(true));
    expect(result.current.worktrees[0].sessionStatusByCli?.claude?.isWaitingForResponse).toBe(false);
  });

  it('clears the worktree when the only waiting instance finishes', async () => {
    respondWith([
      {
        id: 'wt-1',
        name: 'a',
        path: '/a',
        repositoryPath: '/r',
        repositoryName: 'R',
        isWaitingForResponse: true,
        sessionStatusByInstance: {
          claude: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
        },
      },
    ]);
    const { result } = renderHook(() => useWorktreesCache());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() =>
      realtimeMock.emit(
        waitingFrame({ isWaitingForResponse: false, waitingKind: null, waitingSince: null }),
      ),
    );

    await waitFor(() => expect(result.current.worktrees[0].isWaitingForResponse).toBe(false));
  });

  it('keeps the worktree waiting while a SIBLING instance still is', async () => {
    respondWith([
      {
        id: 'wt-1',
        name: 'a',
        path: '/a',
        repositoryPath: '/r',
        repositoryName: 'R',
        isWaitingForResponse: true,
        sessionStatusByInstance: {
          claude: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
          'codex-2': { isRunning: true, isWaitingForResponse: true, isProcessing: false },
        },
      },
    ]);
    const { result } = renderHook(() => useWorktreesCache());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() =>
      realtimeMock.emit(
        waitingFrame({ isWaitingForResponse: false, waitingKind: null, waitingSince: null }),
      ),
    );

    await waitFor(() => {
      expect(
        result.current.worktrees[0].sessionStatusByInstance?.claude?.isWaitingForResponse,
      ).toBe(false);
    });
    expect(result.current.worktrees[0].isWaitingForResponse).toBe(true);
  });

  it('ignores a waiting frame for an unknown worktree', async () => {
    respondWith([{ id: 'wt-1', name: 'a', path: '/a', repositoryPath: '/r', repositoryName: 'R' }]);
    const { result } = renderHook(() => useWorktreesCache());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = result.current.worktrees;

    act(() => realtimeMock.emit(waitingFrame({ worktreeId: 'ghost' })));

    expect(result.current.worktrees).toBe(before);
  });
});

describe('useWorktreesCache: the running/stopped branch is unchanged (Issue #1788)', () => {
  it('still applies an unscoped running transition', async () => {
    respondWith([
      {
        id: 'wt-1',
        name: 'a',
        path: '/a',
        repositoryPath: '/r',
        repositoryName: 'R',
        isSessionRunning: false,
      },
    ]);
    const { result } = renderHook(() => useWorktreesCache());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() =>
      realtimeMock.emit({ type: 'session_status_changed', worktreeId: 'wt-1', isRunning: true }),
    );

    await waitFor(() => expect(result.current.worktrees[0].isSessionRunning).toBe(true));
  });

  it('still refetches on a scoped stop (Issue #1171)', async () => {
    respondWith([
      {
        id: 'wt-1',
        name: 'a',
        path: '/a',
        repositoryPath: '/r',
        repositoryName: 'R',
        isSessionRunning: true,
      },
    ]);
    const { result } = renderHook(() => useWorktreesCache());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = mockFetch.mock.calls.length;

    act(() =>
      realtimeMock.emit({
        type: 'session_status_changed',
        worktreeId: 'wt-1',
        isRunning: false,
        cliTool: 'claude',
        instance: 'claude',
      }),
    );

    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('useWorktreesCache: polling remains the fallback (Issue #1788 regression)', () => {
  it('a client with no WebSocket still learns about a wait, on the unchanged cadence', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    realtimeMock.setConnected(false);

    const idle: Worktree = {
      id: 'wt-1',
      name: 'a',
      path: '/a',
      repositoryPath: '/r',
      repositoryName: 'R',
      isSessionRunning: true,
      isWaitingForResponse: false,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ worktrees: [idle], repositories: [] }),
    });

    const { result } = renderHook(() => useWorktreesCache());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // No push ever arrives. The server flips to waiting; only the poll can say so.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        worktrees: [{ ...idle, isWaitingForResponse: true }],
        repositories: [],
      }),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_ACTIVE + 50);
    });

    await waitFor(() => expect(result.current.worktrees[0].isWaitingForResponse).toBe(true));
    expect(realtimeMock.listeners.length).toBeGreaterThan(0);
  });
});
