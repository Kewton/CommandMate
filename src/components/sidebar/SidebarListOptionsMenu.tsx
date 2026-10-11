/**
 * SidebarListOptionsMenu Component (Issue #3575)
 *
 * The filter icon at the end of the sidebar's list toolbar. It opens a small
 * menu holding View (Repository / Branch / Session) and Sort (key and
 * direction), so the toolbar is one row and the list starts right under it.
 *
 * Built on the shared Radix DropdownMenu: arrow keys move between the items,
 * Escape and an outside click close it and focus goes back to the icon, and
 * the menu is portalled and kept inside the viewport (the phone drawer is
 * 390px wide). Choosing an item keeps the menu open so View and Sort can be
 * set in one go.
 *
 * The icon carries a dot only while View or Sort differs from the default, and
 * its accessible name / hover title spell out the current values.
 */

'use client';

import React, { memo, useId, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { ListFilter } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import {
  useSidebarContext,
  DEFAULT_SORT_KEY,
  DEFAULT_SORT_DIRECTION,
  DEFAULT_VIEW_MODE,
} from '@/contexts/SidebarContext';
import { isValidViewMode } from '@/lib/sidebar-utils';
import type { SortDirection, SortKey, ViewMode } from '@/lib/sidebar-utils';
import { cn } from '@/lib/utils/cn';

// ============================================================================
// Constants
// ============================================================================

/** View modes in menu order, with their `common.*` label keys. */
const VIEW_MODE_OPTIONS: ReadonlyArray<{ mode: ViewMode; labelKey: string }> = [
  { mode: 'grouped', labelKey: 'sidebar.viewMode.grouped' },
  { mode: 'flat', labelKey: 'sidebar.viewMode.flat' },
  { mode: 'sessions', labelKey: 'sidebar.viewMode.sessions' },
];

/**
 * Sort keys offered in the sidebar (no lastSent; that one is Sessions-page
 * only) [CON-002]. Holds `common.sort.*` keys rather than labels: this is
 * module scope, where t() cannot be called (Issue #1271/#1273).
 */
const SIDEBAR_SORT_OPTIONS: ReadonlyArray<{ key: SortKey; labelKey: string }> = [
  { key: 'updatedAt', labelKey: 'sort.updatedAt' },
  { key: 'repositoryName', labelKey: 'sort.repositoryName' },
  { key: 'branchName', labelKey: 'sort.branchName' },
  { key: 'status', labelKey: 'sort.status' },
];

/** Direction applied when switching to a key [CON-005]; missing keys use 'asc'. */
const SIDEBAR_DEFAULT_DIRECTIONS: Partial<Record<SortKey, SortDirection>> = {
  updatedAt: 'desc',
};

/**
 * Words for each direction (Issue #2648). asc/desc follow sortBranches():
 * updatedAt desc = newest first, the name keys asc = A→Z, status asc =
 * STATUS_PRIORITY ascending = waiting first.
 */
const DIRECTION_LABEL_KEYS: Partial<Record<SortKey, Record<SortDirection, string>>> = {
  updatedAt: { asc: 'sort.direction.oldestFirst', desc: 'sort.direction.newestFirst' },
  repositoryName: { asc: 'sort.direction.aToZ', desc: 'sort.direction.zToA' },
  branchName: { asc: 'sort.direction.aToZ', desc: 'sort.direction.zToA' },
  status: { asc: 'sort.direction.attentionFirst', desc: 'sort.direction.attentionLast' },
};

/** Generic words for a key without its own direction words (e.g. a stored lastSent). */
const FALLBACK_DIRECTION_LABEL_KEYS: Record<SortDirection, string> = {
  asc: 'sort.ascending',
  desc: 'sort.descending',
};

/** The default direction for a key, listed first in the menu. */
function defaultDirectionFor(key: SortKey): SortDirection {
  return SIDEBAR_DEFAULT_DIRECTIONS[key] ?? 'asc';
}

/** Choosing an item keeps the menu open (Radix still reports the value). */
function keepOpen(event: Event): void {
  event.preventDefault();
}

// ============================================================================
// Component
// ============================================================================

/** Props for SidebarListOptionsMenu */
export interface SidebarListOptionsMenuProps {
  /** Current list layout */
  viewMode: ViewMode;
  /** Called with the chosen list layout */
  onViewModeChange: (mode: ViewMode) => void;
}

export const SidebarListOptionsMenu = memo(function SidebarListOptionsMenu({
  viewMode,
  onViewModeChange,
}: SidebarListOptionsMenuProps) {
  const t = useTranslations('common');
  const { sortKey, sortDirection, setSortKey, setSortDirection } = useSidebarContext();
  const viewHeadingId = useId();
  const sortHeadingId = useId();

  const directionLabel = useMemo(() => {
    const keys = DIRECTION_LABEL_KEYS[sortKey] ?? FALLBACK_DIRECTION_LABEL_KEYS;
    return (direction: SortDirection) => t(keys[direction]);
  }, [sortKey, t]);

  const viewLabel = t(
    VIEW_MODE_OPTIONS.find((option) => option.mode === viewMode)?.labelKey ??
      'sidebar.viewMode.grouped'
  );
  const sortLabel = t(
    SIDEBAR_SORT_OPTIONS.find((option) => option.key === sortKey)?.labelKey ?? `sort.${sortKey}`
  );
  const summary = t('sidebar.listOptionsSummary', {
    view: viewLabel,
    sort: sortLabel,
    direction: directionLabel(sortDirection),
  });
  const isDefault =
    viewMode === DEFAULT_VIEW_MODE &&
    sortKey === DEFAULT_SORT_KEY &&
    sortDirection === DEFAULT_SORT_DIRECTION;

  const defaultDirection = defaultDirectionFor(sortKey);
  const directions: SortDirection[] =
    defaultDirection === 'asc' ? ['asc', 'desc'] : ['desc', 'asc'];

  const handleSortKeyChange = (value: string) => {
    const option = SIDEBAR_SORT_OPTIONS.find((o) => o.key === value);
    if (!option || option.key === sortKey) return;
    setSortKey(option.key);
    // Apply the default direction for the new key [CON-005]
    setSortDirection(defaultDirectionFor(option.key));
  };

  const handleSortDirectionChange = (value: string) => {
    if (value === 'asc' || value === 'desc') setSortDirection(value);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="sidebar-list-options"
          data-view-mode={viewMode}
          data-sort-key={sortKey}
          data-sort-direction={sortDirection}
          aria-label={t('sidebar.listOptionsLabel', { summary })}
          title={summary}
          className="relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-sidebar-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-sidebar-hover data-[state=open]:text-sidebar-foreground"
        >
          <ListFilter className="h-4 w-4" aria-hidden="true" />
          {!isDefault && (
            <span
              data-testid="sidebar-list-options-indicator"
              aria-hidden="true"
              className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent-500"
            />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-testid="sidebar-list-options-menu"
        align="end"
        collisionPadding={8}
        className={cn(
          'w-52 max-w-[calc(100vw-16px)]',
          'max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto'
        )}
      >
        <DropdownMenuLabel id={viewHeadingId}>{t('sidebar.viewLabel')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          data-testid="view-mode-options"
          aria-labelledby={viewHeadingId}
          value={viewMode}
          onValueChange={(next) => {
            if (isValidViewMode(next) && next !== viewMode) onViewModeChange(next);
          }}
        >
          {VIEW_MODE_OPTIONS.map(({ mode, labelKey }) => (
            <DropdownMenuRadioItem key={mode} value={mode} onSelect={keepOpen}>
              {t(labelKey)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuLabel id={sortHeadingId}>{t('sort.label')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          data-testid="sort-key-options"
          aria-labelledby={sortHeadingId}
          value={sortKey}
          onValueChange={handleSortKeyChange}
        >
          {SIDEBAR_SORT_OPTIONS.map(({ key, labelKey }) => (
            <DropdownMenuRadioItem key={key} value={key} onSelect={keepOpen}>
              {t(labelKey)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuRadioGroup
          data-testid="sort-direction-options"
          aria-label={t('sort.directionLabel')}
          value={sortDirection}
          onValueChange={handleSortDirectionChange}
        >
          {directions.map((direction) => (
            <DropdownMenuRadioItem key={direction} value={direction} onSelect={keepOpen}>
              {directionLabel(direction)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
