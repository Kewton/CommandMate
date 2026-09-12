/**
 * ChunkLoadError classification + guarded self-recovery (Issue #1404, #2500).
 *
 * When the server is upgraded from the GUI, tabs opened against the previous
 * build request old-hash JS chunks / RSC payloads that the new server no longer
 * serves, producing a `ChunkLoadError`. Without an App Router error boundary
 * this surfaces as an unhandled "Application error: a client-side exception".
 *
 * The boundaries (`app/error.tsx`, `app/global-error.tsx`) call into this module
 * so a stale tab reloads *once* to fetch the current build, while a guard
 * prevents an infinite reload loop when a reload does not resolve the error.
 *
 * ## Two failures wear the same name (Issue #2500)
 *
 * A lazy `import()` that never arrives throws the *same* `ChunkLoadError`
 * whether the bundle is gone from the server or the phone simply walked out of
 * Wi-Fi range. #1404 read every one of them as "the build changed" and reloaded,
 * which on a flaky mobile connection threw away whatever the user was typing and
 * told them a new version was available — both wrong. So the error alone is no
 * longer sufficient evidence: the recovery also needs to know whether the device
 * is on a network at all.
 *
 * The rule is the same asymmetry `useConnectivity` (#2501) is built on:
 * **`navigator.onLine === false` is proof of being offline; `=== true` proves
 * nothing.** A captive portal reports `true` while routing nowhere. So `false`
 * downgrades the incident to `'network'` and suppresses the reload, while `true`
 * only means "no reason to think otherwise" and lets the #1404 behaviour stand.
 *
 * The real version-drift signal is the WebSocket handshake, surfaced by
 * `VersionMismatchBanner` — this module is the fallback for tabs that hit a dead
 * chunk before that handshake ever gets a chance to fire.
 *
 * Everything here takes its environment by injection (`ChunkRecoveryEnv`,
 * `ChunkRetryEnv`) and imports no React, so the decisions are testable without a
 * DOM and usable from outside a component tree.
 */

/** sessionStorage key holding the epoch-ms timestamp of the last recovery reload. */
export const CHUNK_RELOAD_STORAGE_KEY = 'cm:chunk-reload-at';

/**
 * If a chunk error recurs within this window after an automatic reload, the
 * reload did not fix it (e.g. a genuinely missing chunk), so we stop reloading
 * and fall back to the manual UI. A chunk error that arrives after the window
 * has elapsed is treated as a fresh incident (a later deploy) and is allowed to
 * self-heal again.
 */
export const CHUNK_RELOAD_GUARD_MS = 30_000;

/**
 * Detect a chunk/module load failure.
 *
 * Matches `error.name === 'ChunkLoadError'` (webpack) or an error message
 * containing `Loading chunk` / `Failed to fetch dynamically imported module`.
 *
 * This is the *syntactic* half only — it says the load failed, not why. Use
 * {@link classifyChunkError} to separate a stale build from a dead network.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;

  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'ChunkLoadError') return true;

  if (typeof message === 'string') {
    return (
      message.includes('Loading chunk') ||
      message.includes('Failed to fetch dynamically imported module')
    );
  }
  return false;
}

/**
 * Why a chunk failed to load.
 *
 * - `'none'`    — not a chunk load failure at all.
 * - `'network'` — the device is off the network; the bundle is presumably fine
 *                 and will load again once the connection returns. Never reload.
 * - `'build'`   — nothing says the network is down, so treat it as #1404's stale
 *                 build and let the guarded reload fetch the current one.
 */
export type ChunkErrorCause = 'none' | 'network' | 'build';

/**
 * Classify a chunk load failure.
 *
 * @param onLine whether the device believes it is on a network. Pass
 * `navigator.onLine !== false` (see {@link isBrowserOnline}); only `false`
 * changes the verdict, because only `false` is trustworthy.
 */
export function classifyChunkError(error: unknown, onLine: boolean): ChunkErrorCause {
  if (!isChunkLoadError(error)) return 'none';
  return onLine ? 'build' : 'network';
}

/**
 * `navigator.onLine`, defaulting to "online" wherever the flag is unavailable
 * (SSR, non-browser runtimes) so a missing signal never suppresses #1404's
 * self-healing reload.
 */
export function isBrowserOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

/** Browser-wired {@link classifyChunkError}, reading `navigator.onLine`. */
export function classifyChunkErrorInBrowser(error: unknown): ChunkErrorCause {
  return classifyChunkError(error, isBrowserOnline());
}

export type ChunkReloadOutcome = 'reloaded' | 'guarded' | 'skipped' | 'offline';

export interface ChunkRecoveryEnv {
  /** sessionStorage-like store, or `null` when unavailable (private mode / SSR). */
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Current time in epoch ms (injected for deterministic testing). */
  now: number;
  /** Triggers the page reload. */
  reload: () => void;
  /**
   * Whether the device believes it is on a network (`navigator.onLine !== false`).
   * Required rather than defaulted: a caller that cannot answer this must say so
   * deliberately, because guessing wrong reloads the page under a user's hands.
   */
  onLine: boolean;
}

