/**
 * useFileContentSearch Hook
 *
 * Encapsulates file content search state and logic.
 * Extracted from FilePanelContent.tsx to eliminate duplication
 * between MarkdownWithSearch and CodeViewerWithSearch components.
 *
 * Issue #469: Refactoring - DRY extraction
 * Issue #723: Debounce + minimum-2-char query unified with TerminalSearchBar (Issue #47/#716)
 */

'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_QUERY_LENGTH,
} from '@/hooks/useTerminalSearch';

/** Delay before focusing search input (ms) */
const SEARCH_FOCUS_DELAY_MS = 50;

export interface UseFileContentSearchReturn {
  /** Whether the search bar is visible */
  searchOpen: boolean;
  /** Current search query */
  searchQuery: string;
  /** Line numbers of matching lines (1-based) */
  searchMatches: number[];
  /** Index of the currently highlighted match */
  searchCurrentIdx: number;
  /** Ref for the search input element */
  searchInputRef: React.RefObject<HTMLInputElement>;
  /** Open the search bar and focus input */
  openSearch: () => void;
  /** Close the search bar and reset state */
  closeSearch: () => void;
  /** Navigate to the next match */
  nextMatch: () => void;
  /** Navigate to the previous match */
  prevMatch: () => void;
  /** Update the search query */
  setSearchQuery: (query: string) => void;
}

/**
 * Custom hook for file content search.
 *
 * Performs case-insensitive line-by-line search on the provided content.
 * Returns 1-based line numbers of matching lines.
 *
 * @param content - The file content string to search within
 */
export function useFileContentSearch(content: string | undefined): UseFileContentSearchReturn {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // [Issue #723] Separate "debounced" query that drives the actual line scan,
  // independent from the user-visible `searchQuery`. Bouncing only the scan
  // prevents full-file split('\n') + toLowerCase() on every keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<number[]>([]);
  const [searchCurrentIdx, setSearchCurrentIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null) as React.RefObject<HTMLInputElement>;
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), SEARCH_FOCUS_DELAY_MS);
  }, []);

  const clearDebounceTimer = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setDebouncedQuery('');
    setSearchMatches([]);
    setSearchCurrentIdx(0);
    clearDebounceTimer();
  }, [clearDebounceTimer]);

  // [Issue #723] Debounce the query. Queries shorter than the minimum length
  // bypass the timer and clear results immediately for snappy backspacing.
  useEffect(() => {
    if (!searchQuery || searchQuery.length < SEARCH_MIN_QUERY_LENGTH) {
      setDebouncedQuery('');
      clearDebounceTimer();
      return;
    }
    clearDebounceTimer();
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, SEARCH_DEBOUNCE_MS);
    return clearDebounceTimer;
  }, [searchQuery, clearDebounceTimer]);

  // Find matching lines based on the debounced query
  useEffect(() => {
    if (!debouncedQuery || debouncedQuery.length < SEARCH_MIN_QUERY_LENGTH || !content) {
      setSearchMatches([]);
      setSearchCurrentIdx(0);
      return;
    }
    const lines = content.split('\n');
    const lowerQuery = debouncedQuery.toLowerCase();
    const matches: number[] = [];
    lines.forEach((line, idx) => {
      if (line.toLowerCase().includes(lowerQuery)) {
        matches.push(idx + 1);
      }
    });
    setSearchMatches(matches);
    setSearchCurrentIdx(0);
  }, [debouncedQuery, content]);

  const nextMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    setSearchCurrentIdx((prev) => (prev + 1) % searchMatches.length);
  }, [searchMatches.length]);

  const prevMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    setSearchCurrentIdx((prev) => (prev - 1 + searchMatches.length) % searchMatches.length);
  }, [searchMatches.length]);

  return {
    searchOpen,
    searchQuery,
    searchMatches,
    searchCurrentIdx,
    searchInputRef,
    openSearch,
    closeSearch,
    nextMatch,
    prevMatch,
    setSearchQuery,
  };
}
