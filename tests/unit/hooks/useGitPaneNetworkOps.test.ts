/**
 * Tests for useGitPaneNetworkOps hook (Issue #783, Phase 5/5).
 *
 * The hook owns the network I/O for the 3 git network operations (fetch / pull /
 * push), the 3-value progress state (idle/running/error), the in-flight
 * operation, the conflictFiles channel, a friendly error message, and abort().
 *
 * Responsibility boundary (DR1-006): the cascade is INJECTED via onCascade — the
 * hook does NOT own the GitPane fetch functions. After every settle
 * (success / error / abort / conflict) the hook calls onCascade(op) so the
 * caller re-syncs Status/Commits/Branches (DR1-009: abort means "result
 * unknown", so re-sync the real git state).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useGitPaneNetworkOps } from '@/hooks/useGitPaneNetworkOps';
import {
  PUSH_AUTH_FAILED_GUIDANCE,
  PUSH_PROTECTED_BRANCH_WARNING,
} from '@/config/git-status-config';

type MockFetchResponse = {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
};

const okJson = (data: unknown, status = 200): Promise<MockFetchResponse> =>
  Promise.resolve({ ok: true, status, json: async () => data });

const errJson = (data: unknown, status: number): Promise<MockFetchResponse> =>
  Promise.resolve({ ok: false, status, json: async () => data });

function getUrlString(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe('useGitPaneNetworkOps (Issue #783)', () => {
  let mockFetch: ReturnType<
    typeof vi.fn<
      (
        input: string | URL | Request,
        init?: RequestInit,
      ) => Promise<MockFetchResponse>
    >
  >;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in idle with no in-flight operation', () => {
    mockFetch.mockImplementation(() => okJson({ success: true }));
    const { result } = renderHook(() =>
      useGitPaneNetworkOps('w-1', { onCascade: vi.fn() }),
    );
    expect(result.current.progressState).toBe('idle');
    expect(result.current.operation).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.conflict).toBe(false);
    expect(result.current.conflictFiles).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // runFetch
  // --------------------------------------------------------------------------
  it('runFetch POSTs to /git/fetch with prune in the body and runs cascade', async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    mockFetch.mockImplementation((input, init) => {
      captured = { url: getUrlString(input), init };
      return okJson({ success: true });
    });
    const onCascade = vi.fn();
    const { result } = renderHook(() =>
      useGitPaneNetworkOps('w-9', { onCascade }),
    );

    await act(async () => {
      await result.current.runFetch({ prune: true });
    });

    expect(captured).not.toBeNull();
    const c = captured as unknown as { url: string; init: RequestInit };
    expect(c.url).toBe('/api/worktrees/w-9/git/fetch');
    expect(c.init.method).toBe('POST');
    expect(JSON.parse(c.init.body as string)).toEqual({ prune: true });
    expect(onCascade).toHaveBeenCalledWith('fetch');
    expect(result.current.progressState).toBe('idle');
  });

  it('forwards remote in the runFetch body when provided', async () => {
    let body: unknown = null;
    mockFetch.mockImplementation((_input, init) => {
      body = JSON.parse(init?.body as string);
      return okJson({ success: true });
    });
    const { result } = renderHook(() =>
      useGitPaneNetworkOps('w-1', { onCascade: vi.fn() }),
    );
    await act(async () => {
      await result.current.runFetch({ remote: 'upstream', prune: false });
    });
    expect(body).toEqual({ remote: 'upstream', prune: false });
  });

  // --------------------------------------------------------------------------
  // runPull
  // --------------------------------------------------------------------------
  it('runPull POSTs to /git/pull forwarding rebase + ffOnly and runs cascade', async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    mockFetch.mockImplementation((input, init) => {
      captured = { url: getUrlString(input), init };
      return okJson({ success: true });
    });
    const onCascade = vi.fn();
    const { result } = renderHook(() =>
      useGitPaneNetworkOps('w-2', { onCascade }),
    );

    await act(async () => {
      await result.current.runPull({ rebase: true, ffOnly: false });
    });

    const c = captured as unknown as { url: string; init: RequestInit };
    expect(c.url).toBe('/api/worktrees/w-2/git/pull');
    expect(c.init.method).toBe('POST');
    expect(JSON.parse(c.init.body as string)).toMatchObject({
      rebase: true,
      ffOnly: false,
    });
    expect(onCascade).toHaveBeenCalledWith('pull');
    expect(result.current.progressState).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('classifies a pull conflict (HTTP 200) as a quasi-error and exposes conflictFiles', async () => {
    mockFetch.mockImplementation(() =>
      okJson({ success: true, conflict: true, conflictFiles: ['a.ts', 'b.ts'] }),
    );
    const onCascade = vi.fn();
    const { result } = renderHook(() =>
      useGitPaneNetworkOps('w-1', { onCascade }),
    );

    await act(async () => {
      await result.current.runPull({});
    });

    expect(result.current.conflict).toBe(true);
    expect(result.current.conflictFiles).toEqual(['a.ts', 'b.ts']);
    // progressState returns to idle (HTTP 200), not 'error' (DR1-010).
    expect(result.current.progressState).toBe('idle');
    expect(onCascade).toHaveBeenCalledWith('pull');
  });

  // --------------------------------------------------------------------------
  // runPush
  // --------------------------------------------------------------------------
  it('runPush POSTs to /git/push forwarding force / forceWithLease / setUpstream', async () => {
    let body: unknown = null;
    let url = '';
    mockFetch.mockImplementation((input, init) => {
      url = getUrlString(input);
      body = JSON.parse(init?.body as string);
      return okJson({ success: true });
    });
    const onCascade = vi.fn();
    const { result } = renderHook(() =>
      useGitPaneNetworkOps('w-3', { onCascade }),
    );

    await act(async () => {
      await result.current.runPush({
        force: false,
        forceWithLease: true,
        setUpstream: true,
      });
    });

    expect(url).toBe('/api/worktrees/w-3/git/push');
    expect(body).toMatchObject({
      force: false,
      forceWithLease: true,
      setUpstream: true,
    });
    expect(onCascade).toHaveBeenCalledWith('push');
    expect(result.current.progressState).toBe('idle');
  });

  // --------------------------------------------------------------------------
  // progress state transitions
  // --------------------------------------------------------------------------
  it('transitions idle -> running -> idle around a push', async () => {
    let resolvePush: ((res: MockFetchResponse) => void) | undefined;
    const pending = new Promise<MockFetchResponse>((res) => {
      resolvePush = res;
    });
    mockFetch.mockImplementation(() => pending);

    const { result } = renderHook(() =>
      useGitPaneNetworkOps('w-1', { onCascade: vi.fn() }),
    );

    let runPromise: Promise<void> | undefined;
    act(() => {
      runPromise = result.current.runPush({});
    });

    await waitFor(() => expect(result.current.progressState).toBe('running'));
    expect(result.current.operation).toBe('push');

    await act(async () => {
      resolvePush?.({ ok: true, status: 200, json: async () => ({ success: true }) });
      await runPromise;
    });

    expect(result.current.progressState).toBe('idle');
    expect(result.current.operation).toBeNull();
  });

  // --------------------------------------------------------------------------
  // error mapping by reason
  // --------------------------------------------------------------------------
  it('surfaces the auth_failed guidance when push fails with reason auth_failed', async () => {
    mockFetch.mockImplementation(() =>
      errJson({ error: 'Authentication failed', reason: 'auth_failed' }, 401),
    );
    const { result } = renderHook(() =>
      useGitPaneNetworkOps('w-1', { onCascade: vi.fn() }),
    );

    await act(async () => {
      await result.current.runPush({});
    });

    expect(result.current.progressState).toBe('error');
    expect(result.current.error).toBe(PUSH_AUTH_FAILED_GUIDANCE);
  });

  it('surfaces the protected-branch warning when push fails with reason protected_branch', async () => {
    mockFetch.mockImplementation(() =>
      errJson(
        { error: 'Force push to the default branch is not allowed', reason: 'protected_branch' },
        409,
      ),
    );
    const { result } = renderHook(() =>
      useGitPaneNetworkOps('w-1', { onCascade: vi.fn() }),
    );

    await act(async () => {
      await result.current.runPush({ forceWithLease: true });
    });

    expect(result.current.progressState).toBe('error');
    expect(result.current.error).toBe(PUSH_PROTECTED_BRANCH_WARNING);
  });

  it('falls back to the server error string for other reasons', async () => {
    mockFetch.mockImplementation(() =>
      errJson(
        { error: 'Push rejected (non-fast-forward); pull/rebase first', reason: 'non_fast_forward' },
        409,
      ),
    );
    const { result } = renderHook(() =>
      useGitPaneNetworkOps('w-1', { onCascade: vi.fn() }),
    );

    await act(async () => {
      await result.current.runPush({});
    });

    expect(result.current.progressState).toBe('error');
    expect(result.current.error).toBe('Push rejected (non-fast-forward); pull/rebase first');
  });

  it('still runs cascade after an error (re-sync real git state)', async () => {
    mockFetch.mockImplementation(() =>
      errJson({ error: 'Could not reach the remote', reason: 'network' }, 502),
    );
    const onCascade = vi.fn();
    const { result } = renderHook(() =>
      useGitPaneNetworkOps('w-1', { onCascade }),
    );

    await act(async () => {
      await result.current.runFetch({});
    });

    expect(result.current.progressState).toBe('error');
    expect(onCascade).toHaveBeenCalledWith('fetch');
  });

  // --------------------------------------------------------------------------
  // abort
  // --------------------------------------------------------------------------
  it('abort() aborts the in-flight request and still calls onCascade (DR1-009)', async () => {
    let capturedSignal: AbortSignal | undefined;
    mockFetch.mockImplementation((_input, init) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<MockFetchResponse>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    const onCascade = vi.fn();
    const { result } = renderHook(() =>
      useGitPaneNetworkOps('w-1', { onCascade }),
    );

    let runPromise: Promise<void> | undefined;
    act(() => {
      runPromise = result.current.runPush({});
    });
    await waitFor(() => expect(result.current.progressState).toBe('running'));

    await act(async () => {
      result.current.abort();
      await runPromise;
    });

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(onCascade).toHaveBeenCalledWith('push');
    // Abort returns to idle ("result unknown"), not stuck on running.
    expect(result.current.progressState).toBe('idle');
    expect(result.current.operation).toBeNull();
  });

  it('clears a previous error and conflict when a new op starts', async () => {
    // First op fails.
    mockFetch.mockImplementationOnce(() =>
      errJson({ error: 'Authentication failed', reason: 'auth_failed' }, 401),
    );
    const { result } = renderHook(() =>
      useGitPaneNetworkOps('w-1', { onCascade: vi.fn() }),
    );
    await act(async () => {
      await result.current.runPush({});
    });
    expect(result.current.progressState).toBe('error');

    // Second op succeeds -> error cleared.
    mockFetch.mockImplementation(() => okJson({ success: true }));
    await act(async () => {
      await result.current.runFetch({});
    });
    expect(result.current.progressState).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(result.current.conflict).toBe(false);
  });
});
