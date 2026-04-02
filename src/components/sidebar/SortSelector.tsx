/**
 * SortSelector Component
 *
 * Thin wrapper around SortSelectorBase that integrates with SidebarContext.
 * Uses SIDEBAR_SORT_OPTIONS (without lastSent) [CON-002].
 *
 * Issue #606: Refactored to use SortSelectorBase [DP-006]
 */

'use client';

import React, { memo } from 'react';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { SortSelectorBase } from './SortSelectorBase';
import type { SortOption } from './SortSelectorBase';

// ============================================================================
// Constants
// ============================================================================

/**
 * Sort options for sidebar (does NOT include lastSent) [CON-002]
 * lastSent is only available in Sessions page via SESSIONS_SORT_OPTIONS.
 */
const SIDEBAR_SORT_OPTIONS: ReadonlyArray<SortOption> = [
  { key: 'updatedAt', label: 'Updated' },
  { key: 'repositoryName', label: 'Repository' },
  { key: 'branchName', label: 'Branch' },
  { key: 'status', label: 'Status' },
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

  return (
    <SortSelectorBase
      sortKey={sortKey}
      sortDirection={sortDirection}
      onSortKeyChange={setSortKey}
      onSortDirectionChange={setSortDirection}
      options={SIDEBAR_SORT_OPTIONS}
      defaultDirections={SIDEBAR_DEFAULT_DIRECTIONS}
    />
  );
});