/**
 * Reload once to recover from a `ChunkLoadError`, guarding against reload loops.
 *
 * - `'skipped'`  — not a ChunkLoadError; the caller shows its normal error UI.
 * - `'offline'`  — the device is off the network (Issue #2500). Nothing is
 *                  reloaded and the guard timestamp is left untouched, so the
 *                  one self-heal stays available for a real build swap later.
 *                  The caller shows connection copy and waits for the network.
 * - `'reloaded'` — a page reload was triggered.
 * - `'guarded'`  — a recent reload already happened (or storage is unavailable),
 *                  so no reload is triggered and the caller shows a manual UI.
 */
export function recoverFromChunkError(
  error: unknown,
  env: ChunkRecoveryEnv
): ChunkReloadOutcome {
  const cause = classifyChunkError(error, env.onLine);
  if (cause === 'none') return 'skipped';
  // Offline: the chunk is not missing, the network is. Reloading here would
  // fetch nothing and discard the user's in-progress input for no gain.
  if (cause === 'network') return 'offline';

  const { storage, now, reload } = env;

  // Without storage we cannot detect a loop, so we must not auto-reload.
  if (!storage) return 'guarded';

  const previous = Number(storage.getItem(CHUNK_RELOAD_STORAGE_KEY));
  if (Number.isFinite(previous) && previous > 0 && now - previous < CHUNK_RELOAD_GUARD_MS) {
    return 'guarded';
  }

  storage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(now));
  reload();
  return 'reloaded';
}

/**
 * Browser-wired {@link recoverFromChunkError}. Tolerates blocked/absent
 * sessionStorage (Safari private mode throws on access) and no-ops on the server.
 */
export function recoverFromChunkErrorInBrowser(error: unknown): ChunkReloadOutcome {
  if (typeof window === 'undefined') return 'skipped';

  let storage: Storage | null = null;
  try {
    storage = window.sessionStorage;
    // Probe: some browsers expose the object but throw on write (private mode).
    const probe = '__cm_chunk_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
  } catch {
    storage = null;
  }

  return recoverFromChunkError(error, {
    storage,
    now: Date.now(),
    reload: () => window.location.reload(),
    onLine: isBrowserOnline(),
  });
}

// ============================================================================
// Waiting for the network to come back (Issue #2500)
// ============================================================================

/**
 * The signals a suppressed (`'offline'`) recovery waits on before retrying.
 *
 * Deliberately three injected functions rather than a `useConnectivity()` call:
 * an error boundary may be the only thing left rendering, so the retry must not
 * depend on a provider, a hook, or a React tree being intact.
 */
export interface ChunkRetryEnv {
  /** Subscribe to the device rejoining a network. Returns an unsubscribe fn. */
  subscribeOnline: (handler: () => void) => () => void;
  /**
   * Subscribe to reachability reported by the app's ordinary API calls —
   * `subscribeServerReachability` from `@/hooks/useConnectivity` (#2501).
   * Returns an unsubscribe fn.
   */
  subscribeReachability: (handler: (reachable: boolean) => void) => () => void;
  /**
   * Ask the server whether it answers — `probeServerReachable` from
   * `@/hooks/useConnectivity` (#2501).
   */
  probe: () => Promise<boolean>;
}

/**
 * Retry automatically once the server is reachable again, with no user action.
 *
 * An `online` event is only the browser's opinion, and #2501 spells out why it
 * cannot be believed on its own, so it triggers a probe rather than the retry
 * itself. A reachability report from a real API call is first-hand evidence and
 * retries immediately. `retry` fires at most once; the returned function cancels
 * the wait (call it from an effect cleanup).
 */
export function retryWhenServerReturns(retry: () => void, env: ChunkRetryEnv): () => void {
  let settled = false;
  let unsubscribeOnline: (() => void) | null = null;
  let unsubscribeReachability: (() => void) | null = null;

  const stop = (): void => {
    unsubscribeOnline?.();
    unsubscribeReachability?.();
    unsubscribeOnline = null;
    unsubscribeReachability = null;
  };

  const succeed = (): void => {
    if (settled) return;
    settled = true;
    // Unsubscribe before retrying: the retry re-renders the boundary, and a
    // second signal arriving mid-render must not fire it again.
    stop();
    retry();
  };

  const confirmThenRetry = (): void => {
    if (settled) return;
    void env.probe().then((reachable) => {
      if (reachable) succeed();
    });
  };

  unsubscribeOnline = env.subscribeOnline(confirmThenRetry);
  unsubscribeReachability = env.subscribeReachability((reachable) => {
    if (reachable) succeed();
  });

  return () => {
    settled = true;
    stop();
  };
}

/**
 * Build a {@link ChunkRetryEnv} whose `online` signal comes from `window`,
 * pairing it with #2501's reachability primitives supplied by the caller.
 *
 * The caller passes those in rather than this module importing them so that
 * `src/lib` keeps its independence from `src/hooks` and this file stays loadable
 * without React.
 */
export function browserChunkRetryEnv(deps: {
  subscribeReachability: ChunkRetryEnv['subscribeReachability'];
  probe: ChunkRetryEnv['probe'];
}): ChunkRetryEnv {
  return {
    subscribeOnline: (handler) => {
      if (typeof window === 'undefined') return () => {};
      window.addEventListener('online', handler);
      return () => window.removeEventListener('online', handler);
    },
    subscribeReachability: deps.subscribeReachability,
    probe: deps.probe,
  };
}
