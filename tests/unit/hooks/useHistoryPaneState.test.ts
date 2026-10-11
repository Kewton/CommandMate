/**
 * Tests for useHistoryPaneState (Issue #727)
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useHistoryPaneState,
  HISTORY_VISIBLE_STORAGE_KEY,
  HISTORY_WIDTH_STORAGE_KEY,
  DEFAULT_HISTORY_VISIBLE,
  WORKTREE_DEFAULT_HISTORY_VISIBLE,
  SESSION_TILE_HISTORY_PANE_STORAGE_KEYS,
  DEFAULT_HISTORY_WIDTH,
  MIN_HISTORY_WIDTH,
  MAX_HISTORY_WIDTH,
} from '@/hooks/useHistoryPaneState';

describe('useHistoryPaneState', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('defaults the worktree screen to visible=false (Issue #3589) and width=DEFAULT_HISTORY_WIDTH', () => {
    const { result } = renderHook(() => useHistoryPaneState());
    expect(result.current.visible).toBe(WORKTREE_DEFAULT_HISTORY_VISIBLE);
    expect(result.current.visible).toBe(false);
    expect(result.current.width).toBe(DEFAULT_HISTORY_WIDTH);
  });

  it('keeps the shared DEFAULT_HISTORY_VISIBLE (and the /sessions tile default) at true (Issue #3589)', () => {
    expect(DEFAULT_HISTORY_VISIBLE).toBe(true);
    const { result } = renderHook(() => useHistoryPaneState(SESSION_TILE_HISTORY_PANE_STORAGE_KEYS));
    expect(result.current.visible).toBe(true);
  });

  it('toggle() flips visibility and persists', () => {
    const { result } = renderHook(() => useHistoryPaneState());
    act(() => {
      result.current.toggle();
    });
    expect(result.current.visible).toBe(true);
    expect(window.localStorage.getItem(HISTORY_VISIBLE_STORAGE_KEY)).toBe('true');
    act(() => {
      result.current.toggle();
    });
    expect(result.current.visible).toBe(false);
    expect(window.localStorage.getItem(HISTORY_VISIBLE_STORAGE_KEY)).toBe('false');
  });

  it('setWidth(n) clamps to [MIN_HISTORY_WIDTH, MAX_HISTORY_WIDTH] and persists', () => {
    const { result } = renderHook(() => useHistoryPaneState());

    act(() => {
      result.current.setWidth(30);
    });
    expect(result.current.width).toBe(30);
    expect(window.localStorage.getItem(HISTORY_WIDTH_STORAGE_KEY)).toBe('30');

    act(() => {
      result.current.setWidth(1);
    });
    expect(result.current.width).toBe(MIN_HISTORY_WIDTH);

    act(() => {
      result.current.setWidth(9999);
    });
    expect(result.current.width).toBe(MAX_HISTORY_WIDTH);
  });

  it('restores stored visible=true on mount (Issue #3589: a stored choice beats the default)', () => {
    window.localStorage.setItem(HISTORY_VISIBLE_STORAGE_KEY, 'true');
    const { result } = renderHook(() => useHistoryPaneState());
    expect(result.current.visible).toBe(true);
  });

  it('restores stored visible=false on mount', () => {
    window.localStorage.setItem(HISTORY_VISIBLE_STORAGE_KEY, 'false');
    const { result } = renderHook(() => useHistoryPaneState());
    expect(result.current.visible).toBe(false);
  });

  it('restores stored width on mount', () => {
    window.localStorage.setItem(HISTORY_WIDTH_STORAGE_KEY, '40');
    const { result } = renderHook(() => useHistoryPaneState());
    expect(result.current.width).toBe(40);
  });

  it('falls back to defaults when stored values are invalid', () => {
    window.localStorage.setItem(HISTORY_VISIBLE_STORAGE_KEY, 'garbage');
    window.localStorage.setItem(HISTORY_WIDTH_STORAGE_KEY, 'NaN');
    const { result } = renderHook(() => useHistoryPaneState());
    expect(result.current.visible).toBe(WORKTREE_DEFAULT_HISTORY_VISIBLE);
    expect(result.current.width).toBe(DEFAULT_HISTORY_WIDTH);
  });

  it('clamps stored out-of-range width on hydration', () => {
    window.localStorage.setItem(HISTORY_WIDTH_STORAGE_KEY, '999');
    const { result } = renderHook(() => useHistoryPaneState());
    expect(result.current.width).toBe(MAX_HISTORY_WIDTH);
  });
});
