/**
 * Tests for ChunkLoadError detection + guarded self-recovery (Issue #1404).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isChunkLoadError,
  recoverFromChunkError,
  CHUNK_RELOAD_STORAGE_KEY,
  CHUNK_RELOAD_GUARD_MS,
  type ChunkRecoveryEnv,
} from '@/lib/error/chunk-reload';

function makeStorage(initial?: string): {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  get: () => string | undefined;
} {
  let value = initial;
  return {
    storage: {
      getItem: (key: string) => (key === CHUNK_RELOAD_STORAGE_KEY ? value ?? null : null),
      setItem: (key: string, next: string) => {
        if (key === CHUNK_RELOAD_STORAGE_KEY) value = next;
      },
    },
    get: () => value,
  };
}

describe('isChunkLoadError (Issue #1404)', () => {
  it('matches a webpack ChunkLoadError by name', () => {
    const err = new Error('boom');
    err.name = 'ChunkLoadError';
    expect(isChunkLoadError(err)).toBe(true);
  });

  it('matches "Loading chunk" messages', () => {
    expect(isChunkLoadError(new Error('Loading chunk 42 failed.'))).toBe(true);
  });

  it('matches dynamic import failures', () => {
    expect(
      isChunkLoadError(new Error('Failed to fetch dynamically imported module: /_next/x.js'))
    ).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isChunkLoadError(new Error('TypeError: undefined is not a function'))).toBe(false);
    expect(isChunkLoadError(new TypeError('nope'))).toBe(false);
  });

  it('is null/undefined/non-object safe', () => {
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError('Loading chunk 3 failed')).toBe(false);
  });
});

describe('recoverFromChunkError (Issue #1404)', () => {
  function chunkError(): Error {
    const err = new Error('Loading chunk 7 failed.');
    err.name = 'ChunkLoadError';
    return err;
  }

  it('reloads once and records the timestamp for a fresh ChunkLoadError', () => {
    const reload = vi.fn();
    const { storage, get } = makeStorage();
    const env: ChunkRecoveryEnv = { storage, now: 1_000_000, reload };

    const outcome = recoverFromChunkError(chunkError(), env);

    expect(outcome).toBe('reloaded');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(get()).toBe('1000000');
  });

  it('does NOT reload again while the guard window is still open', () => {
    const reload = vi.fn();
    const { storage } = makeStorage(String(1_000_000));
    const env: ChunkRecoveryEnv = {
      storage,
      now: 1_000_000 + CHUNK_RELOAD_GUARD_MS - 1,
      reload,
    };

    const outcome = recoverFromChunkError(chunkError(), env);

    expect(outcome).toBe('guarded');
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads again once the guard window has elapsed (later deploy self-heals)', () => {
    const reload = vi.fn();
    const { storage, get } = makeStorage(String(1_000_000));
    const now = 1_000_000 + CHUNK_RELOAD_GUARD_MS + 1;
    const env: ChunkRecoveryEnv = { storage, now, reload };

    const outcome = recoverFromChunkError(chunkError(), env);

    expect(outcome).toBe('reloaded');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(get()).toBe(String(now));
  });

  it('does NOT auto-reload for a non-ChunkLoadError', () => {
    const reload = vi.fn();
    const { storage, get } = makeStorage();
    const env: ChunkRecoveryEnv = { storage, now: 1_000_000, reload };

    const outcome = recoverFromChunkError(new Error('unrelated failure'), env);

    expect(outcome).toBe('skipped');
    expect(reload).not.toHaveBeenCalled();
    expect(get()).toBeUndefined();
  });

  it('does NOT reload when storage is unavailable (cannot guard against a loop)', () => {
    const reload = vi.fn();
    const env: ChunkRecoveryEnv = { storage: null, now: 1_000_000, reload };

    const outcome = recoverFromChunkError(chunkError(), env);

    expect(outcome).toBe('guarded');
    expect(reload).not.toHaveBeenCalled();
  });
});
