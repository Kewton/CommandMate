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

  it('defaults to visible=true and width=DEFAULT_HISTORY_WIDTH', () => {
    const { result } = renderHook(() => useHistoryPaneState());
    expect(result.current.visible).toBe(DEFAULT_HISTORY_VISIBLE);
    expect(result.current.width).toBe(DEFAULT_HISTORY_WIDTH);
  });

  it('toggle() flips visibility and persists', () => {
    const { result } = renderHook(() => useHistoryPaneState());
    act(() => {
      result.current.toggle();
    });
    expect(result.current.visible).toBe(false);
    expect(window.localStorage.getItem(HISTORY_VISIBLE_STORAGE_KEY)).toBe('false');
    act(() => {
      result.current.toggle();
    });
    expect(result.current.visible).toBe(true);
    expect(window.localStorage.getItem(HISTORY_VISIBLE_STORAGE_KEY)).toBe('true');
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
    expect(result.current.visible).toBe(DEFAULT_HISTORY_VISIBLE);
    expect(result.current.width).toBe(DEFAULT_HISTORY_WIDTH);
  });

  it('clamps stored out-of-range width on hydration', () => {
    window.localStorage.setItem(HISTORY_WIDTH_STORAGE_KEY, '999');
    const { result } = renderHook(() => useHistoryPaneState());
    expect(result.current.width).toBe(MAX_HISTORY_WIDTH);
  });
});
