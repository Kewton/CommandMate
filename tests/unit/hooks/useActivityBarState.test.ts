/**
 * Tests for useActivityBarState (Issue #727)
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useActivityBarState } from '@/hooks/useActivityBarState';
import {
  ACTIVITY_BAR_STORAGE_KEY,
  DEFAULT_ACTIVITY,
} from '@/config/activity-bar-config';

describe('useActivityBarState', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('defaults to DEFAULT_ACTIVITY ("files") on first mount', () => {
    const { result } = renderHook(() => useActivityBarState());
    expect(result.current.active).toBe(DEFAULT_ACTIVITY);
  });

  it('setActive(id) sets the active activity and persists it', () => {
    const { result } = renderHook(() => useActivityBarState());
    act(() => {
      result.current.setActive('git');
    });
    expect(result.current.active).toBe('git');
    expect(window.localStorage.getItem(ACTIVITY_BAR_STORAGE_KEY)).toBe('git');
  });

  it('toggle(id) opens an inactive activity', () => {
    const { result } = renderHook(() => useActivityBarState());
    act(() => {
      result.current.toggle('notes');
    });
    expect(result.current.active).toBe('notes');
    expect(window.localStorage.getItem(ACTIVITY_BAR_STORAGE_KEY)).toBe('notes');
  });

  it('toggle(id) closes the activity when called with the active id', () => {
    const { result } = renderHook(() => useActivityBarState());
    act(() => {
      result.current.setActive('git');
    });
    expect(result.current.active).toBe('git');
    act(() => {
      result.current.toggle('git');
    });
    expect(result.current.active).toBeNull();
  });

  it('does NOT persist the closed (null) state — keeps last opened in storage', () => {
    const { result } = renderHook(() => useActivityBarState());
    act(() => {
      result.current.setActive('schedules');
    });
    act(() => {
      result.current.toggle('schedules');
    });
    expect(result.current.active).toBeNull();
    // Storage should still contain the last opened activity ('schedules')
    expect(window.localStorage.getItem(ACTIVITY_BAR_STORAGE_KEY)).toBe('schedules');
  });

  it('restores the stored activity on next mount', () => {
    window.localStorage.setItem(ACTIVITY_BAR_STORAGE_KEY, 'timer');
    const { result } = renderHook(() => useActivityBarState());
    // Effect runs synchronously inside renderHook -> the value is hydrated.
    expect(result.current.active).toBe('timer');
  });

  it('falls back to DEFAULT_ACTIVITY when stored value is invalid', () => {
    window.localStorage.setItem(ACTIVITY_BAR_STORAGE_KEY, 'not-a-real-activity');
    const { result } = renderHook(() => useActivityBarState());
    expect(result.current.active).toBe(DEFAULT_ACTIVITY);
  });

  it('toggling between two activities switches between them (no close)', () => {
    const { result } = renderHook(() => useActivityBarState());
    act(() => {
      result.current.toggle('git');
    });
    expect(result.current.active).toBe('git');
    act(() => {
      result.current.toggle('agent');
    });
    expect(result.current.active).toBe('agent');
  });
});
