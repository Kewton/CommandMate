/**
 * Sidebar Component
 *
 * Main sidebar component containing the branch list.
 * Includes search/filter functionality and branch status display.
 */

'use client';

import React, { memo, useState, useMemo } from 'react';
import { useWorktreeSelection } from '@/contexts/WorktreeSelectionContext';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { BranchListItem } from '@/components/sidebar/BranchListItem';
import { toBranchItem } from '@/types/sidebar';

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
  const { worktrees, selectedWorktreeId, selectWorktree } = useWorktreeSelection();
  const { closeMobileDrawer } = useSidebarContext();
  const [searchQuery, setSearchQuery] = useState('');

  // Convert worktrees to sidebar items and filter by search
  const filteredBranches = useMemo(() => {
    const items = worktrees.map(toBranchItem);

    if (!searchQuery.trim()) {
      return items;
    }

    const query = searchQuery.toLowerCase();
    return items.filter(
      (branch) =>
        branch.name.toLowerCase().includes(query) ||
        branch.repositoryName.toLowerCase().includes(query)
    );
  }, [worktrees, searchQuery]);

  // Handle branch selection
  const handleBranchClick = (branchId: string) => {
    selectWorktree(branchId);
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
        <h2 className="text-lg font-semibold text-white">Branches</h2>
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
    </nav>
  );
});
