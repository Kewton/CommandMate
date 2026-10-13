/**
 * SidebarListToolbar Component (Issue #3509, #3575)
 *
 * The toolbar above the sidebar's branch list. Issue #3575: one row — the
 * filter field, then the filter icon that opens View (Repository / Branch /
 * Session) and Sort in a small menu ({@link SidebarListOptionsMenu}). All of it
 * applies to every view, which is why it sits here once rather than on a
 * repository heading.
 *
 * The filter stays a plain field that narrows the list in place; ⌘K (the
 * command palette) is for jumping somewhere and does not replace it.
 */

'use client';

import React, { memo } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui';
import { SidebarListOptionsMenu } from '@/components/sidebar/SidebarListOptionsMenu';
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
    <div
      data-testid="sidebar-list-toolbar"
      className="flex flex-shrink-0 items-center gap-1 px-3 pt-2 pb-1.5"
    >
      {/* Issue #1073: semantic Input primitive; bg-background keeps the field
          distinct from the light slate-50 sidebar panel. Issue #3575: the
          32px size and the lighter sidebar border so the row reads as a
          filter, not a settings form. */}
      <Input
        type="text"
        inputSize="sm"
        placeholder={t('sidebar.searchBranches')}
        aria-label={t('sidebar.searchBranches')}
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        className="min-w-0 flex-1 border-sidebar-border bg-background shadow-none"
      />
      <SidebarListOptionsMenu viewMode={viewMode} onViewModeChange={onViewModeChange} />
    </div>
  );
});
