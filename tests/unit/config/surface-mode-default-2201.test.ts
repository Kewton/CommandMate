/**
 * The configured default layer of surface-mode-config (Issue #2201).
 *
 * Issue #2193 gave every surface a persisted "last state". #2201 adds a
 * server-wide "what a surface with no last state opens as", and the ONE thing
 * that must not be got wrong is the order between them:
 *
 *     localStorage (this surface's last state)  >  configured default  >  constant
 *
 * Inverting the first two compiles, type-checks, and looks like a reasonable
 * reading of "the setting decides" — and it would silently reset every split the
 * user had switched by hand, on every page load, for as long as the setting is
 * stored. Every precedence assertion below is written so that inversion turns it
 * red (see the mutation note on the "stored value wins" test).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_SURFACE_MODE } from '@/types/ui-state';
import {
  DEFAULT_SURFACE_MODE_ENDPOINT,
  DEFAULT_SURFACE_MODE_STORAGE_KEY,
  SURFACE_MODE_STORAGE_KEY_PREFIX,
  ensureClientDefaultSurfaceMode,
  getClientDefaultSurfaceMode,
  getMobileSurfaceModeStorageKey,
  getSplitSurfaceModeStorageKey,
  readSurfaceMode,
  resetClientDefaultSurfaceMode,
  resolveSurfaceMode,
  setClientDefaultSurfaceMode,
  subscribeToClientDefaultSurfaceMode,
  writeSurfaceMode,
} from '@/config/surface-mode-config';

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

/** Replace window.localStorage with a stub for one test. */
function stubLocalStorage(impl: Partial<Storage>): () => void {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', { configurable: true, value: impl as Storage });
  return () => {
    if (original) Object.defineProperty(window, 'localStorage', original);
  };
}

describe('[#2201] client default store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetClientDefaultSurfaceMode();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    window.localStorage.clear();
    resetClientDefaultSurfaceMode();
  });

  it('starts at the compiled-in constant', () => {
    // A literal as well as the import: `resetClientDefaultSurfaceMode()`
    // assigns that very binding, so comparing only against the import is
    // `expect(A).toBe(A)` and cannot fail.
    expect(getClientDefaultSurfaceMode()).toBe('terminal');
    expect(getClientDefaultSurfaceMode()).toBe(DEFAULT_SURFACE_MODE);
  });

  it('adopts a valid value and mirrors it for the next page load', () => {
    expect(setClientDefaultSurfaceMode('chat')).toBe(true);
    expect(getClientDefaultSurfaceMode()).toBe('chat');
    expect(window.localStorage.getItem(DEFAULT_SURFACE_MODE_STORAGE_KEY)).toBe('chat');
  });

  it('reports "no change" when the value is already in force', () => {
    setClientDefaultSurfaceMode('chat');
    expect(setClientDefaultSurfaceMode('chat')).toBe(false);
  });

  it.each(['xterm', 'Chat', '', null, undefined, 0, {}, ['chat']])(
    'refuses %s and leaves the previous answer standing',
    (bogus) => {
      setClientDefaultSurfaceMode('chat');
      expect(setClientDefaultSurfaceMode(bogus)).toBe(false);
      expect(getClientDefaultSurfaceMode()).toBe('chat');
    }
  );

  it('reads the mirror written by an earlier page load', () => {
    window.localStorage.setItem(DEFAULT_SURFACE_MODE_STORAGE_KEY, 'chat');
    expect(getClientDefaultSurfaceMode()).toBe('chat');
  });

  it('ignores a mirror holding something that is not a mode', () => {
    window.localStorage.setItem(DEFAULT_SURFACE_MODE_STORAGE_KEY, 'xterm');
    expect(getClientDefaultSurfaceMode()).toBe('terminal');
  });

  it('keeps the setting for the page when storage refuses to answer', () => {
    setClientDefaultSurfaceMode('chat');
    const restore = stubLocalStorage({
      getItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      expect(getClientDefaultSurfaceMode()).toBe('chat');
    } finally {
      restore();
    }
  });

  it('reset clears the mirror as well as the in-memory copy', () => {
    setClientDefaultSurfaceMode('chat');
    resetClientDefaultSurfaceMode();
    expect(getClientDefaultSurfaceMode()).toBe('terminal');
    expect(window.localStorage.getItem(DEFAULT_SURFACE_MODE_STORAGE_KEY)).toBeNull();
  });

  it('notifies subscribers only when the effective default changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToClientDefaultSurfaceMode(listener);
    try {
      setClientDefaultSurfaceMode('chat');
      expect(listener).toHaveBeenCalledTimes(1);
      setClientDefaultSurfaceMode('chat');
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('keeps the mirror out of the per-worktree namespace', () => {
    // A settings key living under the worktree prefix would be one
    // `deriveWorktreeId` collision away from being read as a worktree's mode.
    expect(DEFAULT_SURFACE_MODE_STORAGE_KEY.startsWith(SURFACE_MODE_STORAGE_KEY_PREFIX)).toBe(false);
  });
});

describe('[#2201] ensureClientDefaultSurfaceMode', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetClientDefaultSurfaceMode();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    window.localStorage.clear();
    resetClientDefaultSurfaceMode();
  });

  it('seeds the store from the settings route', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ defaultSurfaceMode: 'chat' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(ensureClientDefaultSurfaceMode()).resolves.toBe('chat');
    expect(fetchMock).toHaveBeenCalledWith(DEFAULT_SURFACE_MODE_ENDPOINT);
    expect(getClientDefaultSurfaceMode()).toBe('chat');
  });

  it('is single-flight and idempotent, so N mounts cost one request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ defaultSurfaceMode: 'chat' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await Promise.all([ensureClientDefaultSurfaceMode(), ensureClientDefaultSurfaceMode()]);
    await ensureClientDefaultSurfaceMode();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the current answer when the request fails', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    await expect(ensureClientDefaultSurfaceMode()).resolves.toBe('terminal');
  });

  it('keeps the current answer for a body that is not this route', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ apps: [] })) as unknown as typeof fetch;

    await expect(ensureClientDefaultSurfaceMode()).resolves.toBe('terminal');
    expect(getClientDefaultSurfaceMode()).toBe('terminal');
  });

  it('retries after a failure rather than latching "seeded"', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(null, false)) as unknown as typeof fetch;
    await ensureClientDefaultSurfaceMode();

    const succeeding = vi.fn(async () => jsonResponse({ defaultSurfaceMode: 'chat' }));
    globalThis.fetch = succeeding as unknown as typeof fetch;
    await ensureClientDefaultSurfaceMode();

    expect(succeeding).toHaveBeenCalledTimes(1);
    expect(getClientDefaultSurfaceMode()).toBe('chat');
  });
});

