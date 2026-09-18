/**
 * SortSelector Component
 *
 * Thin wrapper around SortSelectorBase that integrates with SidebarContext.
 * Uses SIDEBAR_SORT_OPTIONS (without lastSent) [CON-002].
 *
 * Issue #606: Refactored to use SortSelectorBase [DP-006]
 */

'use client';

import React, { memo, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { SortSelectorBase } from './SortSelectorBase';
import type { SortKey } from '@/lib/sidebar-utils';

// ============================================================================
// Constants
// ============================================================================

/**
 * Sort options for sidebar (does NOT include lastSent) [CON-002]
 * lastSent is only available in Sessions page via SESSIONS_SORT_OPTIONS.
 *
 * Holds `common.sort.*` keys rather than labels: this is module scope, where
 * t() cannot be called, so a literal would pin the dropdown to English
 * (Issue #1271/#1273). SortSelectorBase still takes resolved `label` strings,
 * so the Sessions page's own options are unaffected.
 */
const SIDEBAR_SORT_OPTIONS: ReadonlyArray<{ key: SortKey; labelKey: string }> = [
  { key: 'updatedAt', labelKey: 'sort.updatedAt' },
  { key: 'repositoryName', labelKey: 'sort.repositoryName' },
  { key: 'branchName', labelKey: 'sort.branchName' },
  { key: 'status', labelKey: 'sort.status' },
];

/** Default directions for sidebar sort keys */
const SIDEBAR_DEFAULT_DIRECTIONS = {
  updatedAt: 'desc' as const,
};

// ============================================================================
// Component
// ============================================================================

/**
 * SortSelector provides a dropdown to select sort key and direction.
 * Sidebar-specific wrapper around SortSelectorBase.
 *
 * @example
 * ```tsx
 * <SortSelector />
 * ```
 */
export const SortSelector = memo(function SortSelector() {
  const { sortKey, sortDirection, setSortKey, setSortDirection } = useSidebarContext();
  const t = useTranslations('common');

  const options = useMemo(
    () => SIDEBAR_SORT_OPTIONS.map(({ key, labelKey }) => ({ key, label: t(labelKey) })),
    [t]
  );

  // Issue #2648: the direction toggle says what the order means for each key
  // ("Newest first", "A→Z", "Needs attention first") instead of an arrow.
  // asc/desc follow sortBranches(): updatedAt desc = newest first, the name
  // keys asc = A→Z, status asc = STATUS_PRIORITY ascending = waiting first.
  const directionLabels = useMemo(
    () => ({
      updatedAt: { asc: t('sort.direction.oldestFirst'), desc: t('sort.direction.newestFirst') },
      repositoryName: { asc: t('sort.direction.aToZ'), desc: t('sort.direction.zToA') },
      branchName: { asc: t('sort.direction.aToZ'), desc: t('sort.direction.zToA') },
      status: { asc: t('sort.direction.attentionFirst'), desc: t('sort.direction.attentionLast') },
    }),
    [t]
  );

  return (
    <SortSelectorBase
      sortKey={sortKey}
      sortDirection={sortDirection}
      onSortKeyChange={setSortKey}
      onSortDirectionChange={setSortDirection}
      options={options}
      defaultDirections={SIDEBAR_DEFAULT_DIRECTIONS}
      showLabel
      directionLabels={directionLabels}
      iconClassName="w-4 h-4"
    />
  );
});
