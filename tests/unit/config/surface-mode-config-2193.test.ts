/**
 * surface-mode-config + isSurfaceMode unit tests (Issue #2193).
 *
 * This module is the ONLY boundary between a SurfaceMode and its two untrusted
 * sources — the `?view=` query parameter and localStorage. Both can hold
 * anything: a stale value from a future build, an extension's write, a
 * hand-edited URL. What is asserted here is that neither can produce a value the
 * components then switch on, and that a browser which refuses storage outright
 * (private mode, "block site data") degrades to a working default instead of
 * throwing through render.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_SURFACE_MODE, isSurfaceMode } from '@/types/ui-state';
import {
  SURFACE_MODE_STORAGE_KEY_PREFIX,
  SURFACE_MODE_VIEW_PARAM,
  getMobileSurfaceModeStorageKey,
  getSplitSurfaceModeStorageKey,
  parseSurfaceModeParam,
  readSurfaceMode,
  resolveSurfaceMode,
  writeSurfaceMode,
} from '@/config/surface-mode-config';

/** Replace window.localStorage with a stub for one test. */
function stubLocalStorage(impl: Partial<Storage>): () => void {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: impl as Storage,
  });
  return () => {
    if (original) Object.defineProperty(window, 'localStorage', original);
  };
}

describe('[#2193] isSurfaceMode', () => {
  it('accepts exactly the two declared modes', () => {
    expect(isSurfaceMode('terminal')).toBe(true);
    expect(isSurfaceMode('chat')).toBe(true);
  });

  it('rejects everything else, including the values a URL can carry', () => {
    for (const value of [
      'xterm', // the reserved third value -- not shipped yet, so not valid yet
      'Chat',
      'terminal ',
      '',
      'history',
      '<script>alert(1)</script>',
      '__proto__',
      null,
      undefined,
      0,
      {},
      ['chat'],
    ]) {
      expect(isSurfaceMode(value), String(value)).toBe(false);
    }
  });

  it('does not accept an inherited Object property name', () => {
    // The guard is backed by a Set, not by `value in {...}` — `toString` would
    // pass the latter.
    expect(isSurfaceMode('toString')).toBe(false);
    expect(isSurfaceMode('constructor')).toBe(false);
  });
});

