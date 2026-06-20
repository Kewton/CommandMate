/**
 * Tests for useStash (Issue #782, extracted in #922).
 *
 * Owns the Stash list + push / pop / apply / drop. Key contracts: fetch on mount;
 * every mutation runs the injected `onStashMutated` (status + changes) alongside
 * its own stash refetch; a pop/apply that returns { conflict } (HTTP 200) surfaces
 * a conflict notice rather than failing.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useStash } from '@/hooks/useStash';

type MockFetchResponse = { ok: boolean; status?: number; json: () => Promise<unknown> };

const okJson = (data: unknown): Promise<MockFetchResponse> =>
  Promise.resolve({ ok: true, status: 200, json: async () => data });
const errJson = (data: unknown, status: number): Promise<MockFetchResponse> =>
  Promise.resolve({ ok: false, status, json: async () => data });

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe('useStash (Issue #782)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let onStashMutated: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    mockFetch = vi.fn((input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes('/git/stash')) return okJson({ stashes: [] });
      return okJson({ success: true });
    });
    global.fetch = mockFetch as unknown as typeof fetch;
    onStashMutated = vi.fn(() => Promise.resolve());
  });
  afterEach(() => vi.restoreAllMocks());

  const setup = () => renderHook(() => useStash('w-1', { onStashMutated }));

  it('fetches the stash list on mount', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.stashLoading).toBe(false));
    expect(mockFetch.mock.calls.some((c) => urlOf(c[0]).endsWith('/git/stash'))).toBe(true);
  });

  it('push runs the stash-mutation cascade (onStashMutated + refetch)', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.stashLoading).toBe(false));

    await act(async () => {
      result.current.handleStashPush('wip', true);
    });
    await waitFor(() => expect(onStashMutated).toHaveBeenCalledTimes(1));
    const pushCall = mockFetch.mock.calls.find((c) => urlOf(c[0]).includes('/git/stash/push'));
    expect(JSON.parse(pushCall![1].body)).toEqual({ message: 'wip', includeUntracked: true });
  });

  it('surfaces a conflict notice when pop returns { conflict } at HTTP 200', async () => {
    mockFetch.mockImplementation((input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes('/git/stash/pop')) {
        return okJson({ conflict: true, conflictFiles: ['a.ts'], stashRetained: true });
      }
      if (url.includes('/git/stash')) return okJson({ stashes: [] });
      return okJson({ success: true });
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.stashLoading).toBe(false));

    await act(async () => {
      result.current.handleStashPop(0);
    });
    await waitFor(() => expect(result.current.stashConflictNotice).toBeTruthy());
    expect(result.current.stashConflictNotice).toContain('a.ts');
    expect(result.current.stashConflictNotice).toContain('stash retained');
  });

  it('surfaces the API error on a failed drop', async () => {
    mockFetch.mockImplementation((input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.match(/\/git\/stash\/\d+$/)) return errJson({ error: 'no such stash' }, 404);
      if (url.includes('/git/stash')) return okJson({ stashes: [] });
      return okJson({ success: true });
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.stashLoading).toBe(false));

    await act(async () => {
      result.current.handleStashDrop(3);
    });
    await waitFor(() => expect(result.current.stashActionError).toBe('no such stash'));
  });
});
