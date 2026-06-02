/**
 * useMemoSearch Hook
 * [Issue #787] Memo title/content text search state management
 *
 * Responsibilities:
 *   - Maintain search query and debounce input changes (IME-aware).
 *   - Filter `WorktreeMemo[]` to those whose title OR content matches the query.
 *   - Expose navigation (next/prev) over the matched memos with wraparound.
 *
 * Security annotations:
 *   SEC-MS-001: indexOf only (no RegExp - prevents ReDoS)
 *   SEC-MS-004: Minimum 2-char query enforced (DoS prevention)
 *
 * Design notes:
 *   - Memo-level hit only: unlike useHistorySearch this hook does NOT compute
 *     in-text MatchPosition/ranges, because MemoCard renders title/content in
 *     editable <input>/<textarea> elements that the CSS Custom Highlight API
 *     cannot target. The consumer (MemoPane) filters the list and scrolls to
 *     the current match via a `data-memo-id` anchor instead.
 *   - Mirrors useHistorySearch's debounce/IME structure (SEARCH_DEBOUNCE_MS /
 *     SEARCH_MIN_QUERY_LENGTH shared from useTerminalSearch).
 */

'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_QUERY_LENGTH,
} from '@/hooks/useTerminalSearch';
import type { WorktreeMemo } from '@/types/models';

export interface UseMemoSearchOptions {
  /** Search-target memos (caller passes the full memo list). */
  memos: WorktreeMemo[];
}

export interface UseMemoSearchReturn {
  /** Current (raw) search query string */
  query: string;
  /** Memos whose title OR content matches the debounced query */
  matches: WorktreeMemo[];
  /** Index of the currently focused match within `matches` (-1 when empty) */
  currentMatch: number;
  /** Total number of matched memos (alias of matches.length) */
  totalCount: number;
  /** Update the search query (debounced, IME-aware) */
  setQuery: (q: string) => void;
  /** Clear the query and matches */
  reset: () => void;
  /** Move to the next match (wraps around); no-op when empty */
  navigateNext: () => void;
  /** Move to the previous match (wraps around); no-op when empty */
  navigatePrev: () => void;
  /** Called when IME composition starts */
  onCompositionStart: () => void;
  /** Called when IME composition ends */
  onCompositionEnd: () => void;
}

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * Filter memos whose title OR content contains `query`.
 * SEC-MS-001: indexOf only (no RegExp). SEC-MS-004: minimum query length.
 */
function findMemoMatches(memos: WorktreeMemo[], query: string): WorktreeMemo[] {
  if (query.length < SEARCH_MIN_QUERY_LENGTH || memos.length === 0) {
    return [];
  }
  const lowerQuery = query.toLowerCase();
  return memos.filter(
    (m) =>
      m.title.toLowerCase().indexOf(lowerQuery) !== -1 ||
      m.content.toLowerCase().indexOf(lowerQuery) !== -1
  );
}

/**
 * Build a stable fingerprint for the memos array so that an unchanged payload
 * (same ids/titles/contents in the same order) does not re-run the filter.
 */
function memosFingerprint(memos: WorktreeMemo[]): string {
  if (memos.length === 0) return '0';
  return memos
    .map((m) => `${m.id}:${m.title.length}:${m.content.length}`)
    .join('|');
}

// ============================================================================
// Hook
// ============================================================================

export function useMemoSearch({ memos }: UseMemoSearchOptions): UseMemoSearchReturn {
  const [query, setQueryState] = useState('');
  const [matches, setMatches] = useState<WorktreeMemo[]>([]);
  const [currentMatch, setCurrentMatch] = useState(-1);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedQueryRef = useRef('');
  const composingRef = useRef(false);
  const prevFingerprintRef = useRef<string>(memosFingerprint(memos));
  const memosRef = useRef<WorktreeMemo[]>(memos);
  memosRef.current = memos;

  const totalCount = matches.length;

  /** Cancel any pending debounced search. Idempotent. */
  const clearDebounceTimer = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  /** Execute search synchronously using the latest memos snapshot. */
  const runSearch = useCallback((searchQuery: string) => {
    const result = findMemoMatches(memosRef.current, searchQuery);
    setMatches(result);
    setCurrentMatch(result.length > 0 ? 0 : -1);
  }, []);

  /** Schedule a debounced search, skipping while IME composition is active. */
  const scheduleSearch = useCallback(
    (q: string) => {
      clearDebounceTimer();
      debouncedQueryRef.current = q;
      if (composingRef.current) return;
      debounceRef.current = setTimeout(() => {
        runSearch(q);
      }, SEARCH_DEBOUNCE_MS);
    },
    [clearDebounceTimer, runSearch]
  );

  const setQuery = useCallback(
    (q: string) => {
      setQueryState(q);
      scheduleSearch(q);
    },
    [scheduleSearch]
  );

  const reset = useCallback(() => {
    setQueryState('');
    debouncedQueryRef.current = '';
    setMatches([]);
    setCurrentMatch(-1);
    clearDebounceTimer();
  }, [clearDebounceTimer]);

  const navigateNext = useCallback(() => {
    setCurrentMatch((prev) => {
      if (totalCount === 0) return -1;
      return (prev + 1) % totalCount;
    });
  }, [totalCount]);

  const navigatePrev = useCallback(() => {
    setCurrentMatch((prev) => {
      if (totalCount === 0) return -1;
      return (prev - 1 + totalCount) % totalCount;
    });
  }, [totalCount]);

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
    clearDebounceTimer();
  }, [clearDebounceTimer]);

  const onCompositionEnd = useCallback(() => {
    composingRef.current = false;
    const q = debouncedQueryRef.current;
    if (q.length >= SEARCH_MIN_QUERY_LENGTH) {
      clearDebounceTimer();
      debounceRef.current = setTimeout(() => {
        runSearch(q);
      }, SEARCH_DEBOUNCE_MS);
    }
  }, [clearDebounceTimer, runSearch]);

  // Re-run search when the memos payload changes substantively.
  useEffect(() => {
    const fp = memosFingerprint(memos);
    if (fp === prevFingerprintRef.current) return;
    prevFingerprintRef.current = fp;
    const q = debouncedQueryRef.current;
    if (q.length >= SEARCH_MIN_QUERY_LENGTH) {
      runSearch(q);
    }
  }, [memos, runSearch]);

  // Unmount cleanup (debounce + ref scrubbing).
  useEffect(() => {
    return () => {
      clearDebounceTimer();
      debouncedQueryRef.current = '';
    };
  }, [clearDebounceTimer]);

  return {
    query,
    matches,
    currentMatch,
    totalCount,
    setQuery,
    reset,
    navigateNext,
    navigatePrev,
    onCompositionStart,
    onCompositionEnd,
  };
}