describe('[#2201] readSurfaceMode precedence: stored state over configured default', () => {
  const SPLIT = getSplitSurfaceModeStorageKey('wt-2201', 0);
  const MOBILE = getMobileSurfaceModeStorageKey('wt-2201');

  beforeEach(() => {
    window.localStorage.clear();
    resetClientDefaultSurfaceMode();
    // `readSurfaceMode` starts a background seed; stub it so this block is
    // about precedence and not about the network.
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    window.history.replaceState({}, '', '/worktrees/wt-2201');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    window.localStorage.clear();
    resetClientDefaultSurfaceMode();
    window.history.replaceState({}, '', '/');
  });

  it('adopts the configured default when the surface has nothing stored', () => {
    setClientDefaultSurfaceMode('chat');
    expect(readSurfaceMode(SPLIT)).toBe('chat');
    expect(readSurfaceMode(MOBILE)).toBe('chat');
  });

  /**
   * THE mutation target of this Issue. Swap the two operands of the `??` in
   * `readSurfaceMode` — i.e. consult the configured default first — and this
   * test goes red while everything else about the module still passes.
   *
   * Both directions are asserted: a stored `terminal` must survive a `chat`
   * default AND a stored `chat` must survive a `terminal` one, so an inversion
   * cannot hide behind the constant happening to match.
   */
  it('keeps a mode the user already switched to, whatever the setting says', () => {
    setClientDefaultSurfaceMode('chat');
    writeSurfaceMode(SPLIT, 'terminal');
    expect(readSurfaceMode(SPLIT)).toBe('terminal');

    setClientDefaultSurfaceMode('terminal');
    writeSurfaceMode(SPLIT, 'chat');
    expect(readSurfaceMode(SPLIT)).toBe('chat');
  });

  it('applies the configured default per surface, not per worktree', () => {
    setClientDefaultSurfaceMode('chat');
    writeSurfaceMode(SPLIT, 'terminal');

    // Split 0 was switched by hand; split 1 and the phone tab never were, so
    // they still start from the setting.
    expect(readSurfaceMode(SPLIT)).toBe('terminal');
    expect(readSurfaceMode(getSplitSurfaceModeStorageKey('wt-2201', 1))).toBe('chat');
    expect(readSurfaceMode(MOBILE)).toBe('chat');
  });

  it('ignores a stored value that is not a mode and uses the setting', () => {
    setClientDefaultSurfaceMode('chat');
    window.localStorage.setItem(SPLIT, 'xterm');
    expect(readSurfaceMode(SPLIT)).toBe('chat');
  });

  it('still falls to the constant when nothing is stored and nothing configured', () => {
    expect(readSurfaceMode(SPLIT)).toBe('terminal');
  });

  it('lets ?view= outrank the configured default, and writes it back', () => {
    setClientDefaultSurfaceMode('terminal');
    window.history.replaceState({}, '', '/worktrees/wt-2201?view=chat');

    expect(resolveSurfaceMode(SPLIT)).toBe('chat');
    expect(window.localStorage.getItem(SPLIT)).toBe('chat');
  });

  it('resolves through the configured default when the URL asks for nothing', () => {
    setClientDefaultSurfaceMode('chat');
    expect(resolveSurfaceMode(SPLIT)).toBe('chat');
    // ...and does not persist it: the setting is the starting value, not a
    // decision the user made about this surface. Persisting it here would pin
    // the surface to today's setting for ever.
    expect(window.localStorage.getItem(SPLIT)).toBeNull();
  });
});
