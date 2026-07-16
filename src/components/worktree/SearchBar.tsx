/**
 * SearchBar Component
 * [Issue #21] File tree search functionality
 *
 * Provides:
 * - Search input with clear button
 * - Mode toggle (name/content)
 * - Loading indicator
 * - Responsive design (desktop always visible)
 */

'use client';

import React, { memo, useCallback, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { MOBILE_BREAKPOINT } from '@/hooks/useIsMobile';
import type { SearchMode } from '@/types/models';
import { Spinner } from '@/components/ui/Spinner';

// ============================================================================
// Types
// ============================================================================

export interface SearchBarProps {
  /** Current search query */
  query: string;
  /** Current search mode */
  mode: SearchMode;
  /** Whether search is in progress */
  isSearching: boolean;
  /** Error message (if any) */
  error?: string | null;
  /** Callback when query changes */
  onQueryChange: (query: string) => void;
  /** Callback when mode changes */
  onModeChange: (mode: SearchMode) => void;
  /** Callback to clear search */
  onClear: () => void;
  /** Placeholder text */
  placeholder?: string;
  /** Additional CSS classes */
  className?: string;
}

// ============================================================================
// Icon Components
// ============================================================================

const SearchIcon = memo(function SearchIcon() {
  return (
    <svg
      className="w-4 h-4 text-muted-foreground"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
      />
    </svg>
  );
});

const ClearIcon = memo(function ClearIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M6 18L18 6M6 6l12 12"
      />
    </svg>
  );
});

const LoadingSpinner = memo(function LoadingSpinner() {
  const t = useTranslations('worktree');

  return (
    <Spinner
      size="sm"
      variant="accent"
      data-testid="search-loading"
      role="status"
      aria-hidden={false}
      aria-label={t('search.searching')}
    />
  );
});

// ============================================================================
// Main Component
// ============================================================================

/**
 * SearchBar - Search input with mode toggle
 *
 * @example
 * ```tsx
 * <SearchBar
 *   query={query}
 *   mode={mode}
 *   isSearching={isSearching}
 *   onQueryChange={setQuery}
 *   onModeChange={setMode}
 *   onClear={clearSearch}
 * />
 * ```
 */
export const SearchBar = memo(function SearchBar({
  query,
  mode,
  isSearching,
  error,
  onQueryChange,
  onModeChange,
  onClear,
  placeholder,
  className = '',
}: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useTranslations('worktree');

  // Handle input change
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onQueryChange(e.target.value);
    },
    [onQueryChange]
  );

  // Handle clear button
  const handleClear = useCallback(() => {
    onClear();
    inputRef.current?.focus();
  }, [onClear]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        if (query) {
          handleClear();
        } else {
          inputRef.current?.blur();
        }
      }
    },
    [query, handleClear]
  );

  // Focus input on mount (optional, can be controlled via prop)
  useEffect(() => {
    // Don't auto-focus on mobile to prevent keyboard popup
    const isMobile = window.innerWidth < MOBILE_BREAKPOINT;
    if (!isMobile) {
      // Small delay to prevent focus-related layout shifts
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, []);

  return (
    <div
      data-testid="search-bar"
      className={`flex flex-col gap-2 p-2 bg-surface dark:bg-surface-2 border-b border-border ${className}`}
    >
      {/* Search Input Row */}
      <div className="flex items-center gap-2">
        {/* Search Icon */}
        <div className="flex-shrink-0">
          <SearchIcon />
        </div>

        {/* Input Field */}
        <input
          ref={inputRef}
          type="text"
          data-testid="search-input"
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? t('search.placeholder')}
          className="flex-1 min-w-0 px-2 py-1 text-sm bg-muted text-foreground border border-input rounded focus:outline-none focus:ring-1 focus:ring-ring focus:border-accent-500"
          aria-label={t('search.label')}
          aria-busy={isSearching}
        />

        {/* Loading / Clear Button */}
        <div className="flex-shrink-0 w-6 h-6 flex items-center justify-center">
          {isSearching ? (
            <LoadingSpinner />
          ) : query ? (
            <button
              type="button"
              data-testid="search-clear"
              onClick={handleClear}
              className="p-1 text-muted-foreground hover:text-foreground rounded transition-colors"
              aria-label={t('search.clear')}
            >
              <ClearIcon />
            </button>
          ) : null}
        </div>
      </div>

      {/* Mode Toggle Row */}
      <div className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground mr-1">{t('search.mode')}</span>
        <button
          type="button"
          data-testid="mode-name"
          onClick={() => onModeChange('name')}
          className={`px-2 py-0.5 text-xs rounded transition-colors ${
            mode === 'name'
              ? 'bg-accent-100 dark:bg-accent-900 text-accent-700 dark:text-accent-300 font-medium'
              : 'bg-muted text-muted-foreground hover:bg-muted/80'
          }`}
          aria-pressed={mode === 'name'}
        >
          {t('search.modeName')}
        </button>
        <button
          type="button"
          data-testid="mode-content"
          onClick={() => onModeChange('content')}
          className={`px-2 py-0.5 text-xs rounded transition-colors ${
            mode === 'content'
              ? 'bg-accent-100 dark:bg-accent-900 text-accent-700 dark:text-accent-300 font-medium'
              : 'bg-muted text-muted-foreground hover:bg-muted/80'
          }`}
          aria-pressed={mode === 'content'}
        >
          {t('search.modeContent')}
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div
          data-testid="search-error"
          className="text-xs text-danger bg-danger-subtle px-2 py-1 rounded"
          role="alert"
        >
          {error}
        </div>
      )}
    </div>
  );
});

export default SearchBar;
