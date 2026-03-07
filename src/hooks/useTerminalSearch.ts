/**
 * useTerminalSearch Hook
 * [Issue #47] Terminal text search state management
 *
 * Security annotations:
 * SEC-TS-001: indexOf only (no RegExp - prevents ReDoS)
 * SEC-TS-003: Uses container.textContent as search source (DOM alignment)
 * SEC-TS-004: Minimum 2-char query enforced (DoS prevention)
 */

'use client';

import { useState, useCallback, useEffect, useRef, RefObject } from 'react';
import {
  applyTerminalHighlights,
  clearTerminalHighlights,
  type MatchPosition,
} from '@/lib/terminal-highlight';

/** Maximum number of matches to track (prevents UI freeze on large output) */
export const TERMINAL_SEARCH_MAX_MATCHES = 500;

/** Debounce delay for search input */
const DEBOUNCE_MS = 300;

export interface UseTerminalSearchOptions {
  /** Current terminal output text (used to detect output changes) */
  output: string;
  /** Ref to the terminal container DOM element */
  containerRef: RefObject<Element | null>;
}

export interface UseTerminalSearchReturn {
  /** Whether the search bar is currently open */
  isOpen: boolean;
  /** Current search query string */
  query: string;
  /** Number of matches found (capped at TERMINAL_SEARCH_MAX_MATCHES) */
  matchCount: number;
  /** 0-based index of the currently focused match */
  currentIndex: number;
  /** True when matchCount has been capped at TERMINAL_SEARCH_MAX_MATCHES */
  isAtMaxMatches: boolean;
  /** Open the search bar */
  openSearch: () => void;
  /** Close the search bar and clear state */
  closeSearch: () => void;
  /** Update the search query */
  setQuery: (q: string) => void;
  /** Move to the next match (wraps around) */
  nextMatch: () => void;
  /** Move to the previous match (wraps around) */
  prevMatch: () => void;
}

export function useTerminalSearch({
  output,
  containerRef,
}: UseTerminalSearchOptions): UseTerminalSearchReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [matchPositions, setMatchPositions] = useState<MatchPosition[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isAtMaxMatches, setIsAtMaxMatches] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedQueryRef = useRef('');

  const matchCount = matchPositions.length;

  /**
   * Find all matches of query in container.textContent.
   * SEC-TS-001: Uses indexOf only (no RegExp).
   * SEC-TS-003: Uses container.textContent as source.
   * SEC-TS-004: Requires minimum 2 characters.
   */
  const findMatches = useCallback(
    (searchQuery: string): { positions: MatchPosition[]; capped: boolean } => {
      if (searchQuery.length < 2 || !containerRef.current) {
        return { positions: [], capped: false };
      }

      const text = containerRef.current.textContent ?? '';
      const lowerText = text.toLowerCase();
      const lowerQuery = searchQuery.toLowerCase();
      const positions: MatchPosition[] = [];
      let pos = 0;

      while (positions.length < TERMINAL_SEARCH_MAX_MATCHES) {
        const idx = lowerText.indexOf(lowerQuery, pos);
        if (idx === -1) break;
        positions.push({ start: idx, end: idx + searchQuery.length });
        pos = idx + 1;
      }

      const capped = positions.length >= TERMINAL_SEARCH_MAX_MATCHES &&
        lowerText.indexOf(lowerQuery, pos) !== -1;

      return { positions, capped };
    },
    [containerRef]
  );

  /** Run search with current debounced query and update highlights */
  const runSearch = useCallback(
    (searchQuery: string) => {
      const { positions, capped } = findMatches(searchQuery);
      setMatchPositions(positions);
      setCurrentIndex(0);
      setIsAtMaxMatches(capped);

      if (containerRef.current) {
        if (positions.length > 0) {
          applyTerminalHighlights(containerRef.current, positions, 0);
        } else {
          clearTerminalHighlights();
        }
      }
    },
    [findMatches, containerRef]
  );

  /** Debounced query update */
  const setQuery = useCallback(
    (q: string) => {
      setQueryState(q);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debouncedQueryRef.current = q;

      debounceRef.current = setTimeout(() => {
        runSearch(q);
      }, DEBOUNCE_MS);
    },
    [runSearch]
  );

  /** Open the search bar */
  const openSearch = useCallback(() => {
    setIsOpen(true);
  }, []);

  /** Close the search bar, clear query and highlights */
  const closeSearch = useCallback(() => {
    setIsOpen(false);
    setQueryState('');
    debouncedQueryRef.current = '';
    setMatchPositions([]);
    setCurrentIndex(0);
    setIsAtMaxMatches(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    clearTerminalHighlights();
  }, []);

  /** Navigate to next match */
  const nextMatch = useCallback(() => {
    if (matchCount === 0) return;
    setCurrentIndex((prev) => {
      const next = (prev + 1) % matchCount;
      if (containerRef.current && matchPositions.length > 0) {
        applyTerminalHighlights(containerRef.current, matchPositions, next);
      }
      return next;
    });
  }, [matchCount, matchPositions, containerRef]);

  /** Navigate to previous match */
  const prevMatch = useCallback(() => {
    if (matchCount === 0) return;
    setCurrentIndex((prev) => {
      const next = (prev - 1 + matchCount) % matchCount;
      if (containerRef.current && matchPositions.length > 0) {
        applyTerminalHighlights(containerRef.current, matchPositions, next);
      }
      return next;
    });
  }, [matchCount, matchPositions, containerRef]);

  // Re-run search when output changes (new terminal content arrives)
  // Note: isOpen is intentionally NOT in deps to avoid firing when search opens
  // (debounce handles initial search after openSearch + setQuery)
  useEffect(() => {
    if (debouncedQueryRef.current.length < 2) return;
    runSearch(debouncedQueryRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output, runSearch]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      clearTerminalHighlights();
    };
  }, []);

  return {
    isOpen,
    query,
    matchCount,
    currentIndex,
    isAtMaxMatches,
    openSearch,
    closeSearch,
    setQuery,
    nextMatch,
    prevMatch,
  };
}
