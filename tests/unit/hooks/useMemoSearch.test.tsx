/**
 * useMemoSearch Hook Tests
 * [Issue #787] Memo title/content text search state management
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMemoSearch } from '@/hooks/useMemoSearch';
import type { WorktreeMemo } from '@/types/models';

const SEARCH_DEBOUNCE_MS = 300;

function makeMemo(overrides: Partial<WorktreeMemo>): WorktreeMemo {
  return {
    id: 'memo-x',
    worktreeId: 'worktree-1',
    title: 'Title',
    content: 'Content',
    position: 0,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-02'),
    ...overrides,
  };
}

const memos: WorktreeMemo[] = [
  makeMemo({ id: 'm1', title: 'Alpha plan', content: 'first body', position: 0 }),
  makeMemo({ id: 'm2', title: 'Beta', content: 'contains ALPHA inside', position: 1 }),
  makeMemo({ id: 'm3', title: 'Gamma', content: 'unrelated text', position: 2 }),
  makeMemo({ id: 'm4', title: 'Delta alpha', content: 'more body', position: 3 }),
];

describe('useMemoSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  /** Set query and flush the debounce timer. */
  function setQueryAndFlush(
    result: { current: ReturnType<typeof useMemoSearch> },
    query: string
  ) {
    act(() => {
      result.current.setQuery(query);
    });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
  }

  it('matches memos by title', () => {
    const { result } = renderHook(() => useMemoSearch({ memos }));
    setQueryAndFlush(result, 'alpha');

    const ids = result.current.matches.map((m) => m.id);
    // Title hits: m1 (Alpha plan), m4 (Delta alpha); content hit: m2 (ALPHA)
    expect(ids).toContain('m1');
    expect(ids).toContain('m4');
  });

  it('matches memos by content', () => {
    const { result } = renderHook(() => useMemoSearch({ memos }));
    setQueryAndFlush(result, 'body');

    const ids = result.current.matches.map((m) => m.id);
    expect(ids).toContain('m1'); // "first body"
    expect(ids).toContain('m4'); // "more body"
    expect(ids).not.toContain('m3');
  });

  it('is case-insensitive', () => {
    const { result } = renderHook(() => useMemoSearch({ memos }));
    setQueryAndFlush(result, 'ALPHA');

    const ids = result.current.matches.map((m) => m.id);
    expect(ids).toContain('m1');
    expect(ids).toContain('m2'); // content "ALPHA"
    expect(ids).toContain('m4');
  });

  it('returns empty matches below minimum query length', () => {
    const { result } = renderHook(() => useMemoSearch({ memos }));
    setQueryAndFlush(result, 'a');

    expect(result.current.matches).toHaveLength(0);
    expect(result.current.totalCount).toBe(0);
    expect(result.current.currentMatch).toBe(-1);
  });

  it('returns empty matches while IME composition is active', () => {
    const { result } = renderHook(() => useMemoSearch({ memos }));

    act(() => {
      result.current.onCompositionStart();
    });
    setQueryAndFlush(result, 'alpha');

    // Still empty because composition is in progress.
    expect(result.current.matches).toHaveLength(0);

    act(() => {
      result.current.onCompositionEnd();
    });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });

    expect(result.current.matches.length).toBeGreaterThan(0);
  });

  it('reports totalCount equal to matches length', () => {
    const { result } = renderHook(() => useMemoSearch({ memos }));
    setQueryAndFlush(result, 'alpha');

    expect(result.current.totalCount).toBe(result.current.matches.length);
    expect(result.current.totalCount).toBe(3);
  });

  it('navigateNext wraps around', () => {
    const { result } = renderHook(() => useMemoSearch({ memos }));
    setQueryAndFlush(result, 'alpha'); // 3 matches

    expect(result.current.currentMatch).toBe(0);

    act(() => result.current.navigateNext());
    expect(result.current.currentMatch).toBe(1);

    act(() => result.current.navigateNext());
    expect(result.current.currentMatch).toBe(2);

    act(() => result.current.navigateNext());
    expect(result.current.currentMatch).toBe(0); // wrap
  });

  it('navigatePrev wraps around', () => {
    const { result } = renderHook(() => useMemoSearch({ memos }));
    setQueryAndFlush(result, 'alpha'); // 3 matches

    expect(result.current.currentMatch).toBe(0);

    act(() => result.current.navigatePrev());
    expect(result.current.currentMatch).toBe(2); // wrap backwards

    act(() => result.current.navigatePrev());
    expect(result.current.currentMatch).toBe(1);
  });

  it('keeps currentMatch at -1 when there are no matches', () => {
    const { result } = renderHook(() => useMemoSearch({ memos }));
    setQueryAndFlush(result, 'zzzz-no-such');

    expect(result.current.totalCount).toBe(0);
    expect(result.current.currentMatch).toBe(-1);

    // Navigation is a no-op when empty.
    act(() => result.current.navigateNext());
    expect(result.current.currentMatch).toBe(-1);
  });
});
