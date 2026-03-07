/**
 * TerminalSearchBar Component
 * [Issue #47] Terminal text search UI
 *
 * Features:
 * - Search input with query binding
 * - Match count display (3/12 format, or "500以上" at limit)
 * - Prev / Next navigation buttons
 * - Close button
 * - Esc key to close
 * - aria-live for screen reader count updates
 */

'use client';

import React, { useRef, useEffect, useCallback } from 'react';
import { TERMINAL_SEARCH_MAX_MATCHES } from '@/hooks/useTerminalSearch';

export interface TerminalSearchBarProps {
  /** Current search query */
  query: string;
  /** Called when user types in the search input */
  onQueryChange: (q: string) => void;
  /** Total number of matches found */
  matchCount: number;
  /** 0-based index of the currently focused match */
  currentIndex: number;
  /** Called when user presses "next" */
  onNext: () => void;
  /** Called when user presses "prev" */
  onPrev: () => void;
  /** Called when user closes the search bar */
  onClose: () => void;
  /** Whether matchCount has been capped at the maximum */
  isAtMaxMatches?: boolean;
}

/**
 * Terminal search bar UI component.
 * Focuses the input automatically on mount.
 */
export function TerminalSearchBar({
  query,
  onQueryChange,
  matchCount,
  currentIndex,
  onNext,
  onPrev,
  onClose,
  isAtMaxMatches = false,
}: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input on open
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        onClose();
      }
    },
    [onClose]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onQueryChange(e.target.value);
    },
    [onQueryChange]
  );

  // Build the count display string
  const countDisplay = (() => {
    if (matchCount === 0) return '0/0';
    if (isAtMaxMatches) return `${currentIndex + 1}/${TERMINAL_SEARCH_MAX_MATCHES}以上`;
    return `${currentIndex + 1}/${matchCount}`;
  })();

  return (
    <div
      className="flex items-center gap-1 px-2 py-1 bg-gray-800 border border-gray-600 rounded shadow-lg"
      role="search"
      aria-label="ターミナル内テキスト検索"
    >
      {/* Search input */}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="検索..."
        className="bg-transparent text-gray-200 text-sm outline-none w-32 sm:w-40 placeholder-gray-500"
        aria-label="検索キーワード"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />

      {/* Match count - aria-live for screen reader updates */}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="text-gray-400 text-xs min-w-[3rem] text-right"
      >
        {countDisplay}
      </span>

      {/* Prev button */}
      <button
        onClick={onPrev}
        disabled={matchCount === 0}
        aria-label="前の結果"
        className="text-gray-300 hover:text-white disabled:text-gray-600 min-w-[36px] min-h-[36px] flex items-center justify-center text-base"
      >
        ▲
      </button>

      {/* Next button */}
      <button
        onClick={onNext}
        disabled={matchCount === 0}
        aria-label="次の結果"
        className="text-gray-300 hover:text-white disabled:text-gray-600 min-w-[36px] min-h-[36px] flex items-center justify-center text-base"
      >
        ▼
      </button>

      {/* Close button */}
      <button
        onClick={onClose}
        aria-label="検索を閉じる"
        className="text-gray-400 hover:text-white min-w-[36px] min-h-[36px] flex items-center justify-center text-base ml-1"
      >
        ✕
      </button>
    </div>
  );
}

export default TerminalSearchBar;
