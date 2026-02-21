/**
 * Sidebar Component
 *
 * Main sidebar component containing the branch list.
 * Includes search/filter functionality and branch status display.
 */

'use client';

import React, { memo, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useWorktreeSelection } from '@/contexts/WorktreeSelectionContext';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { BranchListItem } from '@/components/sidebar/BranchListItem';
import { SortSelector } from '@/components/sidebar/SortSelector';
import { LocaleSwitcher } from '@/components/common/LocaleSwitcher';
import { LogoutButton } from '@/components/common/LogoutButton';
import { toBranchItem } from '@/types/sidebar';
import { sortBranches } from '@/lib/sidebar-utils';

// ============================================================================
// Component
// ============================================================================

/**
 * Sidebar component with branch list
 *
 * @example
 * ```tsx
 * <Sidebar />
 * ```
 */
export const Sidebar = memo(function Sidebar() {
  const router = useRouter();
  const { worktrees, selectedWorktreeId, selectWorktree } = useWorktreeSelection();
  const { closeMobileDrawer, sortKey, sortDirection } = useSidebarContext();
  const [searchQuery, setSearchQuery] = useState('');

  // Convert worktrees to sidebar items, filter by search, and sort
  const filteredBranches = useMemo(() => {
    const items = worktrees.map(toBranchItem);

    // Apply search filter
    let filtered = items;
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = items.filter(
        (branch) =>
          branch.name.toLowerCase().includes(query) ||
          branch.repositoryName.toLowerCase().includes(query)
      );
    }

    // Apply sorting
    return sortBranches(filtered, sortKey, sortDirection);
  }, [worktrees, searchQuery, sortKey, sortDirection]);

  // Handle branch selection
  const handleBranchClick = (branchId: string) => {
    selectWorktree(branchId);
    // Navigate to the worktree detail page
    router.push(`/worktrees/${branchId}`);
    // Close mobile drawer when selecting a branch
    closeMobileDrawer();
  };

  return (
    <nav
      data-testid="sidebar"
      aria-label="Branch navigation"
      className="h-full flex flex-col bg-gray-900 text-white"
      role="navigation"
    >
      {/* Header */}
      <div
        data-testid="sidebar-header"
        className="flex-shrink-0 px-4 py-4 border-b border-gray-700"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Branches</h2>
          <SortSelector />
        </div>
      </div>

      {/* Search */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-gray-700">
        <input
          type="text"
          placeholder="Search branches..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="
            w-full px-3 py-2 rounded-md
            bg-gray-800 text-white placeholder-gray-400
            border border-gray-600
            focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
          "
        />
      </div>

      {/* Branch list */}
      <div
        data-testid="branch-list"
        className="flex-1 overflow-y-auto"
      >
        {filteredBranches.length === 0 ? (
          <div className="px-4 py-8 text-center text-gray-400">
            {searchQuery ? 'No branches found' : 'No branches available'}
          </div>
        ) : (
          filteredBranches.map((branch) => (
            <BranchListItem
              key={branch.id}
              branch={branch}
              isSelected={branch.id === selectedWorktreeId}
              onClick={() => handleBranchClick(branch.id)}
            />
          ))
        )}
      </div>

      {/* Footer: Language Switcher + Logout */}
      <div className="flex-shrink-0 px-4 py-3 border-t border-gray-700 space-y-2">
        <LocaleSwitcher />
        <LogoutButton />
      </div>
    </nav>
  );
});
