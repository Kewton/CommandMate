/**
 * Offline-aware chunk recovery (Issue #2500).
 *
 * #1404 read every `ChunkLoadError` as "the build changed underneath this tab"
 * and reloaded. A phone that walks out of Wi-Fi range throws the very same
 * error, so the reload discarded whatever the user was typing and announced a
 * version update that had not happened. These tests pin the distinction: while
 * the device is off the network nothing reloads, the guard timestamp is left
 * untouched for a real build swap later, and the wait ends by itself when the
 * server answers again.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  browserChunkRetryEnv,
  classifyChunkError,
  classifyChunkErrorInBrowser,
  isBrowserOnline,
  recoverFromChunkError,
  recoverFromChunkErrorInBrowser,
  retryWhenServerReturns,
  CHUNK_RELOAD_STORAGE_KEY,
  CHUNK_RELOAD_GUARD_MS,
  type ChunkRecoveryEnv,
  type ChunkRetryEnv,
} from '@/lib/error/chunk-reload';

function chunkError(): Error {
  const err = new Error('Loading chunk 7 failed.');
  err.name = 'ChunkLoadError';
  return err;
}

function dynamicImportError(): Error {
  return new Error('Failed to fetch dynamically imported module: /_next/static/chunks/x.js');
}

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

/** Override `navigator.onLine`, which jsdom defines as a non-writable getter. */
function setNavigatorOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  // Drop any `onLine` override so the next test starts from jsdom's default.
  delete (window.navigator as unknown as { onLine?: boolean }).onLine;
  window.sessionStorage.clear();
});

describe('classifyChunkError (Issue #2500)', () => {
  it('calls an offline chunk failure a network failure, not a build change', () => {
    expect(classifyChunkError(chunkError(), false)).toBe('network');
    expect(classifyChunkError(dynamicImportError(), false)).toBe('network');
  });

  it('keeps calling an online chunk failure a build change', () => {
    expect(classifyChunkError(chunkError(), true)).toBe('build');
    expect(classifyChunkError(dynamicImportError(), true)).toBe('build');
  });

  it('classifies a non-chunk error as none regardless of connectivity', () => {
    expect(classifyChunkError(new Error('boom'), true)).toBe('none');
    expect(classifyChunkError(new Error('boom'), false)).toBe('none');
    expect(classifyChunkError(null, false)).toBe('none');
  });

  it('reads navigator.onLine in the browser, trusting only `false`', () => {
    setNavigatorOnLine(false);
    expect(isBrowserOnline()).toBe(false);
    expect(classifyChunkErrorInBrowser(chunkError())).toBe('network');

    // A captive portal reports `true` while routing nowhere: `true` is not proof
    // of anything, so the verdict falls back to #1404's build assumption.
    setNavigatorOnLine(true);
    expect(isBrowserOnline()).toBe(true);
    expect(classifyChunkErrorInBrowser(chunkError())).toBe('build');
  });
});

