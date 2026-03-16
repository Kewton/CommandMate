/**
 * Sidebar Component
 *
 * Main sidebar component containing the branch list.
 * Includes search/filter functionality, branch status display,
 * and repository-based grouping (Issue #449).
 */

'use client';

import React, { memo, useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useWorktreeSelection } from '@/contexts/WorktreeSelectionContext';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { BranchListItem } from '@/components/sidebar/BranchListItem';
import { SortSelector } from '@/components/sidebar/SortSelector';
import { LocaleSwitcher } from '@/components/common/LocaleSwitcher';
import { ThemeToggle } from '@/components/common/ThemeToggle';
import { LogoutButton } from '@/components/common/LogoutButton';
import { useToast, ToastContainer } from '@/components/common/Toast';
import { repositoryApi, ApiError } from '@/lib/api-client';
import { toBranchItem } from '@/types/sidebar';
import { sortBranches, groupBranches } from '@/lib/sidebar-utils';
import type { ViewMode } from '@/lib/sidebar-utils';

// ============================================================================
// Constants
// ============================================================================

/** LocalStorage key for group collapsed state */
const SIDEBAR_GROUP_COLLAPSED_STORAGE_KEY = 'mcbd-sidebar-group-collapsed';

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
  const { worktrees, selectedWorktreeId, selectWorktree, refreshWorktrees } = useWorktreeSelection();
  const { closeMobileDrawer, sortKey, sortDirection, viewMode, setViewMode } = useSidebarContext();
  const [searchQuery, setSearchQuery] = useState('');

  // Group collapsed state with localStorage sync
  const [groupCollapsed, setGroupCollapsed] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const stored = localStorage.getItem(SIDEBAR_GROUP_COLLAPSED_STORAGE_KEY);
      return stored ? parseGroupCollapsed(stored) : {};
    } catch {
      return {};
    }
  });

  // 3-stage useMemo chain (DRY principle)

  // Stage 1: Search filter
  const searchFilteredItems = useMemo(() => {
    const items = worktrees.map(toBranchItem);
    if (!searchQuery.trim()) return items;
    const query = searchQuery.toLowerCase();
    return items.filter(
      (b) =>
        b.name.toLowerCase().includes(query) ||
        b.repositoryName.toLowerCase().includes(query)
    );
  }, [worktrees, searchQuery]);

  // Stage 2: Flat sorted list (only computed when viewMode is flat)
  const flatBranches = useMemo(
    () => (viewMode === 'flat' ? sortBranches(searchFilteredItems, sortKey, sortDirection) : []),
    [viewMode, searchFilteredItems, sortKey, sortDirection]
  );

  // Stage 3: Grouped sorted list (only computed when viewMode is grouped)
  const groupedBranches = useMemo(
    () => (viewMode === 'grouped' ? groupBranches(searchFilteredItems, sortKey, sortDirection) : null),
    [viewMode, searchFilteredItems, sortKey, sortDirection]
  );

  // Persist groupCollapsed to localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(
        SIDEBAR_GROUP_COLLAPSED_STORAGE_KEY,
        JSON.stringify(groupCollapsed)
      );
    } catch {
      // Ignore localStorage errors
    }
  }, [groupCollapsed]);

  // Toggle group collapsed state
  const toggleGroup = useCallback((repositoryName: string) => {
    setGroupCollapsed((prev) => ({
      ...prev,
      [repositoryName]: !prev[repositoryName],
    }));
  }, []);

  // Handle branch selection
  // Fallback: if router.push fails to navigate (e.g., Next.js Router Cache corruption),
  // use window.location.href after a short delay to ensure navigation succeeds.
  const handleBranchClick = useCallback((branchId: string) => {
    selectWorktree(branchId);
    const targetPath = `/worktrees/${branchId}`;
    router.push(targetPath);
    closeMobileDrawer();
    // Fallback navigation if router.push silently fails
    const timerId = setTimeout(() => {
      if (window.location.pathname !== targetPath) {
        window.location.href = targetPath;
      }
    }, 300);
    // Cleanup: if route changes before timeout, cancel fallback
    const handleRouteChange = () => clearTimeout(timerId);
    window.addEventListener('popstate', handleRouteChange, { once: true });
    return () => {
      clearTimeout(timerId);
      window.removeEventListener('popstate', handleRouteChange);
    };
  }, [selectWorktree, router, closeMobileDrawer]);

  // Check if list is empty (for both modes)
  const isEmpty = viewMode === 'flat'
    ? flatBranches.length === 0
    : (groupedBranches?.length ?? 0) === 0;

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
          <div className="flex items-center gap-1">
            <ViewModeToggle viewMode={viewMode} onToggle={setViewMode} />
            <SortSelector />
            <SyncButton refreshWorktrees={refreshWorktrees} />
          </div>
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
            focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent
          "
        />
      </div>

      {/* Branch list */}
      <div
        data-testid="branch-list"
        className="flex-1 overflow-y-auto"
      >
        {isEmpty ? (
          <div className="px-4 py-8 text-center text-gray-400">
            {searchQuery ? 'No branches found' : 'No branches available'}
          </div>
        ) : viewMode === 'grouped' && groupedBranches ? (
          // Grouped view
          groupedBranches.map((group) => {
            const isExpanded = !groupCollapsed[group.repositoryName] || !!searchQuery.trim();
            return (
              <div key={group.repositoryName}>
                <GroupHeader
                  repositoryName={group.repositoryName}
                  branchCount={group.branches.length}
                  isExpanded={isExpanded}
                  onClick={() => toggleGroup(group.repositoryName)}
                />
                {isExpanded &&
                  group.branches.map((branch) => (
                    <BranchListItem
                      key={branch.id}
                      branch={branch}
                      isSelected={branch.id === selectedWorktreeId}
                      onClick={() => handleBranchClick(branch.id)}
                    />
                  ))}
              </div>
            );
          })
        ) : (
          // Flat view
          flatBranches.map((branch) => (
            <BranchListItem
              key={branch.id}
              branch={branch}
              isSelected={branch.id === selectedWorktreeId}
              onClick={() => handleBranchClick(branch.id)}
            />
          ))
        )}
      </div>

      {/* Footer: Language Switcher + Theme Toggle + Logout */}
      <div className="flex-shrink-0 px-4 py-3 border-t border-gray-700 space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <LocaleSwitcher />
          </div>
          <ThemeToggle />
        </div>
        <LogoutButton />
      </div>
    </nav>
  );
});

