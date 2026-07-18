/**
 * SortSelectorBase - Presentational Sort Selector Component
 *
 * Context-free sort selector that receives all state via props.
 * Extracted from SortSelector for reuse in Sessions page (Issue #606).
 *
 * Contains toggle-on-reselect and default-direction logic internally [CON-005].
 */

'use client';

import React, { memo, useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Tooltip } from '@/components/common/Tooltip';
import type { SortKey, SortDirection } from '@/lib/sidebar-utils';

// ============================================================================
// Types
// ============================================================================

/** Sort option definition */
export interface SortOption {
  key: SortKey;
  label: string;
}

// ============================================================================
// Viewport clamping
// ============================================================================

/** Space (px) kept between the dropdown and the viewport edge. [Issue #1365] */
const VIEWPORT_MARGIN = 8;

/**
 * Offset needed to pull a `[start, start + size]` span back inside a viewport
 * of `viewport` px on one axis, keeping `VIEWPORT_MARGIN` clear at both ends.
 * Returns 0 when the span already fits. A span longer than the viewport is
 * never pushed past the leading margin, so its head stays visible.
 * `size <= 0` means the element has not been laid out — nothing to correct.
 */
function clampShift(start: number, size: number, viewport: number): number {
  if (size <= 0 || viewport <= 0) return 0;
  const overflow = start + size + VIEWPORT_MARGIN - viewport;
  if (overflow > 0) return -Math.min(overflow, Math.max(0, start - VIEWPORT_MARGIN));
  if (start < VIEWPORT_MARGIN) return VIEWPORT_MARGIN - start;
  return 0;
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
  /** When true, hides the label text to save horizontal space (used in compact sidebar) */
  compact?: boolean;
  /**
   * Optional hover tooltip for the trigger button (Issue #882). When provided,
   * the trigger is wrapped in the shared {@link Tooltip} (placement `bottom`).
   * Omitted callers (e.g. Sessions page) keep the plain button.
   */
  tooltip?: string;
  /**
   * Tailwind size classes for the sort / direction icons (Issue #946). Defaults
   * to `w-3 h-3`. The sidebar header passes `w-4 h-4` for better visibility,
   * while other consumers (e.g. Sessions page) omit it and keep the original size.
   */
  iconClassName?: string;
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
  compact,
  tooltip,
  iconClassName = 'w-3 h-3',
}: SortSelectorBaseProps) {
  const t = useTranslations('common');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const shiftRef = useRef({ x: 0, y: 0 });
  const [shift, setShift] = useState({ x: 0, y: 0 });

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

  // Keep the dropdown inside the viewport. The sidebar header deliberately has
  // no overflow clipping, so the menu is not cut off — but a selector sitting
  // low or hard against an edge can still open partly off-screen. It stays
  // absolutely positioned rather than portalled, because the click-outside
  // handler above asks whether the click landed inside `containerRef`.
  // [Issue #1365]
  useLayoutEffect(() => {
    const applyShift = (next: { x: number; y: number }): void => {
      shiftRef.current = next;
      setShift((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
    };
    if (!isOpen) {
      applyShift({ x: 0, y: 0 });
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Subtract the shift already applied so the measurement describes the
    // menu's uncorrected position and re-running stays idempotent.
    applyShift({
      x: clampShift(rect.left - shiftRef.current.x, rect.width, window.innerWidth),
      y: clampShift(rect.top - shiftRef.current.y, rect.height, window.innerHeight),
    });
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

  const triggerButton = (
    <button
      type="button"
      onClick={handleToggle}
      aria-expanded={isOpen}
      aria-haspopup="listbox"
      aria-label={`Sort by ${currentLabel}`}
      className="
        flex items-center gap-1 px-2 py-1 rounded
        text-xs text-sidebar-muted hover:text-sidebar-foreground hover:bg-sidebar-hover
        focus:outline-none focus:ring-2 focus:ring-ring
        transition-colors
      "
    >
      <SortIcon className={iconClassName} />
      <span className={compact ? 'hidden' : 'hidden sm:inline'}>{currentLabel}</span>
    </button>
  );

  return (
    <div ref={containerRef} className="relative" data-testid="sort-selector-base">
      {/* Trigger button */}
      <div className="flex items-center gap-1">
        {tooltip ? (
          <Tooltip content={tooltip} placement="bottom">
            {triggerButton}
          </Tooltip>
        ) : (
          triggerButton
        )}

        {/* Direction toggle */}
        <button
          type="button"
          onClick={handleToggleDirection}
          aria-label={sortDirection === 'asc' ? 'Sort ascending' : 'Sort descending'}
          className="
            p-1 rounded text-sidebar-muted hover:text-sidebar-foreground hover:bg-sidebar-hover
            focus:outline-none focus:ring-2 focus:ring-ring
            transition-colors
          "
        >
          {sortDirection === 'asc' ? (
            <ArrowUpIcon className={iconClassName} />
          ) : (
            <ArrowDownIcon className={iconClassName} />
          )}
        </button>
      </div>

      {/* Dropdown menu */}
      {isOpen && (
        <div
          ref={menuRef}
          role="listbox"
          aria-label={t('sort.options')}
          className="
            absolute right-0 top-full mt-1 z-50
            min-w-[140px] py-1 rounded-md shadow-lg
            bg-sidebar border border-sidebar-border
          "
          style={
            shift.x !== 0 || shift.y !== 0
              ? { transform: `translate(${shift.x}px, ${shift.y}px)` }
              : undefined
          }
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
                hover:bg-sidebar-hover transition-colors
                ${sortKey === option.key ? 'text-accent-700 dark:text-accent-400' : 'text-sidebar-muted'}
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
