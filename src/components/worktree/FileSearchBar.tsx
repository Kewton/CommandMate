/**
 * FileSearchBar Component
 *
 * Reusable search bar for file content search in the file panel.
 * Extracted from FilePanelContent.tsx to eliminate duplication
 * between MarkdownWithSearch and CodeViewerWithSearch components.
 *
 * Issue #469: Refactoring - DRY extraction
 */

'use client';

import React, { memo } from 'react';
import { X } from 'lucide-react';

export interface FileSearchBarProps {
  /** Ref for the search input element */
  inputRef: React.RefObject<HTMLInputElement>;
  /** Current search query */
  searchQuery: string;
  /** Update search query */
  onQueryChange: (query: string) => void;
  /** Total number of matches */
  matchCount: number;
  /** Index of the currently highlighted match (0-based) */
  currentIdx: number;
  /** Navigate to the next match */
  onNextMatch: () => void;
  /** Navigate to the previous match */
  onPrevMatch: () => void;
  /** Close the search bar */
  onClose: () => void;
}

/**
 * FileSearchBar - Inline search bar with match navigation.
 *
 * Supports keyboard shortcuts:
 * - Escape: close search
 * - Enter: next match
 * - Shift+Enter: previous match
 */
export const FileSearchBar = memo(function FileSearchBar({
  inputRef,
  searchQuery,
  onQueryChange,
  matchCount,
  currentIdx,
  onNextMatch,
  onPrevMatch,
  onClose,
}: FileSearchBarProps) {
  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-gray-200 dark:bg-gray-700 border-b border-gray-300 dark:border-gray-600 flex-shrink-0">
      <input
        ref={inputRef}
        type="text"
        value={searchQuery}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { onClose(); }
          if (e.key === 'Enter') { if (e.shiftKey) { onPrevMatch(); } else { onNextMatch(); } }
        }}
        placeholder="検索..."
        className="flex-1 min-w-0 px-2 py-0.5 text-sm bg-white dark:bg-gray-800 dark:text-gray-100 border border-gray-300 dark:border-gray-600 rounded outline-none focus:ring-1 focus:ring-cyan-500"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      <span className="text-xs text-gray-500 min-w-[3rem] text-right">
        {matchCount > 0 ? `${currentIdx + 1}/${matchCount}` : '0/0'}
      </span>
      <button type="button" onClick={onPrevMatch} disabled={matchCount === 0} className="min-w-[32px] min-h-[32px] flex items-center justify-center text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white disabled:text-gray-300 dark:disabled:text-gray-600" aria-label="前の結果">▲</button>
      <button type="button" onClick={onNextMatch} disabled={matchCount === 0} className="min-w-[32px] min-h-[32px] flex items-center justify-center text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white disabled:text-gray-300 dark:disabled:text-gray-600" aria-label="次の結果">▼</button>
      <button type="button" onClick={onClose} className="min-w-[32px] min-h-[32px] flex items-center justify-center text-gray-400 hover:text-gray-800 dark:hover:text-white" aria-label="検索を閉じる"><X className="w-4 h-4" /></button>
    </div>
  );
});