// ============================================================================
// Helper Functions
// ============================================================================

/** Maximum number of keys allowed in group collapsed state */
const MAX_GROUP_COLLAPSED_KEYS = 100;

/** Keys that are dangerous due to prototype pollution */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parse and validate group collapsed state from localStorage.
 * Includes prototype pollution protection and key limit.
 *
 * @internal Exported for unit testing only
 */
export function parseGroupCollapsed(raw: string): Record<string, boolean> {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const safe: Record<string, boolean> = {};
    let count = 0;
    for (const [key, value] of Object.entries(parsed)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      if (typeof value !== 'boolean') continue;
      if (++count > MAX_GROUP_COLLAPSED_KEYS) break;
      safe[key] = value;
    }
    return safe;
  } catch {
    return {};
  }
}

// ============================================================================
// Inline Sub-components
// ============================================================================

/** Group header showing repository name with collapse/expand toggle */
function GroupHeader({
  repositoryName,
  branchCount,
  isExpanded,
  onClick,
}: {
  repositoryName: string;
  branchCount: number;
  isExpanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      data-testid="group-header"
      type="button"
      onClick={onClick}
      aria-expanded={isExpanded}
      className="
        w-full flex items-center gap-2 px-4 py-2
        text-xs font-semibold text-gray-300 uppercase tracking-wider
        bg-gray-800/50 hover:bg-gray-800
        border-b border-gray-700
        focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cyan-500
        transition-colors
      "
    >
      <ChevronIcon isExpanded={isExpanded} />
      <GroupIcon />
      <span className="flex-1 text-left truncate">{repositoryName}</span>
      <span className="text-gray-500 font-normal">{branchCount}</span>
    </button>
  );
}

/** View mode toggle button */
function ViewModeToggle({
  viewMode,
  onToggle,
}: {
  viewMode: ViewMode;
  onToggle: (mode: ViewMode) => void;
}) {
  const handleClick = () => {
    onToggle(viewMode === 'grouped' ? 'flat' : 'grouped');
  };

  return (
    <button
      data-testid="view-mode-toggle"
      type="button"
      onClick={handleClick}
      aria-label={viewMode === 'grouped' ? 'Switch to flat view' : 'Switch to grouped view'}
      title={viewMode === 'grouped' ? 'Flat view' : 'Grouped view'}
      className="
        p-1 rounded text-gray-300 hover:text-white hover:bg-gray-700
        focus:outline-none focus:ring-2 focus:ring-blue-500
        transition-colors
      "
    >
      {viewMode === 'grouped' ? (
        <FlatListIcon className="w-3 h-3" />
      ) : (
        <GroupIcon className="w-3 h-3" />
      )}
    </button>
  );
}

/** Chevron icon for collapse/expand */
function ChevronIcon({ isExpanded }: { isExpanded: boolean }) {
  return (
    <svg
      className={`w-3 h-3 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}

/** Folder/group icon */
function GroupIcon({ className = 'w-3 h-3' }: { className?: string }) {
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
        d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
      />
    </svg>
  );
}

/** Flat list icon */
function FlatListIcon({ className = 'w-3 h-3' }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

/** Sync (refresh) icon - rotating arrows */
function SyncIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`w-3 h-3 ${className}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 4v5h5M20 20v-5h-5M20.49 9A9 9 0 005.64 5.64L4 4m16 16l-1.64-1.64A9 9 0 014.51 15"
      />
    </svg>
  );
}

/** Sync button with toast notifications */
const SyncButton = memo(function SyncButton({
  refreshWorktrees,
}: {
  refreshWorktrees: () => Promise<void>;
}) {
  const [isSyncing, setIsSyncing] = useState(false);
  const isSyncingRef = useRef(false);
  const { showToast, toasts, removeToast } = useToast();
  const t = useTranslations('common');

  const handleSync = useCallback(async () => {
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    setIsSyncing(true);
    try {
      const result = await repositoryApi.sync();
      await refreshWorktrees();
      showToast(
        t('syncSuccess', { count: result.worktreeCount }),
        'success',
        3000
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        showToast(t('syncAuthError'), 'error', 5000);
      } else {
        showToast(t('syncError'), 'error', 5000);
      }
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [refreshWorktrees, showToast, t]);

  return (
    <>
      <button
        type="button"
        onClick={handleSync}
        disabled={isSyncing}
        aria-label={t('syncButtonLabel')}
        className="p-1 rounded text-gray-300 hover:text-white hover:bg-gray-700
          focus:outline-none focus:ring-2 focus:ring-blue-500
          disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <SyncIcon className={isSyncing ? 'animate-spin' : ''} />
      </button>
      <ToastContainer toasts={toasts} onClose={removeToast} />
    </>
  );
});
