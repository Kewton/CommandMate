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
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Button } from '@/components/ui';

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
  const t = useTranslations('worktree');

  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-muted border-b border-input flex-shrink-0">
      <input
        ref={inputRef}
        type="text"
        value={searchQuery}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { onClose(); }
          if (e.key === 'Enter') { if (e.shiftKey) { onPrevMatch(); } else { onNextMatch(); } }
        }}
        placeholder={t('fileSearch.placeholder')}
        className="flex-1 min-w-0 px-2 py-0.5 text-sm bg-surface dark:text-foreground border border-input rounded outline-none focus:ring-1 focus:ring-ring"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      <span className="text-xs text-muted-foreground min-w-[3rem] text-right">
        {matchCount > 0 ? `${currentIdx + 1}/${matchCount}` : '0/0'}
      </span>
      <Button variant="ghost" type="button" onClick={onPrevMatch} disabled={matchCount === 0} className="min-w-[32px] min-h-[32px] flex items-center justify-center text-muted-foreground hover:text-foreground dark:hover:text-white disabled:text-muted-foreground/50" aria-label={t('fileSearch.prevMatch')}>▲</Button>
      <Button variant="ghost" type="button" onClick={onNextMatch} disabled={matchCount === 0} className="min-w-[32px] min-h-[32px] flex items-center justify-center text-muted-foreground hover:text-foreground dark:hover:text-white disabled:text-muted-foreground/50" aria-label={t('fileSearch.nextMatch')}>▼</Button>
      <Button variant="ghost" type="button" onClick={onClose} className="min-w-[32px] min-h-[32px] flex items-center justify-center text-muted-foreground hover:text-foreground dark:hover:text-white" aria-label={t('fileSearch.close')}><X className="w-4 h-4" /></Button>
    </div>
  );
});
