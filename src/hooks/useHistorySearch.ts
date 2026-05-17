/**
 * useHistorySearch Hook
 * [Issue #716] History text search state management
 *
 * Responsibilities:
 *   - Maintain search query and debounce input changes (IME-aware).
 *   - Compute per-message match positions against `ChatMessage[]`.
 *   - Expose navigation (next/prev), match count, and the currently focused
 *     match resolved to {messageId, localIndex}.
 *
 * Security annotations:
 *   SEC-TS-001: indexOf only (no RegExp - prevents ReDoS)
 *   SEC-TS-004: Minimum 2-char query enforced (DoS prevention)
 *
 * Design notes:
 *   - Does NOT take a containerRef. DOM/highlight operations are the
 *     responsibility of `HistoryPane` (DR2-003 / design policy §6.1).
 *   - `messages` dependency is fingerprinted by length + last id + last
 *     timestamp to avoid re-computing when polling produces an identical
 *     payload with a fresh array reference (design policy §8.1).
 */

'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  TERMINAL_SEARCH_MAX_MATCHES,
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_QUERY_LENGTH,
} from '@/hooks/useTerminalSearch';
import type { MatchPosition } from '@/lib/terminal-highlight';
import type { ChatMessage } from '@/types/models';

/**
 * Per-message search hit aggregate.
 * `ranges` are offsets into `message.content` (kept aligned with the DOM
 * `textContent` of the corresponding `[data-message-id]` element).
 */
export interface HistoryMatch {
  messageId: string;
  ranges: MatchPosition[];
}

export interface UseHistorySearchOptions {
  /** Search-target messages (caller is expected to pre-filter archived/empty). */
  messages: ChatMessage[];
}

export interface UseHistorySearchReturn {
  isOpen: boolean;
  query: string;
  matchCount: number;
  currentIndex: number;
  isAtMaxMatches: boolean;
  matchPositions: HistoryMatch[];
  currentMatch: { messageId: string; localIndex: number } | null;
  openSearch: () => void;
  closeSearch: () => void;
  setQuery: (q: string) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  nextMatch: () => void;
  prevMatch: () => void;
}

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * Compute all matches for `query` against the provided messages.
 * Stops once the global match count reaches the cap; `capped=true` is
 * returned when at least one further match would have been found.
 */
function findMatches(
  messages: ChatMessage[],
  query: string
): { positions: HistoryMatch[]; capped: boolean } {
  if (query.length < SEARCH_MIN_QUERY_LENGTH || messages.length === 0) {
    return { positions: [], capped: false };
  }

  const lowerQuery = query.toLowerCase();
  const queryLen = query.length;
  const positions: HistoryMatch[] = [];
  let total = 0;
  let capped = false;

  for (const message of messages) {
    if (capped) break;
    const content = message.content;
    if (!content) continue;
    const lowerContent = content.toLowerCase();
    const ranges: MatchPosition[] = [];
    let cursor = 0;
    while (true) {
      const idx = lowerContent.indexOf(lowerQuery, cursor);
      if (idx === -1) break;
      ranges.push({ start: idx, end: idx + queryLen });
      cursor = idx + 1;
      total += 1;
      if (total >= TERMINAL_SEARCH_MAX_MATCHES) {
        // Detect whether at least one more match exists, anywhere.
        if (lowerContent.indexOf(lowerQuery, cursor) !== -1) {
          capped = true;
        } else {
          // Look ahead in the remaining messages.
          const remainingIdx = messages.indexOf(message) + 1;
          for (let j = remainingIdx; j < messages.length; j++) {
            const c = messages[j].content;
            if (c && c.toLowerCase().indexOf(lowerQuery) !== -1) {
              capped = true;
              break;
            }
          }
        }
        break;
      }
    }
    if (ranges.length > 0) positions.push({ messageId: message.id, ranges });
  }

  return { positions, capped };
}

/**
 * Resolve a global linear index to {messageId, localIndex} within the
 * appropriate message. Returns null if no match is currently selectable.
 */
function resolveCurrentMatch(
  matches: HistoryMatch[],
  globalIndex: number
): { messageId: string; localIndex: number } | null {
  if (matches.length === 0 || globalIndex < 0) return null;
  let cursor = 0;
  for (const m of matches) {
    if (globalIndex < cursor + m.ranges.length) {
      return { messageId: m.messageId, localIndex: globalIndex - cursor };
    }
    cursor += m.ranges.length;
  }
  return null;
}

