/**
 * Tests for useFileTreeExpandedState (Issue #1108)
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useFileTreeExpandedState,
  getFileTreeExpandedStorageKey,
  FILE_TREE_EXPANDED_STORAGE_KEY_PREFIX,
} from '@/hooks/useFileTreeExpandedState';

const WT = 'wt-1';
const KEY = getFileTreeExpandedStorageKey(WT);

function readKey(worktreeId: string): string[] | null {
  const raw = window.localStorage.getItem(
    getFileTreeExpandedStorageKey(worktreeId),
  );
  return raw ? (JSON.parse(raw) as string[]) : null;
}

describe('useFileTreeExpandedState', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('uses the colon-scoped per-worktree storage key', () => {
    expect(KEY).toBe(`${FILE_TREE_EXPANDED_STORAGE_KEY_PREFIX}${WT}`);
    expect(KEY).toBe('commandmate:file-tree-expanded:wt-1');
  });

  it('defaults to an empty set for an unvisited worktree', () => {
    const { result } = renderHook(() => useFileTreeExpandedState(WT));
    expect(result.current.expanded.size).toBe(0);
  });

  it('restores the persisted set synchronously on mount (lazy init)', () => {
    window.localStorage.setItem(KEY, JSON.stringify(['src', 'src/hooks']));
    const { result } = renderHook(() => useFileTreeExpandedState(WT));
    // Available on the very first render (no act/effect needed).
    expect(result.current.expanded.has('src')).toBe(true);
    expect(result.current.expanded.has('src/hooks')).toBe(true);
    expect(result.current.expanded.size).toBe(2);
  });

  it('persists on change (functional updater supported)', () => {
    const { result } = renderHook(() => useFileTreeExpandedState(WT));
    act(() => {
      result.current.setExpanded((prev) => new Set(prev).add('src'));
    });
    expect(readKey(WT)).toEqual(['src']);
    act(() => {
      result.current.setExpanded((prev) => new Set(prev).add('docs'));
    });
    expect(new Set(readKey(WT))).toEqual(new Set(['src', 'docs']));
  });

  it('removes the key (does not store "[]") when the set becomes empty', () => {
    window.localStorage.setItem(KEY, JSON.stringify(['src']));
    const { result } = renderHook(() => useFileTreeExpandedState(WT));
    act(() => {
      result.current.setExpanded(new Set());
    });
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('resetExpanded() collapses everything and deletes the persisted key', () => {
    window.localStorage.setItem(KEY, JSON.stringify(['src', 'docs']));
    const { result } = renderHook(() => useFileTreeExpandedState(WT));
    act(() => {
      result.current.resetExpanded();
    });
    expect(result.current.expanded.size).toBe(0);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('re-hydrates when worktreeId changes without leaking across worktrees', () => {
    window.localStorage.setItem(
      getFileTreeExpandedStorageKey('wt-a'),
      JSON.stringify(['a-dir']),
    );
    window.localStorage.setItem(
      getFileTreeExpandedStorageKey('wt-b'),
      JSON.stringify(['b-dir']),
    );

    const { result, rerender } = renderHook(
      ({ id }) => useFileTreeExpandedState(id),
      { initialProps: { id: 'wt-a' } },
    );
    expect(result.current.expanded.has('a-dir')).toBe(true);

    rerender({ id: 'wt-b' });

    // Now shows wt-b's set, not wt-a's.
    expect(result.current.expanded.has('b-dir')).toBe(true);
    expect(result.current.expanded.has('a-dir')).toBe(false);
    // wt-a's key is untouched (no cross-worktree leakage).
    expect(readKey('wt-a')).toEqual(['a-dir']);
    expect(readKey('wt-b')).toEqual(['b-dir']);
  });

  it('does not write another worktree\'s expansion into the new key on switch', () => {
    window.localStorage.setItem(
      getFileTreeExpandedStorageKey('wt-a'),
      JSON.stringify(['a-dir']),
    );
    // wt-b starts unvisited (no key).
    const { rerender } = renderHook(
      ({ id }) => useFileTreeExpandedState(id),
      { initialProps: { id: 'wt-a' } },
    );
    rerender({ id: 'wt-b' });
    // wt-b remains unvisited/empty — 'a-dir' must not have leaked in.
    expect(window.localStorage.getItem(getFileTreeExpandedStorageKey('wt-b'))).toBeNull();
  });

  it('resetExpanded identity is stable across renders', () => {
    const { result, rerender } = renderHook(() => useFileTreeExpandedState(WT));
    const reset1 = result.current.resetExpanded;
    rerender();
    expect(Object.is(reset1, result.current.resetExpanded)).toBe(true);
  });
});
