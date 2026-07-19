/**
 * ChunkLoadError detection + guarded self-recovery (Issue #1404).
 *
 * When the server is upgraded from the GUI, tabs opened against the previous
 * build request old-hash JS chunks / RSC payloads that the new server no longer
 * serves, producing a `ChunkLoadError`. Without an App Router error boundary
 * this surfaces as an unhandled "Application error: a client-side exception".
 *
 * The boundaries (`app/error.tsx`, `app/global-error.tsx`) call into this module
 * so a stale tab reloads *once* to fetch the current build, while a guard
 * prevents an infinite reload loop when a reload does not resolve the error.
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
 * Detect a chunk/module load failure caused by a stale build.
 *
 * Matches `error.name === 'ChunkLoadError'` (webpack) or an error message
 * containing `Loading chunk` / `Failed to fetch dynamically imported module`.
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

export type ChunkReloadOutcome = 'reloaded' | 'guarded' | 'skipped';

export interface ChunkRecoveryEnv {
  /** sessionStorage-like store, or `null` when unavailable (private mode / SSR). */
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Current time in epoch ms (injected for deterministic testing). */
  now: number;
  /** Triggers the page reload. */
  reload: () => void;
}

/**
 * Reload once to recover from a `ChunkLoadError`, guarding against reload loops.
 *
 * - `'skipped'`  — not a ChunkLoadError; the caller shows its normal error UI.
 * - `'reloaded'` — a page reload was triggered.
 * - `'guarded'`  — a recent reload already happened (or storage is unavailable),
 *                  so no reload is triggered and the caller shows a manual UI.
 */
export function recoverFromChunkError(
  error: unknown,
  env: ChunkRecoveryEnv
): ChunkReloadOutcome {
  if (!isChunkLoadError(error)) return 'skipped';

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
  });
}
