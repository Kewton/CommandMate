/**
 * Tests for useGitStatus (Issue #779, extracted in #922).
 *
 * Owns the GitPane "Current Status" snapshot: branch / dirty / ahead-behind.
 * Self-fetches on mount; `fetchStatus` is re-exposed for sibling cascades. The
 * 5s poll lives at the coordinator, NOT here, so this hook fetches exactly once
 * on mount.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useGitStatus } from '@/hooks/useGitStatus';

type MockFetchResponse = { ok: boolean; status?: number; json: () => Promise<unknown> };

const okJson = (data: unknown): Promise<MockFetchResponse> =>
  Promise.resolve({ ok: true, status: 200, json: async () => data });
const errJson = (data: unknown, status: number): Promise<MockFetchResponse> =>
  Promise.resolve({ ok: false, status, json: async () => data });

describe('useGitStatus (Issue #779)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  it('fetches current status from /git/status on mount', async () => {
    mockFetch.mockImplementation(() => okJson({ currentBranch: 'main', aheadBehind: { ahead: 0, behind: 0 } }));
    const { result } = renderHook(() => useGitStatus('w-1'));

    expect(result.current.statusLoading).toBe(true);
    await waitFor(() => expect(result.current.statusLoading).toBe(false));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('/api/worktrees/w-1/git/status');
    expect(result.current.gitStatus).toEqual({ currentBranch: 'main', aheadBehind: { ahead: 0, behind: 0 } });
    expect(result.current.statusError).toBeNull();
  });

  it('surfaces the API error message on a non-ok response', async () => {
    mockFetch.mockImplementation(() => errJson({ error: 'boom' }, 500));
    const { result } = renderHook(() => useGitStatus('w-1'));

    await waitFor(() => expect(result.current.statusLoading).toBe(false));
    expect(result.current.statusError).toBe('boom');
    expect(result.current.gitStatus).toBeNull();
  });

  it('falls back to a generic message when fetch throws', async () => {
    mockFetch.mockImplementation(() => Promise.reject(new Error('network')));
    const { result } = renderHook(() => useGitStatus('w-1'));

    await waitFor(() => expect(result.current.statusLoading).toBe(false));
    expect(result.current.statusError).toBe('Failed to fetch git status');
  });

  it('re-fetches on demand via fetchStatus()', async () => {
    mockFetch.mockImplementation(() => okJson({ currentBranch: 'main' }));
    const { result } = renderHook(() => useGitStatus('w-1'));
    await waitFor(() => expect(result.current.statusLoading).toBe(false));

    await act(async () => {
      await result.current.fetchStatus();
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