describe('recoverFromChunkError — offline branch (Issue #2500)', () => {
  it('does NOT reload a ChunkLoadError raised while offline', () => {
    const reload = vi.fn();
    const { storage } = makeStorage();
    const env: ChunkRecoveryEnv = { storage, now: 1_000_000, reload, onLine: false };

    expect(recoverFromChunkError(chunkError(), env)).toBe('offline');
    expect(reload).not.toHaveBeenCalled();
  });

  it('leaves the guard timestamp untouched so a later build swap still self-heals', () => {
    const reload = vi.fn();
    const { storage, get } = makeStorage();

    // Offline incident: records nothing.
    expect(
      recoverFromChunkError(chunkError(), { storage, now: 1_000_000, reload, onLine: false })
    ).toBe('offline');
    expect(get()).toBeUndefined();

    // The network comes back and the build really has moved: #1404's single
    // guarded reload is still available, immediately.
    expect(
      recoverFromChunkError(chunkError(), { storage, now: 1_000_100, reload, onLine: true })
    ).toBe('reloaded');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(get()).toBe('1000100');
  });

  it('reports offline before consulting storage (no storage is not the reason)', () => {
    const reload = vi.fn();
    const env: ChunkRecoveryEnv = { storage: null, now: 1_000_000, reload, onLine: false };

    // With storage the online path would say 'guarded'; offline outranks it so
    // the caller can show connection copy rather than a manual reload button.
    expect(recoverFromChunkError(chunkError(), env)).toBe('offline');
    expect(reload).not.toHaveBeenCalled();
  });

  it('still reports offline inside the guard window', () => {
    const reload = vi.fn();
    const { storage } = makeStorage(String(1_000_000));
    const env: ChunkRecoveryEnv = {
      storage,
      now: 1_000_000 + CHUNK_RELOAD_GUARD_MS - 1,
      reload,
      onLine: false,
    };

    expect(recoverFromChunkError(chunkError(), env)).toBe('offline');
    expect(reload).not.toHaveBeenCalled();
  });

  it('leaves a non-chunk error skipped even while offline', () => {
    const reload = vi.fn();
    const { storage } = makeStorage();
    const env: ChunkRecoveryEnv = { storage, now: 1_000_000, reload, onLine: false };

    expect(recoverFromChunkError(new Error('boom'), env)).toBe('skipped');
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('recoverFromChunkErrorInBrowser (Issue #2500)', () => {
  it('returns "offline" and never reloads while navigator.onLine is false', () => {
    setNavigatorOnLine(false);
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      reload,
    } as unknown as Location);

    expect(recoverFromChunkErrorInBrowser(chunkError())).toBe('offline');
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)).toBeNull();
  });

  it('still self-heals once while online (Issue #1404 behaviour preserved)', () => {
    setNavigatorOnLine(true);
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      reload,
    } as unknown as Location);

    expect(recoverFromChunkErrorInBrowser(chunkError())).toBe('reloaded');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)).not.toBeNull();

    // Second incident inside the guard window: no reload loop.
    expect(recoverFromChunkErrorInBrowser(chunkError())).toBe('guarded');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('retryWhenServerReturns (Issue #2500)', () => {
  function makeRetryEnv(probeResult = true): {
    env: ChunkRetryEnv;
    fireOnline: () => void;
    reportReachable: (reachable: boolean) => void;
    probe: ReturnType<typeof vi.fn>;
    subscriberCount: () => number;
  } {
    const onlineHandlers = new Set<() => void>();
    const reachabilityHandlers = new Set<(reachable: boolean) => void>();
    const probe = vi.fn(async () => probeResult);

    return {
      env: {
        subscribeOnline: (handler) => {
          onlineHandlers.add(handler);
          return () => onlineHandlers.delete(handler);
        },
        subscribeReachability: (handler) => {
          reachabilityHandlers.add(handler);
          return () => reachabilityHandlers.delete(handler);
        },
        probe,
      },
      fireOnline: () => onlineHandlers.forEach((h) => h()),
      reportReachable: (reachable) => reachabilityHandlers.forEach((h) => h(reachable)),
      probe,
      subscriberCount: () => onlineHandlers.size + reachabilityHandlers.size,
    };
  }

  it('retries with no user action once an `online` event is confirmed by a probe', async () => {
    const retry = vi.fn();
    const { env, fireOnline, probe } = makeRetryEnv(true);

    retryWhenServerReturns(retry, env);
    expect(retry).not.toHaveBeenCalled();

    fireOnline();
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry when the `online` event is a lie the probe disproves', async () => {
    const retry = vi.fn();
    const { env, fireOnline, probe } = makeRetryEnv(false);

    retryWhenServerReturns(retry, env);
    fireOnline();

    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    expect(retry).not.toHaveBeenCalled();
  });

  it('retries immediately on a reachability report, without probing again', () => {
    const retry = vi.fn();
    const { env, reportReachable, probe } = makeRetryEnv();

    retryWhenServerReturns(retry, env);
    reportReachable(true);

    expect(retry).toHaveBeenCalledTimes(1);
    expect(probe).not.toHaveBeenCalled();
  });

  it('ignores a report that the server is still unreachable', () => {
    const retry = vi.fn();
    const { env, reportReachable } = makeRetryEnv();

    retryWhenServerReturns(retry, env);
    reportReachable(false);

    expect(retry).not.toHaveBeenCalled();
  });

  it('fires at most once and unsubscribes everything afterwards', () => {
    const retry = vi.fn();
    const { env, reportReachable, subscriberCount } = makeRetryEnv();

    retryWhenServerReturns(retry, env);
    expect(subscriberCount()).toBe(2);

    reportReachable(true);
    reportReachable(true);

    expect(retry).toHaveBeenCalledTimes(1);
    expect(subscriberCount()).toBe(0);
  });

  it('cancels cleanly, so a signal after unmount never retries', async () => {
    const retry = vi.fn();
    const { env, fireOnline, reportReachable, subscriberCount } = makeRetryEnv(true);

    const cancel = retryWhenServerReturns(retry, env);
    cancel();
    expect(subscriberCount()).toBe(0);

    fireOnline();
    reportReachable(true);

    await Promise.resolve();
    expect(retry).not.toHaveBeenCalled();
  });
});

describe('browserChunkRetryEnv (Issue #2500)', () => {
  it("wires the browser's `online` event and removes the listener on unsubscribe", () => {
    const reachability = vi.fn(() => () => {});
    const probe = vi.fn(async () => true);
    const env = browserChunkRetryEnv({ subscribeReachability: reachability, probe });

    const handler = vi.fn();
    const unsubscribe = env.subscribeOnline(handler);

    window.dispatchEvent(new Event('online'));
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    window.dispatchEvent(new Event('online'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('passes #2501 reachability primitives straight through', () => {
    const reachability = vi.fn(() => () => {});
    const probe = vi.fn(async () => true);
    const env = browserChunkRetryEnv({ subscribeReachability: reachability, probe });

    expect(env.subscribeReachability).toBe(reachability);
    expect(env.probe).toBe(probe);
  });
});
