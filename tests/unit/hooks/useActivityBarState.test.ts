/**
 * Tests for useActivityBarState (Issue #727; per-worktree persistence Issue #858)
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useActivityBarState } from '@/hooks/useActivityBarState';
import {
  ACTIVITY_CLOSED_SENTINEL,
  DEFAULT_ACTIVITY,
  getActivityBarStorageKey,
} from '@/config/activity-bar-config';

const WT_A = 'feature-A';
const WT_B = 'feature-B';

const keyA = getActivityBarStorageKey(WT_A);
const keyB = getActivityBarStorageKey(WT_B);

describe('useActivityBarState', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('defaults to DEFAULT_ACTIVITY ("files") on first mount', () => {
    const { result } = renderHook(() => useActivityBarState(WT_A));
    expect(result.current.active).toBe(DEFAULT_ACTIVITY);
  });

  it('setActive(id) sets the active activity and persists it per worktree', () => {
    const { result } = renderHook(() => useActivityBarState(WT_A));
    act(() => {
      result.current.setActive('git');
    });
    expect(result.current.active).toBe('git');
    expect(window.localStorage.getItem(keyA)).toBe('git');
  });

  it('toggle(id) opens an inactive activity', () => {
    const { result } = renderHook(() => useActivityBarState(WT_A));
    act(() => {
      result.current.toggle('notes');
    });
    expect(result.current.active).toBe('notes');
    expect(window.localStorage.getItem(keyA)).toBe('notes');
  });

  it('toggle(id) closes the activity when called with the active id', () => {
    const { result } = renderHook(() => useActivityBarState(WT_A));
    act(() => {
      result.current.setActive('git');
    });
    expect(result.current.active).toBe('git');
    act(() => {
      result.current.toggle('git');
    });
    expect(result.current.active).toBeNull();
  });

  it('persists the closed (null) state as the closed sentinel (Issue #858)', () => {
    const { result } = renderHook(() => useActivityBarState(WT_A));
    act(() => {
      result.current.setActive('schedules');
    });
    act(() => {
      result.current.toggle('schedules');
    });
    expect(result.current.active).toBeNull();
    // Storage now records the *closed* state via the sentinel (not the last
    // opened activity).
    expect(window.localStorage.getItem(keyA)).toBe(ACTIVITY_CLOSED_SENTINEL);
  });

  it('restores the stored activity on next mount', () => {
    window.localStorage.setItem(keyA, 'timer');
    const { result } = renderHook(() => useActivityBarState(WT_A));
    // Effect runs synchronously inside renderHook -> the value is hydrated.
    expect(result.current.active).toBe('timer');
  });

  it('restores the closed (hidden) state from the sentinel on next mount', () => {
    window.localStorage.setItem(keyA, ACTIVITY_CLOSED_SENTINEL);
    const { result } = renderHook(() => useActivityBarState(WT_A));
    expect(result.current.active).toBeNull();
  });

  it('falls back to DEFAULT_ACTIVITY when stored value is invalid', () => {
    window.localStorage.setItem(keyA, 'not-a-real-activity');
    const { result } = renderHook(() => useActivityBarState(WT_A));
    expect(result.current.active).toBe(DEFAULT_ACTIVITY);
  });

  it('toggling between two activities switches between them (no close)', () => {
    const { result } = renderHook(() => useActivityBarState(WT_A));
    act(() => {
      result.current.toggle('git');
    });
    expect(result.current.active).toBe('git');
    act(() => {
      result.current.toggle('agent');
    });
    expect(result.current.active).toBe('agent');
  });

  describe('per-worktree isolation (Issue #858)', () => {
    it('persists state under a per-worktree key', () => {
      const { result } = renderHook(() => useActivityBarState(WT_A));
      act(() => {
        result.current.setActive('git');
      });
      expect(window.localStorage.getItem(keyA)).toBe('git');
      // The other worktree's key is untouched.
      expect(window.localStorage.getItem(keyB)).toBeNull();
    });

    it('keeps open/closed state independent across worktrees', () => {
      // Worktree A: hidden. Worktree B: showing notes.
      window.localStorage.setItem(keyA, ACTIVITY_CLOSED_SENTINEL);
      window.localStorage.setItem(keyB, 'notes');

      const { result: a } = renderHook(() => useActivityBarState(WT_A));
      const { result: b } = renderHook(() => useActivityBarState(WT_B));

      expect(a.current.active).toBeNull();
      expect(b.current.active).toBe('notes');
    });

    it('re-hydrates the correct per-worktree state when worktreeId changes', () => {
      // A was hidden; B last showed git.
      window.localStorage.setItem(keyA, ACTIVITY_CLOSED_SENTINEL);
      window.localStorage.setItem(keyB, 'git');

      const { result, rerender } = renderHook(
        ({ id }) => useActivityBarState(id),
        { initialProps: { id: WT_A } },
      );
      // A is hidden.
      expect(result.current.active).toBeNull();

      // Switch to B (e.g. branch switch without a full remount).
      rerender({ id: WT_B });
      expect(result.current.active).toBe('git');

      // Switch back to A — the hidden state is preserved (the core bug fix).
      rerender({ id: WT_A });
      expect(result.current.active).toBeNull();
    });

    it('defaults an unvisited worktree to Files even after visiting others', () => {
      window.localStorage.setItem(keyA, ACTIVITY_CLOSED_SENTINEL);
      const { result, rerender } = renderHook(
        ({ id }) => useActivityBarState(id),
        { initialProps: { id: WT_A } },
      );
      expect(result.current.active).toBeNull();
      // B has never been visited -> default Files.
      rerender({ id: WT_B });
      expect(result.current.active).toBe(DEFAULT_ACTIVITY);
    });
  });
});
