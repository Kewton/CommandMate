/**
 * useFileSearch Hook
 * [Issue #21] File tree search functionality
 *
 * Provides state management for file search with:
 * - Debounced query updates
 * - Name search (client-side filtering)
 * - Content search (server-side API call)
 * - Error handling
 * - Loading state
 */

'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { SearchMode, SearchResult, TreeItem } from '@/types/models';
import { debounce, computeMatchedPaths } from '@/lib/utils';

// ============================================================================
// Constants
// ============================================================================

/**
 * Debounce delay for search input (300ms)
 */
const SEARCH_DEBOUNCE_MS = 300;

// ============================================================================
// Types
// ============================================================================

export interface UseFileSearchOptions {
  /** Worktree ID for API calls */
  worktreeId: string;
  /** Initial search mode */
  initialMode?: SearchMode;
  /** Debounce delay in ms (default: 300) */
  debounceMs?: number;
}

export interface UseFileSearchReturn {
  /** Current search query */
  query: string;
  /** Current search mode */
  mode: SearchMode;
  /** Whether a search is in progress */
  isSearching: boolean;
  /** Search results (for content search) */
  results: SearchResult | null;
  /** Error message if search failed */
  error: string | null;
  /** Set search query (debounced) */
  setQuery: (query: string) => void;
  /** Set search mode */
  setMode: (mode: SearchMode) => void;
  /** Clear search state */
  clearSearch: () => void;
  /** Filter tree items by name (client-side) */
  filterByName: (items: TreeItem[]) => TreeItem[];
  /** Get matched file paths (for auto-expansion) */
  getMatchedPaths: () => Set<string>;
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * File search hook for managing search state
 *
 * @param options - Hook options
 * @returns Search state and controls
 *
 * @example
 * ```tsx
 * const {
 *   query, mode, isSearching, results, error,
 *   setQuery, setMode, clearSearch, filterByName
 * } = useFileSearch({ worktreeId: 'my-worktree' });
 * ```
 */
export function useFileSearch(options: UseFileSearchOptions): UseFileSearchReturn {
  const { worktreeId, initialMode = 'name', debounceMs = SEARCH_DEBOUNCE_MS } = options;

  // State
  const [query, setQueryState] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>(initialMode);
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refs for cleanup
  const abortControllerRef = useRef<AbortController | null>(null);

  // Debounced query setter
  const debouncedSetQuery = useMemo(
    () =>
      debounce((newQuery: string) => {
        setDebouncedQuery(newQuery);
      }, debounceMs),
    [debounceMs]
  );

  /**
   * Set query with debouncing
   */
  const setQuery = useCallback(
    (newQuery: string) => {
      setQueryState(newQuery);
      debouncedSetQuery(newQuery);
      // Clear error when query changes
      setError(null);
    },
    [debouncedSetQuery]
  );

  /**
   * Clear all search state
   */
  const clearSearch = useCallback(() => {
    setQueryState('');
    setDebouncedQuery('');
    setResults(null);
    setError(null);
    setIsSearching(false);

    // Cancel any pending API call
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  /**
   * Filter tree items by name (client-side)
   * Case-insensitive substring match
   */
  const filterByName = useCallback(
    (items: TreeItem[]): TreeItem[] => {
      if (!debouncedQuery.trim()) {
        return items;
      }

      const lowerQuery = debouncedQuery.toLowerCase();

      return items.filter((item) => item.name.toLowerCase().includes(lowerQuery));
    },
    [debouncedQuery]
  );

  /**
   * Get set of file paths that match (for content search)
   * Used to auto-expand parent directories in tree view
   * [DRY] Uses shared computeMatchedPaths utility
   */
  const getMatchedPaths = useCallback((): Set<string> => {
    if (!results || results.results.length === 0) {
      return new Set();
    }

    return computeMatchedPaths(results.results.map((item) => item.filePath));
  }, [results]);

  /**
   * Fetch content search results from API
   */
  useEffect(() => {
    // Only run for content mode with a non-empty query
    if (mode !== 'content' || !debouncedQuery.trim()) {
      setResults(null);
      return;
    }

    // Cancel previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new abort controller
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const fetchResults = async () => {
      setIsSearching(true);
      setError(null);

      try {
        const response = await fetch(
          `/api/worktrees/${encodeURIComponent(worktreeId)}/search?q=${encodeURIComponent(debouncedQuery)}&mode=content`,
          { signal: controller.signal }
        );

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error?.message || `Search failed: ${response.status}`);
        }

        const data = await response.json();

        if (data.success) {
          setResults({
            mode: 'content',
            query: debouncedQuery,
            results: data.results,
            totalMatches: data.totalMatches,
            truncated: data.truncated,
            executionTimeMs: data.executionTimeMs,
          });
        } else {
          throw new Error(data.error?.message || 'Search failed');
        }
      } catch (err) {
        // Ignore abort errors
        if (err instanceof Error && err.name === 'AbortError') {
          return;
        }

        setError(err instanceof Error ? err.message : 'An error occurred while searching');
        setResults(null);
      } finally {
        setIsSearching(false);
      }
    };

    fetchResults();

    // Cleanup
    return () => {
      controller.abort();
    };
  }, [mode, debouncedQuery, worktreeId]);

  // Clear results when switching to name mode
  useEffect(() => {
    if (mode === 'name') {
      setResults(null);
      setIsSearching(false);
      setError(null);
    }
  }, [mode]);

  return {
    query,
    mode,
    isSearching,
    results,
    error,
    setQuery,
    setMode,
    clearSearch,
    filterByName,
    getMatchedPaths,
  };
}
