/**
 * Tests for useDangerZone (Issue #782, extracted in #922).
 *
 * Owns the reset / revert mutations. Holds no read state; both ops move HEAD so
 * their success runs the injected `onHeadMoved` cascade. A revert that returns
 * { conflict } surfaces a conflict notice.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDangerZone } from '@/hooks/useDangerZone';

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

describe('useDangerZone (Issue #782)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let onHeadMoved: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    mockFetch = vi.fn(() => okJson({ success: true }));
    global.fetch = mockFetch as unknown as typeof fetch;
    onHeadMoved = vi.fn(() => Promise.resolve());
  });
  afterEach(() => vi.restoreAllMocks());

  const setup = () => renderHook(() => useDangerZone('w-1', { onHeadMoved }));

  it('reset POSTs the target/mode and runs onHeadMoved on success', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleReset('abc123', 'hard', 'main');
    });
    const call = mockFetch.mock.calls.find((c) => urlOf(c[0]).includes('/git/reset'));
    expect(JSON.parse(call![1].body)).toEqual({ target: 'abc123', mode: 'hard', confirmBranch: 'main' });
    expect(onHeadMoved).toHaveBeenCalledTimes(1);
    expect(result.current.dangerActionError).toBeNull();
  });

  it('reset surfaces the API error and does NOT run onHeadMoved on failure', async () => {
    mockFetch.mockImplementation((input: string | URL | Request) =>
      urlOf(input).includes('/git/reset') ? errJson({ error: 'protected' }, 403) : okJson({ success: true })
    );
    const { result } = setup();
    await act(async () => {
      await result.current.handleReset('abc123', 'hard', undefined);
    });
    expect(result.current.dangerActionError).toBe('protected');
    expect(onHeadMoved).not.toHaveBeenCalled();
  });

  it('revert surfaces a conflict notice when the API reports a conflict', async () => {
    mockFetch.mockImplementation((input: string | URL | Request) =>
      urlOf(input).includes('/git/revert')
        ? okJson({ conflict: true, conflictFiles: ['b.ts'] })
        : okJson({ success: true })
    );
    const { result } = setup();
    await act(async () => {
      await result.current.handleRevert('def456', false);
    });
    expect(result.current.dangerConflictNotice).toContain('b.ts');
    expect(onHeadMoved).toHaveBeenCalledTimes(1);
  });
});
