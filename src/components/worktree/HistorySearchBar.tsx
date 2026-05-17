/**
 * HistorySearchBar Component
 * [Issue #716] History text search UI
 *
 * Mirrors the visual/UX language of TerminalSearchBar (Issue #47) so the two
 * search bars feel native when they coexist on the same page, but uses a
 * separate ARIA label so screen readers can disambiguate them.
 */

'use client';

import React, { useRef, useEffect, useCallback } from 'react';
import { TERMINAL_SEARCH_MAX_MATCHES } from '@/hooks/useTerminalSearch';

export interface HistorySearchBarProps {
  /** Current search query */
  query: string;
  /** Called when the user types in the input */
  onQueryChange: (q: string) => void;
  /** Total number of matches across all messages (linearized count) */
  matchCount: number;
  /** 0-based global index of the currently focused match */
  currentIndex: number;
  /** Called when the user presses "next" */
  onNext: () => void;
  /** Called when the user presses "prev" */
  onPrev: () => void;
  /** Called when the user closes the search bar */
  onClose: () => void;
  /** True when matchCount has been capped at the maximum */
  isAtMaxMatches: boolean;
  /** Called when IME composition starts (from useHistorySearch) */
  onCompositionStart: () => void;
  /** Called when IME composition ends (from useHistorySearch) */
  onCompositionEnd: () => void;
}

export function HistorySearchBar({
  query,
  onQueryChange,
  matchCount,
  currentIndex,
  onNext,
  onPrev,
  onClose,
  isAtMaxMatches,
  onCompositionStart,
  onCompositionEnd,
}: HistorySearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

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

  const countDisplay = (() => {
    if (matchCount === 0) return '0/0';
    if (isAtMaxMatches) return `${currentIndex + 1}/${TERMINAL_SEARCH_MAX_MATCHES}以上`;
    return `${currentIndex + 1}/${matchCount}`;
  })();

  return (
    <div
      className="flex items-center gap-1 px-2 py-1 bg-gray-800 border border-gray-600 rounded shadow-lg"
      role="search"
      aria-label="履歴内テキスト検索"
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        placeholder="検索..."
        className="bg-transparent text-gray-200 text-sm outline-none w-32 sm:w-40 placeholder-gray-500"
        aria-label="検索キーワード"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />

      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="text-gray-400 text-xs min-w-[3rem] text-right"
      >
        {countDisplay}
      </span>

      <button
        type="button"
        onClick={onPrev}
        disabled={matchCount === 0}
        aria-label="前の結果 (prev)"
        className="text-gray-300 hover:text-white disabled:text-gray-600 min-w-[36px] min-h-[36px] flex items-center justify-center text-base"
      >
        ▲
      </button>

      <button
        type="button"
        onClick={onNext}
        disabled={matchCount === 0}
        aria-label="次の結果 (next)"
        className="text-gray-300 hover:text-white disabled:text-gray-600 min-w-[36px] min-h-[36px] flex items-center justify-center text-base"
      >
        ▼
      </button>

      <button
        type="button"
        onClick={onClose}
        aria-label="検索を閉じる (close)"
        className="text-gray-400 hover:text-white min-w-[36px] min-h-[36px] flex items-center justify-center text-base ml-1"
      >
        ✕
      </button>
    </div>
  );
}

export default HistorySearchBar;
