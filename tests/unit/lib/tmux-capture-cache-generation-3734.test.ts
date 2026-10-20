/**
 * Issue #3734: a capture that started before invalidateCache()/clearAllCache()
 * must not be written back, must not be joined by callers that arrive after the
 * invalidation, and must not delete a newer inflight entry in its finally.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCachedCapture,
  invalidateCache,
  clearAllCache,
  resetCacheForTesting,
  getOrFetchCapture,
} from '@/lib/tmux/tmux-capture-cache';

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const SESSION = 'mcbd-claude-wt-3734';

describe('tmux-capture-cache generation (Issue #3734)', () => {
  beforeEach(() => {
    resetCacheForTesting();
  });

  afterEach(() => {
    resetCacheForTesting();
  });

  it('does not write back a fetch that was invalidated while in flight', async () => {
    const d = deferred<string>();
    const fetchFn = vi.fn(() => d.promise);

    const p = getOrFetchCapture(SESSION, 100, fetchFn);
    invalidateCache(SESSION);
    d.resolve('screen before send');

    // The caller that started the fetch still receives its own result.
    await expect(p).resolves.toBe('screen before send');
    expect(getCachedCapture(SESSION, 100)).toBeNull();
  });

  it('a caller arriving after invalidation starts a new fetch and gets the new screen', async () => {
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const fetchFn = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise);

    const p1 = getOrFetchCapture(SESSION, 100, fetchFn);
    invalidateCache(SESSION);
    const p2 = getOrFetchCapture(SESSION, 100, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(2);

    d1.resolve('old screen');
    d2.resolve('new screen');

    await expect(p1).resolves.toBe('old screen');
    await expect(p2).resolves.toBe('new screen');
    expect(getCachedCapture(SESSION, 100)).toBe('new screen');
  });

  it('keeps the old fetch from writing back even when it resolves after the new one', async () => {
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const fetchFn = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise);

    const p1 = getOrFetchCapture(SESSION, 100, fetchFn);
    invalidateCache(SESSION);
    const p2 = getOrFetchCapture(SESSION, 100, fetchFn);

    d2.resolve('new screen');
    await p2;
    d1.resolve('old screen');
    await p1;

    expect(getCachedCapture(SESSION, 100)).toBe('new screen');
  });

  it('after clearAllCache, the old fetch does not remove the newer inflight entry', async () => {
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const fetchFn = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise);

    const p1 = getOrFetchCapture(SESSION, 100, fetchFn);
    clearAllCache();
    const p2 = getOrFetchCapture(SESSION, 100, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    d1.resolve('old screen');
    await expect(p1).resolves.toBe('old screen');
    expect(getCachedCapture(SESSION, 100)).toBeNull();

    // A caller arriving now joins F2 instead of starting a third fetch.
    const p3 = getOrFetchCapture(SESSION, 100, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    d2.resolve('new screen');
    await expect(p2).resolves.toBe('new screen');
    await expect(p3).resolves.toBe('new screen');
    expect(getCachedCapture(SESSION, 100)).toBe('new screen');
  });

  it('invalidating another session does not affect this session\'s fetch', async () => {
    const d = deferred<string>();
    const fetchFn = vi.fn(() => d.promise);

    const p = getOrFetchCapture(SESSION, 100, fetchFn);
    invalidateCache('mcbd-codex-wt-other');
    const joined = getOrFetchCapture(SESSION, 100, fetchFn);
    d.resolve('screen');

    await expect(p).resolves.toBe('screen');
    await expect(joined).resolves.toBe('screen');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(getCachedCapture(SESSION, 100)).toBe('screen');
  });

  it('negative control: without invalidation concurrent callers share one fetch and the result is cached', async () => {
    const d = deferred<string>();
    const fetchFn = vi.fn(() => d.promise);

    const p1 = getOrFetchCapture(SESSION, 100, fetchFn);
    const p2 = getOrFetchCapture(SESSION, 100, fetchFn);
    d.resolve('screen');

    await expect(p1).resolves.toBe('screen');
    await expect(p2).resolves.toBe('screen');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(getCachedCapture(SESSION, 100)).toBe('screen');
  });
});
