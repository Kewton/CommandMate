/**
 * A file poll whose body stalls must not cost the update it was fetching
 * (Issue #4034).
 *
 * The poll remembers `Last-Modified` for its next `If-Modified-Since`. Now that a
 * stalled body fails instead of hanging, remembering it before the body has
 * arrived would make the next tick answer 304 for content this screen never got.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFileContentPolling } from '@/hooks/useFileContentPolling';
import { API_POLL_TIMEOUT_MS } from '@/config/api-timeout-config';
import { __resetApiReachabilityReporting } from '@/lib/api-client';
import type { FileTab } from '@/hooks/useFileTabs';
import type { FileContent } from '@/types/models';

const polling: { onPoll: (() => Promise<void>) | null } = { onPoll: null };
vi.mock('@/hooks/useFilePolling', () => ({
  useFilePolling: (options: { onPoll: () => Promise<void> }) => {
    polling.onPoll = options.onPoll;
  },
}));

const mockFetch = vi.fn();
const LAST_MODIFIED = 'Mon, 02 Nov 2026 00:00:00 GMT';
const headers = { 'content-type': 'application/json', 'last-modified': LAST_MODIFIED };
const content: FileContent = { path: 'a.ts', content: 'new', extension: 'ts', worktreePath: '/repo' };
const tab: FileTab = {
  path: 'a.ts',
  name: 'a.ts',
  content: { ...content, content: 'old' },
  loading: false,
  error: null,
  isDirty: false,
};

function stalledBody(): Response {
  return new Response(new ReadableStream<Uint8Array>(), { status: 200, headers });
}

function sentIfModifiedSince(call: number): string | undefined {
  const init = mockFetch.mock.calls[call][1] as RequestInit;
  return (init.headers as Record<string, string>)['If-Modified-Since'];
}

beforeEach(() => {
  vi.useFakeTimers();
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
  __resetApiReachabilityReporting();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('[#4034] useFileContentPolling — a stalled body', () => {
  it('settles at the poll budget and the next tick still fetches the content', async () => {
    const onLoadContent = vi.fn();
    renderHook(() => useFileContentPolling({ tab, worktreeId: 'wt', onLoadContent }));

    mockFetch.mockResolvedValueOnce(stalledBody());
    let settled = false;
    void polling.onPoll!().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(API_POLL_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(onLoadContent).not.toHaveBeenCalled();

    // The content was never delivered, so this tick must not ask "changed since?".
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(content), { status: 200, headers }));
    const next = polling.onPoll!();
    await vi.advanceTimersByTimeAsync(0);
    await next;

    expect(sentIfModifiedSince(1)).toBeUndefined();
    expect(onLoadContent).toHaveBeenCalledWith('a.ts', content);

    // And once it has been delivered, the conditional request is back.
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await polling.onPoll!();
    expect(sentIfModifiedSince(2)).toBe(LAST_MODIFIED);
  });
});
