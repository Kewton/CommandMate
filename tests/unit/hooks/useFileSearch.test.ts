/**
 * useFileSearch Hook Tests
 * [Issue #21] File tree search functionality
 *
 * Tests for:
 * - Query state management
 * - Mode switching
 * - Client-side name filtering
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileSearch } from '@/hooks/useFileSearch';
import type { TreeItem } from '@/types/models';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('useFileSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ============================================================================
  // Initial State Tests
  // ============================================================================

  describe('Initial State', () => {
    it('should have empty query initially', () => {
      const { result } = renderHook(() => useFileSearch({ worktreeId: 'test' }));
      expect(result.current.query).toBe('');
    });

    it('should default to name mode', () => {
      const { result } = renderHook(() => useFileSearch({ worktreeId: 'test' }));
      expect(result.current.mode).toBe('name');
    });

    it('should use initialMode when provided', () => {
      const { result } = renderHook(() =>
        useFileSearch({ worktreeId: 'test', initialMode: 'content' })
      );
      expect(result.current.mode).toBe('content');
    });

    it('should not be searching initially', () => {
      const { result } = renderHook(() => useFileSearch({ worktreeId: 'test' }));
      expect(result.current.isSearching).toBe(false);
    });

    it('should have null results initially', () => {
      const { result } = renderHook(() => useFileSearch({ worktreeId: 'test' }));
      expect(result.current.results).toBeNull();
    });

    it('should have no error initially', () => {
      const { result } = renderHook(() => useFileSearch({ worktreeId: 'test' }));
      expect(result.current.error).toBeNull();
    });
  });

  // ============================================================================
  // Query State Tests
  // ============================================================================

  describe('Query State', () => {
    it('should update query immediately', () => {
      const { result } = renderHook(() => useFileSearch({ worktreeId: 'test' }));

      act(() => {
        result.current.setQuery('hello');
      });

      expect(result.current.query).toBe('hello');
    });

    it('should clear query with clearSearch', () => {
      const { result } = renderHook(() => useFileSearch({ worktreeId: 'test' }));

      act(() => {
        result.current.setQuery('hello');
      });

      act(() => {
        result.current.clearSearch();
      });

      expect(result.current.query).toBe('');
    });
  });

  // ============================================================================
  // Mode Switching Tests
  // ============================================================================

  describe('Mode Switching', () => {
    it('should switch mode', () => {
      const { result } = renderHook(() => useFileSearch({ worktreeId: 'test' }));

      act(() => {
        result.current.setMode('content');
      });

      expect(result.current.mode).toBe('content');
    });

    it('should clear results when switching to name mode', () => {
      const { result } = renderHook(() =>
        useFileSearch({ worktreeId: 'test', initialMode: 'content' })
      );

      act(() => {
        result.current.setMode('name');
      });

      expect(result.current.results).toBeNull();
    });
  });

  // ============================================================================
  // Client-side Name Filtering Tests
  // ============================================================================

  describe('filterByName', () => {
    const testItems: TreeItem[] = [
      { name: 'index.ts', type: 'file' },
      { name: 'index.test.ts', type: 'file' },
      { name: 'components', type: 'directory' },
      { name: 'README.md', type: 'file' },
    ];

    it('should return all items when query is empty', () => {
      const { result } = renderHook(() => useFileSearch({ worktreeId: 'test' }));

      const filtered = result.current.filterByName(testItems);

      expect(filtered).toHaveLength(4);
    });

    it('should filter items by name after debounce', () => {
      const { result } = renderHook(() =>
        useFileSearch({ worktreeId: 'test', debounceMs: 100 })
      );

      act(() => {
        result.current.setQuery('index');
      });

      // Before debounce - should still return all (debounced query is empty)
      let filtered = result.current.filterByName(testItems);
      expect(filtered).toHaveLength(4);

      // After debounce
      act(() => {
        vi.advanceTimersByTime(100);
      });

      filtered = result.current.filterByName(testItems);
      expect(filtered).toHaveLength(2);
      expect(filtered.map((i) => i.name)).toContain('index.ts');
      expect(filtered.map((i) => i.name)).toContain('index.test.ts');
    });

    it('should handle case-insensitive matching', () => {
      const { result } = renderHook(() =>
        useFileSearch({ worktreeId: 'test', debounceMs: 0 })
      );

      act(() => {
        result.current.setQuery('README');
        vi.advanceTimersByTime(1);
      });

      const filtered = result.current.filterByName(testItems);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe('README.md');
    });

    it('should return empty array when no matches', () => {
      const { result } = renderHook(() =>
        useFileSearch({ worktreeId: 'test', debounceMs: 0 })
      );

      act(() => {
        result.current.setQuery('nonexistent');
        vi.advanceTimersByTime(1);
      });

      const filtered = result.current.filterByName(testItems);

      expect(filtered).toHaveLength(0);
    });
  });

  // ============================================================================
  // Content Search - Basic Tests
  // ============================================================================

  describe('Content Search', () => {
    it('should not call API in name mode', () => {
      renderHook(() => useFileSearch({ worktreeId: 'test', debounceMs: 0 }));

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should not call API when query is empty in content mode', () => {
      renderHook(() =>
        useFileSearch({ worktreeId: 'test', initialMode: 'content', debounceMs: 0 })
      );

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // getMatchedPaths Tests
  // ============================================================================

  describe('getMatchedPaths', () => {
    it('should return empty set when no results', () => {
      const { result } = renderHook(() => useFileSearch({ worktreeId: 'test' }));

      const paths = result.current.getMatchedPaths();

      expect(paths.size).toBe(0);
    });
  });

  // ============================================================================
  // Clear Search Tests
  // ============================================================================

  describe('clearSearch', () => {
    it('should reset query and state', () => {
      const { result } = renderHook(() => useFileSearch({ worktreeId: 'test' }));

      act(() => {
        result.current.setQuery('test');
      });

      expect(result.current.query).toBe('test');

      act(() => {
        result.current.clearSearch();
      });

      expect(result.current.query).toBe('');
      expect(result.current.results).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.isSearching).toBe(false);
    });
  });

  // ============================================================================
  // Debounce Tests
  // ============================================================================

  describe('Debouncing', () => {
    it('should debounce query updates', () => {
      const { result } = renderHook(() =>
        useFileSearch({ worktreeId: 'test', debounceMs: 300 })
      );

      act(() => {
        result.current.setQuery('a');
      });
      act(() => {
        result.current.setQuery('ab');
      });
      act(() => {
        result.current.setQuery('abc');
      });

      // Query should update immediately
      expect(result.current.query).toBe('abc');

      // But filtering should use debounced value
      const items: TreeItem[] = [{ name: 'abc.ts', type: 'file' }];
      let filtered = result.current.filterByName(items);

      // Before debounce timeout, debounced query is still empty
      expect(filtered).toHaveLength(1); // Returns all when debounced query is empty

      // After debounce
      act(() => {
        vi.advanceTimersByTime(300);
      });

      filtered = result.current.filterByName(items);
      expect(filtered).toHaveLength(1);
    });
  });
});
