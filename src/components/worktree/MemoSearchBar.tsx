/**
 * MemoSearchBar Component
 * [Issue #787] Memo title/content text search UI
 *
 * Mirrors the structure/UX of HistorySearchBar (Issue #716) but:
 *   - filters the memo list rather than highlighting in-text (MemoCard renders
 *     title/content in editable <input>/<textarea> elements), so it does not
 *     surface a "max matches" cap.
 *   - Enter advances to the next match (in addition to the next button).
 */

'use client';

import React, { useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui';

export interface MemoSearchBarProps {
  /** Current search query */
  query: string;
  /** Called when the user types in the input */
  onQueryChange: (q: string) => void;
  /** Total number of matched memos */
  matchCount: number;
  /** 0-based index of the currently focused match */
  currentIndex: number;
  /** Called when the user presses "next" (button or Enter) */
  onNext: () => void;
  /** Called when the user presses "prev" */
  onPrev: () => void;
  /** Called when the user closes the search bar */
  onClose: () => void;
  /** Called when IME composition starts (from useMemoSearch) */
  onCompositionStart: () => void;
  /** Called when IME composition ends (from useMemoSearch) */
  onCompositionEnd: () => void;
}

export function MemoSearchBar({
  query,
  onQueryChange,
  matchCount,
  currentIndex,
  onNext,
  onPrev,
  onClose,
  onCompositionStart,
  onCompositionEnd,
}: MemoSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onNext();
      }
    },
    [onClose, onNext]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onQueryChange(e.target.value);
    },
    [onQueryChange]
  );

  // currentIndex is 0-based; show a 1-based position to the user.
  const countDisplay = matchCount === 0 ? '0/0' : `${currentIndex + 1}/${matchCount}`;

  return (
    <div
      className="flex items-center gap-1 px-2 py-1 bg-muted border border-input rounded"
      role="search"
      aria-label="Memo search"
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        placeholder="Search..."
        className="flex-1 min-w-0 bg-transparent text-foreground text-sm outline-none placeholder-muted-foreground"
        aria-label="Search memos"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />

      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="text-muted-foreground text-xs min-w-[3rem] text-right"
      >
        {countDisplay}
      </span>

      <Button
        variant="ghost"
        type="button"
        onClick={onPrev}
        disabled={matchCount === 0}
        aria-label="Previous match (prev)"
        className="text-muted-foreground hover:text-foreground dark:hover:text-white disabled:text-muted-foreground/50 min-w-[36px] min-h-[36px] flex items-center justify-center text-base"
      >
        ▲
      </Button>

      <Button
        variant="ghost"
        type="button"
        onClick={onNext}
        disabled={matchCount === 0}
        aria-label="Next match (next)"
        className="text-muted-foreground hover:text-foreground dark:hover:text-white disabled:text-muted-foreground/50 min-w-[36px] min-h-[36px] flex items-center justify-center text-base"
      >
        ▼
      </Button>

      <Button
        variant="ghost"
        type="button"
        onClick={onClose}
        aria-label="Close search (close)"
        className="text-muted-foreground hover:text-foreground dark:hover:text-white min-w-[36px] min-h-[36px] flex items-center justify-center text-base ml-1"
      >
        ✕
      </Button>
    </div>
  );
}

export default MemoSearchBar;