describe('[#2193] storage key generation', () => {
  it('scopes the PC key per worktree AND per split', () => {
    expect(getSplitSurfaceModeStorageKey('wt-1', 0)).toBe(
      `${SURFACE_MODE_STORAGE_KEY_PREFIX}wt-1-split-0`
    );
    expect(getSplitSurfaceModeStorageKey('wt-1', 1)).toBe(
      `${SURFACE_MODE_STORAGE_KEY_PREFIX}wt-1-split-1`
    );
    // Two splits of the same worktree must not share a preference.
    expect(getSplitSurfaceModeStorageKey('wt-1', 0)).not.toBe(
      getSplitSurfaceModeStorageKey('wt-1', 1)
    );
    // Two worktrees at the same split index must not share one either.
    expect(getSplitSurfaceModeStorageKey('wt-1', 0)).not.toBe(
      getSplitSurfaceModeStorageKey('wt-2', 0)
    );
  });

  it('scopes the mobile key per worktree only', () => {
    expect(getMobileSurfaceModeStorageKey('wt-1')).toBe(
      `${SURFACE_MODE_STORAGE_KEY_PREFIX}wt-1-mobile`
    );
    expect(getMobileSurfaceModeStorageKey('wt-1')).not.toBe(
      getMobileSurfaceModeStorageKey('wt-2')
    );
  });

  it('keeps a numeric-suffixed worktree id out of another worktree namespace', () => {
    // The regression this closes: Issue #2193 specified `<id>-<splitIndex>` and
    // `<id>`, and a worktree id is a slug of its directory basename
    // (`deriveWorktreeId`, #1621), so `proj-1` is an ordinary id. Under the
    // specified shapes the phone's key for `proj-1` IS split 1's key for
    // `proj`, and two unrelated worktrees would share one preference.
    expect(getSplitSurfaceModeStorageKey('proj', 1)).not.toBe(
      getMobileSurfaceModeStorageKey('proj-1')
    );
    expect(getSplitSurfaceModeStorageKey('proj', 1)).not.toBe(
      getSplitSurfaceModeStorageKey('proj-1', 1)
    );
    // Every key ends in a non-numeric discriminator, which is what makes the
    // two families unforgeable from each other.
    expect(getSplitSurfaceModeStorageKey('proj', 1)).toContain('-split-');
    expect(getMobileSurfaceModeStorageKey('proj')).toMatch(/-mobile$/);
  });

  it('gives every (worktree, surface) pair a distinct key', () => {
    const keys = [
      getSplitSurfaceModeStorageKey('proj', 0),
      getSplitSurfaceModeStorageKey('proj', 1),
      getSplitSurfaceModeStorageKey('proj-1', 0),
      getSplitSurfaceModeStorageKey('proj-1', 1),
      getSplitSurfaceModeStorageKey('proj-mobile', 0),
      getMobileSurfaceModeStorageKey('proj'),
      getMobileSurfaceModeStorageKey('proj-1'),
      getMobileSurfaceModeStorageKey('proj-split-1'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('[#2193] readSurfaceMode / writeSurfaceMode', () => {
  const KEY = getSplitSurfaceModeStorageKey('wt-read', 0);

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to terminal when nothing is stored', () => {
    expect(readSurfaceMode(KEY)).toBe('terminal');
    expect(readSurfaceMode(KEY)).toBe(DEFAULT_SURFACE_MODE);
  });

  it('round-trips a written mode', () => {
    writeSurfaceMode(KEY, 'chat');
    expect(window.localStorage.getItem(KEY)).toBe('chat');
    expect(readSurfaceMode(KEY)).toBe('chat');

    writeSurfaceMode(KEY, 'terminal');
    expect(readSurfaceMode(KEY)).toBe('terminal');
  });

  it('falls back to terminal for a stored value that is not a mode', () => {
    for (const bogus of ['xterm', 'CHAT', 'history', '{"mode":"chat"}', '']) {
      window.localStorage.setItem(KEY, bogus);
      expect(readSurfaceMode(KEY), bogus).toBe('terminal');
    }
  });

  it('returns the default when reading throws (site data blocked)', () => {
    const restore = stubLocalStorage({
      getItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      expect(() => readSurfaceMode(KEY)).not.toThrow();
      expect(readSurfaceMode(KEY)).toBe('terminal');
    } finally {
      restore();
    }
  });

  it('swallows a write that throws (quota / private mode)', () => {
    const setItem = vi.fn(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    const restore = stubLocalStorage({ setItem });
    try {
      expect(() => writeSurfaceMode(KEY, 'chat')).not.toThrow();
      expect(setItem).toHaveBeenCalledWith(KEY, 'chat');
    } finally {
      restore();
    }
  });
});

describe('[#2193] parseSurfaceModeParam', () => {
  it('reads a valid ?view=', () => {
    expect(parseSurfaceModeParam('?view=chat')).toBe('chat');
    expect(parseSurfaceModeParam('?view=terminal')).toBe('terminal');
    expect(parseSurfaceModeParam('view=chat')).toBe('chat');
  });

  it('composes with ?pane= in either order', () => {
    expect(parseSurfaceModeParam('?pane=terminal&view=chat')).toBe('chat');
    expect(parseSurfaceModeParam('?view=chat&pane=files')).toBe('chat');
  });

  it('returns null — not the default — when there is nothing usable', () => {
    // null rather than 'terminal' is what lets the caller tell "the URL said
    // terminal" apart from "the URL said nothing", so only the former may
    // overwrite a stored 'chat'.
    expect(parseSurfaceModeParam('')).toBeNull();
    expect(parseSurfaceModeParam(null)).toBeNull();
    expect(parseSurfaceModeParam(undefined)).toBeNull();
    expect(parseSurfaceModeParam('?pane=files')).toBeNull();
  });

  it('ignores an invalid ?view= instead of failing', () => {
    expect(parseSurfaceModeParam('?view=xterm')).toBeNull();
    expect(parseSurfaceModeParam('?view=%3Cscript%3E')).toBeNull();
    expect(parseSurfaceModeParam('?view=')).toBeNull();
    expect(parseSurfaceModeParam('?view=chat&view=bogus')).toBe('chat');
  });

  it('names the parameter it documents', () => {
    expect(SURFACE_MODE_VIEW_PARAM).toBe('view');
  });
});

describe('[#2193] resolveSurfaceMode precedence', () => {
  const KEY = getSplitSurfaceModeStorageKey('wt-resolve', 0);

  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/worktrees/wt-resolve');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('uses the stored mode when the URL asks for nothing', () => {
    writeSurfaceMode(KEY, 'chat');
    expect(resolveSurfaceMode(KEY)).toBe('chat');
  });

  it('lets a valid ?view= override localStorage', () => {
    writeSurfaceMode(KEY, 'terminal');
    window.history.replaceState({}, '', '/worktrees/wt-resolve?view=chat');
    expect(resolveSurfaceMode(KEY)).toBe('chat');
  });

  it('persists the deep-linked mode so a shared link does not revert', () => {
    window.history.replaceState({}, '', '/worktrees/wt-resolve?view=chat');
    resolveSurfaceMode(KEY);
    expect(window.localStorage.getItem(KEY)).toBe('chat');
  });

  it('ignores an invalid ?view= and keeps the stored mode', () => {
    writeSurfaceMode(KEY, 'chat');
    window.history.replaceState({}, '', '/worktrees/wt-resolve?view=bogus');
    expect(resolveSurfaceMode(KEY)).toBe('chat');
    // and it must not have clobbered the stored value with the junk
    expect(window.localStorage.getItem(KEY)).toBe('chat');
  });

  it('falls back to terminal with neither a URL nor a stored value', () => {
    expect(resolveSurfaceMode(KEY)).toBe('terminal');
  });

  it('accepts an explicitly supplied view param, and null to ignore the URL', () => {
    writeSurfaceMode(KEY, 'terminal');
    expect(resolveSurfaceMode(KEY, 'chat')).toBe('chat');

    window.history.replaceState({}, '', '/worktrees/wt-resolve?view=chat');
    writeSurfaceMode(KEY, 'terminal');
    expect(resolveSurfaceMode(KEY, null)).toBe('terminal');
  });
});
