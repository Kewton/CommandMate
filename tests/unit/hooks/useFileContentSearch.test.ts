/**
 * Unit Tests for useFileContentSearch hook
 *
 * Issue #469: Refactoring - DRY extraction of search logic
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileContentSearch } from '@/hooks/useFileContentSearch';

describe('useFileContentSearch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with search closed and empty state', () => {
    const { result } = renderHook(() => useFileContentSearch('line1\nline2'));

    expect(result.current.searchOpen).toBe(false);
    expect(result.current.searchQuery).toBe('');
    expect(result.current.searchMatches).toEqual([]);
    expect(result.current.searchCurrentIdx).toBe(0);
  });

  it('should open search and set searchOpen to true', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useFileContentSearch('line1\nline2'));

    act(() => {
      result.current.openSearch();
    });

    expect(result.current.searchOpen).toBe(true);
    vi.useRealTimers();
  });

  it('should close search and reset all state', () => {
    const { result } = renderHook(() => useFileContentSearch('hello world\nhello again'));

    act(() => {
      result.current.openSearch();
      result.current.setSearchQuery('hello');
    });

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

  it('should find matching lines (case-insensitive, 1-based line numbers)', () => {
    const content = 'Hello World\nfoo bar\nhello again\nbaz';
    const { result } = renderHook(() => useFileContentSearch(content));

    act(() => {
      result.current.setSearchQuery('hello');
    });

    expect(result.current.searchMatches).toEqual([1, 3]);
  });

  it('should not search if query is shorter than 2 characters', () => {
    const content = 'a\nb\nc';
    const { result } = renderHook(() => useFileContentSearch(content));

    act(() => {
      result.current.setSearchQuery('a');
    });

    expect(result.current.searchMatches).toEqual([]);
  });

  it('should return empty matches when content is undefined', () => {
    const { result } = renderHook(() => useFileContentSearch(undefined));

    act(() => {
      result.current.setSearchQuery('hello');
    });

    expect(result.current.searchMatches).toEqual([]);
  });

  it('should navigate to next match cyclically', () => {
    const content = 'aa\nbb\naa\ncc\naa';
    const { result } = renderHook(() => useFileContentSearch(content));

    act(() => {
      result.current.setSearchQuery('aa');
    });

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
    act(() => {
      result.current.nextMatch();
    });
    expect(result.current.searchCurrentIdx).toBe(1);

    act(() => {
      result.current.setSearchQuery('cc');
    });
    expect(result.current.searchCurrentIdx).toBe(0);
  });
});
