/**
 * Unit Tests for useFileContentSearch hook
 *
 * Issue #469: Refactoring - DRY extraction of search logic
 * Issue #723: Debounce (300ms) + min 2-char query alignment with TerminalSearchBar
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileContentSearch } from '@/hooks/useFileContentSearch';
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_QUERY_LENGTH,
} from '@/hooks/useTerminalSearch';

describe('useFileContentSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Helper to advance debounce timers and flush effects */
  function flushDebounce() {
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
  }

  it('should initialize with search closed and empty state', () => {
    const { result } = renderHook(() => useFileContentSearch('line1\nline2'));

    expect(result.current.searchOpen).toBe(false);
    expect(result.current.searchQuery).toBe('');
    expect(result.current.searchMatches).toEqual([]);
    expect(result.current.searchCurrentIdx).toBe(0);
  });

  it('should open search and set searchOpen to true', () => {
    const { result } = renderHook(() => useFileContentSearch('line1\nline2'));

    act(() => {
      result.current.openSearch();
    });

    expect(result.current.searchOpen).toBe(true);
  });

  it('should close search and reset all state', () => {
    const { result } = renderHook(() => useFileContentSearch('hello world\nhello again'));

    act(() => {
      result.current.openSearch();
      result.current.setSearchQuery('hello');
    });
    flushDebounce();

    expect(result.current.searchOpen).toBe(true);
    expect(result.current.searchMatches.length).toBeGreaterThan(0);

    act(() => {
      result.current.closeSearch();
    });

    expect(result.current.searchOpen).toBe(false);
    expect(result.current.searchQuery).toBe('');
    expect(result.current.searchMatches).toEqual([]);
    expect(result.current.searchCurrentIdx).toBe(0);
  });

  it('should find matching lines (case-insensitive, 1-based line numbers) after debounce', () => {
    const content = 'Hello World\nfoo bar\nhello again\nbaz';
    const { result } = renderHook(() => useFileContentSearch(content));

    act(() => {
      result.current.setSearchQuery('hello');
    });
    flushDebounce();

    expect(result.current.searchMatches).toEqual([1, 3]);
  });

  it('should not search if query is shorter than min length', () => {
    const content = 'a\nb\nc';
    const { result } = renderHook(() => useFileContentSearch(content));

    act(() => {
      result.current.setSearchQuery('a');
    });
    flushDebounce();

    expect(SEARCH_MIN_QUERY_LENGTH).toBe(2);
    expect(result.current.searchMatches).toEqual([]);
  });

  it('should return empty matches when content is undefined', () => {
    const { result } = renderHook(() => useFileContentSearch(undefined));

    act(() => {
      result.current.setSearchQuery('hello');
    });
    flushDebounce();

    expect(result.current.searchMatches).toEqual([]);
  });

  it('should navigate to next match cyclically', () => {
    const content = 'aa\nbb\naa\ncc\naa';
    const { result } = renderHook(() => useFileContentSearch(content));

    act(() => {
      result.current.setSearchQuery('aa');
    });
    flushDebounce();

    expect(result.current.searchMatches).toEqual([1, 3, 5]);
    expect(result.current.searchCurrentIdx).toBe(0);

    act(() => {
      result.current.nextMatch();
    });
    expect(result.current.searchCurrentIdx).toBe(1);

    act(() => {
      result.current.nextMatch();
    });
    expect(result.current.searchCurrentIdx).toBe(2);

    // Wrap around
    act(() => {
      result.current.nextMatch();
    });
    expect(result.current.searchCurrentIdx).toBe(0);
  });

  it('should navigate to previous match cyclically', () => {
    const content = 'aa\nbb\naa\ncc\naa';
    const { result } = renderHook(() => useFileContentSearch(content));

    act(() => {
      result.current.setSearchQuery('aa');
    });
    flushDebounce();

    expect(result.current.searchCurrentIdx).toBe(0);

    // Wrap around to last
    act(() => {
      result.current.prevMatch();
    });
    expect(result.current.searchCurrentIdx).toBe(2);

    act(() => {
      result.current.prevMatch();
    });
    expect(result.current.searchCurrentIdx).toBe(1);
  });

  it('should do nothing on nextMatch/prevMatch when no matches', () => {
    const { result } = renderHook(() => useFileContentSearch('hello'));

    act(() => {
      result.current.setSearchQuery('xyz');
    });
    flushDebounce();

    expect(result.current.searchMatches).toEqual([]);

    act(() => {
      result.current.nextMatch();
      result.current.prevMatch();
    });

    expect(result.current.searchCurrentIdx).toBe(0);
  });

  it('should reset searchCurrentIdx when query changes', () => {
    const content = 'aa bb\ncc dd\naa ee';
    const { result } = renderHook(() => useFileContentSearch(content));

    act(() => {
      result.current.setSearchQuery('aa');
    });
    flushDebounce();
    act(() => {
      result.current.nextMatch();
    });
    expect(result.current.searchCurrentIdx).toBe(1);

    act(() => {
      result.current.setSearchQuery('cc');
    });
    flushDebounce();
    expect(result.current.searchCurrentIdx).toBe(0);
  });

  // [Issue #723] Debounce-specific tests
  describe('debounce (Issue #723)', () => {
    it('does not update searchMatches before debounce elapses', () => {
      const content = 'aa\nbb\naa';
      const { result } = renderHook(() => useFileContentSearch(content));

      act(() => {
        result.current.setSearchQuery('aa');
      });

      // Immediately after setSearchQuery (no time advanced) matches are still empty.
      expect(result.current.searchMatches).toEqual([]);

      // After full debounce delay, matches arrive.
      flushDebounce();
      expect(result.current.searchMatches).toEqual([1, 3]);
    });

    it('coalesces rapid keystrokes into a single search (debounce reset)', () => {
      const content = 'apple\nbanana\napricot';
      const { result } = renderHook(() => useFileContentSearch(content));

      act(() => {
        result.current.setSearchQuery('ap');
      });
      act(() => {
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50);
      });
      // Still no matches because new keystroke restarts the debounce.
      act(() => {
        result.current.setSearchQuery('appl');
      });
      // Only advancing the previous (now-stale) remainder shouldn't fire either.
      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(result.current.searchMatches).toEqual([]);

      // Full debounce after the latest keystroke runs the search for 'appl'.
      act(() => {
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
      });
      expect(result.current.searchMatches).toEqual([1]);
    });
  });
});