/**
 * Build a stable fingerprint for the messages array. Polling layers tend to
 * regenerate the array reference on every tick with identical content; this
 * fingerprint lets us memoize search dependencies cheaply.
 */
function messagesFingerprint(messages: ChatMessage[]): string {
  if (messages.length === 0) return '0';
  const last = messages[messages.length - 1];
  const ts = last.timestamp instanceof Date ? last.timestamp.getTime() : String(last.timestamp);
  return `${messages.length}|${last.id}|${ts}`;
}

// ============================================================================
// Hook
// ============================================================================

export function useHistorySearch({
  messages,
}: UseHistorySearchOptions): UseHistorySearchReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [matchPositions, setMatchPositions] = useState<HistoryMatch[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isAtMaxMatches, setIsAtMaxMatches] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedQueryRef = useRef('');
  const composingRef = useRef(false);
  const prevFingerprintRef = useRef<string>(messagesFingerprint(messages));
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;

  const matchCount = matchPositions.reduce((acc, m) => acc + m.ranges.length, 0);

  const currentMatch = useMemo(
    () => resolveCurrentMatch(matchPositions, currentIndex),
    [matchPositions, currentIndex]
  );

  /** Cancel any pending debounced search. Idempotent. */
  const clearDebounceTimer = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  /** Execute search synchronously using the latest messages snapshot. */
  const runSearch = useCallback((searchQuery: string) => {
    const { positions, capped } = findMatches(messagesRef.current, searchQuery);
    setMatchPositions(positions);
    setCurrentIndex(0);
    setIsAtMaxMatches(capped);
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

  const openSearch = useCallback(() => {
    setIsOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    setIsOpen(false);
    setQueryState('');
    debouncedQueryRef.current = '';
    setMatchPositions([]);
    setCurrentIndex(0);
    setIsAtMaxMatches(false);
    clearDebounceTimer();
  }, [clearDebounceTimer]);

  const nextMatch = useCallback(() => {
    setCurrentIndex((prev) => {
      if (matchCount === 0) return 0;
      return (prev + 1) % matchCount;
    });
  }, [matchCount]);

  const prevMatch = useCallback(() => {
    setCurrentIndex((prev) => {
      if (matchCount === 0) return 0;
      return (prev - 1 + matchCount) % matchCount;
    });
  }, [matchCount]);

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
    clearDebounceTimer();
  }, [clearDebounceTimer]);

  const onCompositionEnd = useCallback(() => {
    composingRef.current = false;
    // Resume debounce using whatever query was last typed. Short queries are
    // skipped here as an optimization: findMatches would short-circuit anyway,
    // but avoiding the timer keeps the test clock and event loop quieter.
    const q = debouncedQueryRef.current;
    if (q.length >= SEARCH_MIN_QUERY_LENGTH) {
      clearDebounceTimer();
      debounceRef.current = setTimeout(() => {
        runSearch(q);
      }, SEARCH_DEBOUNCE_MS);
    }
  }, [clearDebounceTimer, runSearch]);

  // Re-run search when the messages payload changes substantively (length
  // / last id / last timestamp). Stable polling payloads do not trigger.
  useEffect(() => {
    const fp = messagesFingerprint(messages);
    if (fp === prevFingerprintRef.current) return;
    prevFingerprintRef.current = fp;
    const q = debouncedQueryRef.current;
    if (q.length >= SEARCH_MIN_QUERY_LENGTH) {
      runSearch(q);
    }
  }, [messages, runSearch]);

  // Unmount cleanup (debounce + ref scrubbing for privacy).
  useEffect(() => {
    return () => {
      clearDebounceTimer();
      debouncedQueryRef.current = '';
    };
  }, [clearDebounceTimer]);

  return {
    isOpen,
    query,
    matchCount,
    currentIndex,
    isAtMaxMatches,
    matchPositions,
    currentMatch,
    openSearch,
    closeSearch,
    setQuery,
    onCompositionStart,
    onCompositionEnd,
    nextMatch,
    prevMatch,
  };
}
