/**
 * useHistoryPaneState scopes (Issue #2510).
 *
 * Before #2510 the hook had one scope, the worktree screen's, stored under two
 * global keys. The `/sessions` tile needs its own History toggle, and the Issue
 * names the failure it must not have: closing History in a tile closing it on
 * the worktree screen, and the reverse.
 *
 * Two things are pinned here, in this order of importance:
 *
 *  1. **A call with no argument is exactly what it was.** The keys are asserted
 *     as literals, not through the exported constants, so renaming a constant's
 *     value — which would silently reset every stored preference on the worktree
 *     screen — fails here.
 *  2. **The scopes do not leak**, through storage OR through the same-page
 *     broadcast the hook uses to keep its instances in step (#730). The second
 *     is the easy one to miss: separate keys alone still let a tile's toggle
 *     flip a worktree-screen instance mounted on the same page.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useHistoryPaneState,
  WORKTREE_HISTORY_PANE_STORAGE_KEYS,
  SESSION_TILE_HISTORY_PANE_STORAGE_KEYS,
  SESSION_TILE_HISTORY_VISIBLE_STORAGE_KEY,
  DEFAULT_HISTORY_VISIBLE,
  DEFAULT_HISTORY_WIDTH,
} from '@/hooks/useHistoryPaneState';

const WORKTREE_VISIBLE_KEY = 'commandmate.worktree.historyVisible';
const WORKTREE_WIDTH_KEY = 'commandmate.worktree.historyWidth';
const TILE_VISIBLE_KEY = 'commandmate.sessions.tileHistoryVisible';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('useHistoryPaneState() with no argument (Issue #2510 regression guard)', () => {
  it('still names the worktree screen keys verbatim', () => {
    expect(WORKTREE_HISTORY_PANE_STORAGE_KEYS).toEqual({
      visible: WORKTREE_VISIBLE_KEY,
      width: WORKTREE_WIDTH_KEY,
    });
  });

  it('still defaults to visible, at the default width', () => {
    const { result } = renderHook(() => useHistoryPaneState());
    expect(result.current.visible).toBe(true);
    expect(result.current.width).toBe(DEFAULT_HISTORY_WIDTH);
  });

  it('still reads the worktree screen key on mount', () => {
    window.localStorage.setItem(WORKTREE_VISIBLE_KEY, 'false');
    window.localStorage.setItem(WORKTREE_WIDTH_KEY, '25');

    const { result } = renderHook(() => useHistoryPaneState());

    expect(result.current.visible).toBe(false);
    expect(result.current.width).toBe(25);
  });

  it('still writes the worktree screen keys and nothing else', () => {
    const { result } = renderHook(() => useHistoryPaneState());

    act(() => result.current.toggle());
    act(() => result.current.setWidth(30));

    expect(window.localStorage.getItem(WORKTREE_VISIBLE_KEY)).toBe('false');
    expect(window.localStorage.getItem(WORKTREE_WIDTH_KEY)).toBe('30');
    expect(window.localStorage.getItem(TILE_VISIBLE_KEY)).toBeNull();
    expect(window.localStorage.length).toBe(2);
  });

  it('is the same scope as passing the worktree keys explicitly', () => {
    const implicit = renderHook(() => useHistoryPaneState());
    const explicit = renderHook(() => useHistoryPaneState(WORKTREE_HISTORY_PANE_STORAGE_KEYS));

    act(() => implicit.result.current.toggle());

    expect(explicit.result.current.visible).toBe(false);
  });
});

describe('the /sessions tile scope (Issue #2510)', () => {
  it('lives under its own key', () => {
    expect(SESSION_TILE_HISTORY_VISIBLE_STORAGE_KEY).toBe(TILE_VISIBLE_KEY);
    expect(SESSION_TILE_HISTORY_PANE_STORAGE_KEYS.visible).toBe(TILE_VISIBLE_KEY);
    expect(SESSION_TILE_HISTORY_PANE_STORAGE_KEYS.visible).not.toBe(WORKTREE_VISIBLE_KEY);
    expect(SESSION_TILE_HISTORY_PANE_STORAGE_KEYS.width).not.toBe(WORKTREE_WIDTH_KEY);
  });

  it('shows History by default', () => {
    const { result } = renderHook(() => useHistoryPaneState(SESSION_TILE_HISTORY_PANE_STORAGE_KEYS));
    expect(result.current.visible).toBe(DEFAULT_HISTORY_VISIBLE);
    expect(result.current.visible).toBe(true);
  });

  it('keeps History open in a tile when the worktree screen stored it closed', () => {
    window.localStorage.setItem(WORKTREE_VISIBLE_KEY, 'false');

    const { result } = renderHook(() => useHistoryPaneState(SESSION_TILE_HISTORY_PANE_STORAGE_KEYS));

    expect(result.current.visible).toBe(true);
  });

  it('keeps History open on the worktree screen when a tile stored it closed', () => {
    window.localStorage.setItem(TILE_VISIBLE_KEY, 'false');

    const { result } = renderHook(() => useHistoryPaneState());

    expect(result.current.visible).toBe(true);
  });

  it('writes only its own key when toggled', () => {
    const { result } = renderHook(() => useHistoryPaneState(SESSION_TILE_HISTORY_PANE_STORAGE_KEYS));

    act(() => result.current.toggle());

    expect(window.localStorage.getItem(TILE_VISIBLE_KEY)).toBe('false');
    expect(window.localStorage.getItem(WORKTREE_VISIBLE_KEY)).toBeNull();
    expect(window.localStorage.getItem(WORKTREE_WIDTH_KEY)).toBeNull();
  });

  it('does not flip a worktree-screen instance on the same page', () => {
    const worktree = renderHook(() => useHistoryPaneState());
    const tile = renderHook(() => useHistoryPaneState(SESSION_TILE_HISTORY_PANE_STORAGE_KEYS));

    act(() => tile.result.current.toggle());

    expect(tile.result.current.visible).toBe(false);
    expect(worktree.result.current.visible).toBe(true);
  });

  it('is not flipped by a worktree-screen instance on the same page', () => {
    const worktree = renderHook(() => useHistoryPaneState());
    const tile = renderHook(() => useHistoryPaneState(SESSION_TILE_HISTORY_PANE_STORAGE_KEYS));

    act(() => worktree.result.current.toggle());
    act(() => worktree.result.current.setWidth(20));

    expect(worktree.result.current.visible).toBe(false);
    expect(tile.result.current.visible).toBe(true);
    expect(tile.result.current.width).toBe(DEFAULT_HISTORY_WIDTH);
  });

  it('keeps every tile in step — one choice for the whole wall, like splits on the worktree screen', () => {
    const first = renderHook(() => useHistoryPaneState(SESSION_TILE_HISTORY_PANE_STORAGE_KEYS));
    const second = renderHook(() => useHistoryPaneState(SESSION_TILE_HISTORY_PANE_STORAGE_KEYS));

    act(() => first.result.current.toggle());
    expect(second.result.current.visible).toBe(false);

    act(() => second.result.current.toggle());
    expect(first.result.current.visible).toBe(true);
  });
});
