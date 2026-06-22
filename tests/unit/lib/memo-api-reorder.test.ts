/**
 * Unit tests for memoApi.reorder (Issue #944)
 *
 * Verifies the client sends a PATCH to /api/worktrees/:id/memos with the
 * { memoIds } body and surfaces server errors through the shared fetch wrapper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('memoApi.reorder (Issue #944)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      redirected: false,
      url: '/api/worktrees/wt-1/memos',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: vi.fn().mockResolvedValue(body),
    } as unknown as Response;
  }

  it('sends PATCH with { memoIds } body to the collection endpoint', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));

    const { memoApi } = await import('@/lib/api-client');
    await memoApi.reorder('wt-1', ['c', 'a', 'b']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/worktrees/wt-1/memos');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body as string)).toEqual({ memoIds: ['c', 'a', 'b'] });
  });

  it('resolves to void on success', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));

    const { memoApi } = await import('@/lib/api-client');
    await expect(memoApi.reorder('wt-1', ['a'])).resolves.toBeUndefined();
  });

  it('throws an ApiError when the server returns an error status', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Invalid memo IDs' }, 400));

    const { memoApi } = await import('@/lib/api-client');
    await expect(memoApi.reorder('wt-1', ['a'])).rejects.toThrow('Invalid memo IDs');
  });
});
