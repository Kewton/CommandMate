/**
 * SortSelectorBase - Presentational Sort Selector Component
 *
 * Context-free sort selector that receives all state via props.
 * Extracted from SortSelector for reuse in Sessions page (Issue #606).
 *
 * Contains toggle-on-reselect and default-direction logic internally [CON-005].
 */

'use client';

import React, { memo, useState, useRef, useEffect, useCallback } from 'react';
import type { SortKey, SortDirection } from '@/lib/sidebar-utils';

// ============================================================================
// Types
// ============================================================================

/** Sort option definition */
export interface SortOption {
  key: SortKey;
  label: string;
}

/** Props for SortSelectorBase */
export interface SortSelectorBaseProps {
  /** Current sort key */
  sortKey: SortKey;
  /** Current sort direction */
  sortDirection: SortDirection;
  /** Callback when sort key changes */
  onSortKeyChange: (key: SortKey) => void;
  /** Callback when sort direction changes */
  onSortDirectionChange: (direction: SortDirection) => void;
  /** Available sort options */
  options: ReadonlyArray<SortOption>;
  /** Default directions per key (applied when switching to a new key) [CON-005] */
  defaultDirections?: Partial<Record<SortKey, SortDirection>>;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Presentational sort selector component.
 * No Context dependency - receives all state via props.
 *
 * Behavior:
 * - Selecting the same key toggles direction
 * - Selecting a different key applies defaultDirections[key] ?? 'asc'
 */
export const SortSelectorBase = memo(function SortSelectorBase({
  sortKey,
  sortDirection,
  onSortKeyChange,
  onSortDirectionChange,
  options,
  defaultDirections,
}: SortSelectorBaseProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Close dropdown on escape key
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen]);

  const handleToggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const handleSelectKey = useCallback(
    (key: SortKey) => {
      if (key === sortKey) {
        // Toggle direction if same key is selected
        onSortDirectionChange(sortDirection === 'asc' ? 'desc' : 'asc');
      } else {
        onSortKeyChange(key);
        // Apply default direction for the new key [CON-005]
        const defaultDir = defaultDirections?.[key] ?? 'asc';
        onSortDirectionChange(defaultDir);
      }
      setIsOpen(false);
    },
    [sortKey, sortDirection, onSortKeyChange, onSortDirectionChange, defaultDirections]
  );

  const handleToggleDirection = useCallback(() => {
    onSortDirectionChange(sortDirection === 'asc' ? 'desc' : 'asc');
  }, [sortDirection, onSortDirectionChange]);

  const currentLabel = options.find((opt) => opt.key === sortKey)?.label || 'Sort';

  return (
    <div ref={containerRef} className="relative" data-testid="sort-selector-base">
      {/* Trigger button */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-label={`Sort by ${currentLabel}`}
          className="
            flex items-center gap-1 px-2 py-1 rounded
            text-xs text-gray-300 hover:text-white hover:bg-gray-700
            focus:outline-none focus:ring-2 focus:ring-blue-500
            transition-colors
          "
        >
          <SortIcon className="w-3 h-3" />
          <span className="hidden sm:inline">{currentLabel}</span>
        </button>

        {/* Direction toggle */}
        <button
          type="button"
          onClick={handleToggleDirection}
          aria-label={sortDirection === 'asc' ? 'Sort ascending' : 'Sort descending'}
          className="
            p-1 rounded text-gray-300 hover:text-white hover:bg-gray-700
            focus:outline-none focus:ring-2 focus:ring-blue-500
            transition-colors
          "
        >
          {sortDirection === 'asc' ? (
            <ArrowUpIcon className="w-3 h-3" />
          ) : (
            <ArrowDownIcon className="w-3 h-3" />
          )}
        </button>
      </div>

      {/* Dropdown menu */}
      {isOpen && (
        <div
          role="listbox"
          aria-label="Sort options"
          className="
            absolute right-0 top-full mt-1 z-50
            min-w-[140px] py-1 rounded-md shadow-lg
            bg-gray-800 border border-gray-600
          "
        >
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              role="option"
              aria-selected={sortKey === option.key}
              onClick={() => handleSelectKey(option.key)}
              className={`
                w-full px-3 py-2 text-left text-sm
                flex items-center justify-between
                hover:bg-gray-700 transition-colors
                ${sortKey === option.key ? 'text-blue-400' : 'text-gray-300'}
              `}
            >
              <span>{option.label}</span>
              {sortKey === option.key && (
                <span className="text-xs">
                  {sortDirection === 'asc' ? 'ASC' : 'DESC'}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

// ============================================================================
// Icons
// ============================================================================

function SortIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12"
      />
    </svg>
  );
}

function ArrowUpIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
    </svg>
  );
}

function ArrowDownIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}
