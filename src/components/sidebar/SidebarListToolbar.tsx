/**
 * SidebarListToolbar Component (Issue #3509)
 *
 * The toolbar above the sidebar's branch list: the filter field, then View
 * (Grouped / Flat / Sessions) and Sort. All three apply to every view, which is
 * why they sit here once rather than on a repository heading.
 *
 * The filter stays a plain field that narrows the list in place; ⌘K (the
 * command palette) is for jumping somewhere and does not replace it.
 */

'use client';

import React, { memo, useId } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui';
import { SortSelector } from '@/components/sidebar/SortSelector';
import { isValidViewMode } from '@/lib/sidebar-utils';
import type { ViewMode } from '@/lib/sidebar-utils';

/** Props for SidebarListToolbar */
export interface SidebarListToolbarProps {
  /** Current filter text */
  searchQuery: string;
  /** Called with the new filter text */
  onSearchChange: (query: string) => void;
  /** Current list layout */
  viewMode: ViewMode;
  /** Called with the chosen list layout */
  onViewModeChange: (mode: ViewMode) => void;
}

export const SidebarListToolbar = memo(function SidebarListToolbar({
  searchQuery,
  onSearchChange,
  viewMode,
  onViewModeChange,
}: SidebarListToolbarProps) {
  const t = useTranslations('common');

  return (
    <div data-testid="sidebar-list-toolbar" className="flex-shrink-0 space-y-2 px-3 pt-3 pb-2">
      {/* Issue #1073: use the Input primitive defaults (border-input, semantic
          text/placeholder) instead of the old gray overrides. Only bg-background
          is kept so the field stays distinct from the light slate-50 sidebar
          panel (in dark the primitive's recessed surface already contrasts). */}
      <Input
        type="text"
        placeholder={t('sidebar.searchBranches')}
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        className="bg-background shadow-none"
      />
      <div
        data-testid="sidebar-list-controls"
        className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 px-1"
      >
        <ViewModeSelect viewMode={viewMode} onChange={onViewModeChange} />
        <span className="whitespace-nowrap text-xs text-sidebar-muted">{t('sort.label')}</span>
        <SortSelector />
      </div>
    </div>
  );
});

/**
 * View mode select (Issue #2648): the list layout as words instead of an icon.
 * Renders two cells of the controls grid — the label and the select.
 */
function ViewModeSelect({
  viewMode,
  onChange,
}: {
  viewMode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  const t = useTranslations('common');
  const selectId = useId();

  return (
    <>
      <label htmlFor={selectId} className="whitespace-nowrap text-xs text-sidebar-muted">
        {t('sidebar.viewLabel')}
      </label>
      <select
        id={selectId}
        data-testid="view-mode-select"
        value={viewMode}
        onChange={(event) => {
          const next = event.target.value;
          // The <select> can only emit the values rendered below; the guard is
          // for the type.
          if (isValidViewMode(next)) onChange(next);
        }}
        className="w-full min-w-0 truncate rounded border border-sidebar-border bg-sidebar px-1.5 py-1 text-xs text-sidebar-foreground hover:bg-sidebar-hover focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <option value="grouped">{t('sidebar.viewMode.grouped')}</option>
        <option value="flat">{t('sidebar.viewMode.flat')}</option>
        <option value="sessions">{t('sidebar.viewMode.sessions')}</option>
      </select>
    </>
  );
}
