/**
 * useSessionTileSurfaceMode — one tile's chat / terminal choice (Issue #2510).
 *
 * The contract in three lines: a tile nobody has switched is still the Phase 1
 * chat tile; a switch is remembered per worktree; and the preference lives in a
 * namespace of its own, so it can never be read as — or overwrite — the worktree
 * screen's surface mode for the same worktree.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  DEFAULT_SESSION_TILE_SURFACE_MODE,
  getSessionTileSurfaceModeStorageKey,
  useSessionTileSurfaceMode,
} from '@/hooks/useSessionTileSurfaceMode';
import {
  DEFAULT_SURFACE_MODE_STORAGE_KEY,
  SURFACE_MODE_STORAGE_KEY_PREFIX,
  getMobileSurfaceModeStorageKey,
  getSplitSurfaceModeStorageKey,
} from '@/config/surface-mode-config';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('getSessionTileSurfaceModeStorageKey (Issue #2510)', () => {
  it('scopes the key to the worktree under the sessions namespace', () => {
    expect(getSessionTileSurfaceModeStorageKey('wt-1')).toBe(
      'commandmate.sessions.tileSurfaceMode-wt-1',
    );
  });

  it('never lands in the worktree screen namespace', () => {
    const key = getSessionTileSurfaceModeStorageKey('proj-1');
    expect(key.startsWith(SURFACE_MODE_STORAGE_KEY_PREFIX)).toBe(false);
    expect(key).not.toBe(getMobileSurfaceModeStorageKey('proj-1'));
    expect(key).not.toBe(getSplitSurfaceModeStorageKey('proj', 1));
    expect(key).not.toBe(DEFAULT_SURFACE_MODE_STORAGE_KEY);
  });
});

describe('useSessionTileSurfaceMode (Issue #2510)', () => {
  it('opens on chat — the Phase 1 tile', () => {
    expect(DEFAULT_SESSION_TILE_SURFACE_MODE).toBe('chat');
    const { result } = renderHook(() => useSessionTileSurfaceMode('wt-1'));
    expect(result.current.surfaceMode).toBe('chat');
  });

  it('is not moved by the server-wide default surface setting', () => {
    // #2201's mirror names what a worktree-screen pane opens as; see the hook's
    // module comment for why a tile does not follow it.
    window.localStorage.setItem(DEFAULT_SURFACE_MODE_STORAGE_KEY, 'terminal');

    const { result } = renderHook(() => useSessionTileSurfaceMode('wt-1'));

    expect(result.current.surfaceMode).toBe('chat');
  });

  it('persists a switch as the bare mode string', () => {
    const { result } = renderHook(() => useSessionTileSurfaceMode('wt-1'));

    act(() => result.current.setSurfaceMode('terminal'));

    expect(result.current.surfaceMode).toBe('terminal');
    expect(window.localStorage.getItem('commandmate.sessions.tileSurfaceMode-wt-1')).toBe('terminal');
  });

  it('restores the stored mode on mount', () => {
    window.localStorage.setItem('commandmate.sessions.tileSurfaceMode-wt-1', 'terminal');

    const { result } = renderHook(() => useSessionTileSurfaceMode('wt-1'));

    expect(result.current.surfaceMode).toBe('terminal');
  });

  it('keeps each worktree its own choice', () => {
    const first = renderHook(() => useSessionTileSurfaceMode('wt-1'));
    const second = renderHook(() => useSessionTileSurfaceMode('wt-2'));

    act(() => first.result.current.setSurfaceMode('terminal'));

    expect(first.result.current.surfaceMode).toBe('terminal');
    expect(second.result.current.surfaceMode).toBe('chat');
    expect(window.localStorage.getItem('commandmate.sessions.tileSurfaceMode-wt-2')).toBeNull();
  });

  it('does not read the worktree screen preference for the same worktree', () => {
    window.localStorage.setItem(getMobileSurfaceModeStorageKey('wt-1'), 'terminal');
    window.localStorage.setItem(getSplitSurfaceModeStorageKey('wt-1', 0), 'terminal');

    const { result } = renderHook(() => useSessionTileSurfaceMode('wt-1'));

    expect(result.current.surfaceMode).toBe('chat');
  });

  it('does not write the worktree screen preference either', () => {
    const { result } = renderHook(() => useSessionTileSurfaceMode('wt-1'));

    act(() => result.current.setSurfaceMode('terminal'));

    expect(window.localStorage.getItem(getMobileSurfaceModeStorageKey('wt-1'))).toBeNull();
    expect(window.localStorage.getItem(getSplitSurfaceModeStorageKey('wt-1', 0))).toBeNull();
  });

  it.each(['xterm', 'TERMINAL', '"terminal"', ''])(
    'falls back to chat for a stored value it cannot draw (%j)',
    (stored) => {
      window.localStorage.setItem('commandmate.sessions.tileSurfaceMode-wt-1', stored);

      const { result } = renderHook(() => useSessionTileSurfaceMode('wt-1'));

      expect(result.current.surfaceMode).toBe('chat');
    },
  );
});
