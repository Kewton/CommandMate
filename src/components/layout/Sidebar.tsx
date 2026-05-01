/**
 * Sidebar Component
 *
 * Main sidebar component containing the branch list.
 * Includes search/filter functionality, branch status display,
 * and repository-based grouping (Issue #449).
 *
 * Issue #651: Compact w-56 sidebar + tooltips.
 * DnD group reordering (drag-and-drop) with DB persistence via /api/sidebar/group-order.
 */

'use client';

import React, { memo, useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
import type { SidebarBranchItem } from '@/types/sidebar';
import {
  generateRepositoryColor,
  buildHiddenRepositoryPathSet,
  filterWorktreesByVisibility,
} from '@/lib/sidebar-utils';
import { useWorktreeList } from '@/hooks/useWorktreeList';
import type { ViewMode } from '@/lib/sidebar-utils';
import type { BranchGroup } from '@/lib/sidebar-utils';

// ============================================================================
// Constants
// ============================================================================

/** LocalStorage key for group collapsed state */
const SIDEBAR_GROUP_COLLAPSED_STORAGE_KEY = 'mcbd-sidebar-group-collapsed';

/** LocalStorage key for branch list scroll position */
const SIDEBAR_SCROLL_TOP_STORAGE_KEY = 'mcbd-sidebar-scroll-top';

/** In-memory cache used across client-side remounts */
let lastSidebarScrollTop = 0;

function readSidebarScrollTop(): number {
  if (typeof window === 'undefined') return lastSidebarScrollTop;

  try {
    const stored = localStorage.getItem(SIDEBAR_SCROLL_TOP_STORAGE_KEY);
    if (!stored) {
      lastSidebarScrollTop = 0;
      return 0;
    }

    const parsed = Number(stored);
    if (Number.isFinite(parsed) && parsed >= 0) {
      lastSidebarScrollTop = parsed;
    }
  } catch {
    // Ignore localStorage errors
  }

  return lastSidebarScrollTop;
}

function persistSidebarScrollTop(scrollTop: number): void {
  const normalized = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  lastSidebarScrollTop = normalized;

  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(SIDEBAR_SCROLL_TOP_STORAGE_KEY, String(normalized));
  } catch {
    // Ignore localStorage errors
  }
}

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
  const {
    worktrees,
    repositories,
    selectedWorktreeId,
    selectWorktree,
    refreshWorktrees,
  } = useWorktreeSelection();
  const { closeMobileDrawer, sortKey, sortDirection, viewMode, setViewMode } = useSidebarContext();
  const [searchQuery, setSearchQuery] = useState('');
  const branchListRef = useRef<HTMLDivElement>(null);

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

  // Repository group display order (DB-backed, fetched on mount)
  const [repositoryOrder, setRepositoryOrder] = useState<string[]>([]);
  const orderLoadedRef = useRef(false);

  // Fetch saved group order from server on mount
  useEffect(() => {
    if (orderLoadedRef.current) return;
    orderLoadedRef.current = true;

    fetch('/api/sidebar/group-order')
      .then((res) => res.json())
      .then((data: { success: boolean; order: string[] | null }) => {
        if (data.success && Array.isArray(data.order)) {
          setRepositoryOrder(data.order);
        }
      })
      .catch(() => {
        // Non-fatal: fall back to alphabetical order
      });
  }, []);

  // Issue #690: Filter out worktrees whose repository is hidden (visible=false).
  // This is a Sidebar-local filter — useWorktreeList is intentionally not
  // modified so the Sessions/Review screens continue to show every worktree
  // for management purposes.
  // See `buildHiddenRepositoryPathSet` / `filterWorktreesByVisibility` in
  // sidebar-utils for the matching rules and legacy-row fallback.
  const hiddenRepositoryPaths = useMemo(
    () => buildHiddenRepositoryPathSet(repositories),
    [repositories]
  );

  const visibleWorktrees = useMemo(
    () => filterWorktreesByVisibility(worktrees, hiddenRepositoryPaths),
    [worktrees, hiddenRepositoryPaths]
  );

  // Convert worktrees to sidebar items
  const branchItems = useMemo(() => visibleWorktrees.map(toBranchItem), [visibleWorktrees]);

  // ---- Hover-freeze: snapshot list ORDER while cursor is over the branch list ----
  // Polling updates lastActivity every 5s for active sessions, causing sort-order
  // changes that visually reorder the list while the user is interacting with it.
  // We freeze the display ORDER while the cursor is inside the list (and for 1s
  // after it leaves) so items never jump under the pointer or during a click.
  // Item DATA (status dots, hasUnread, description) remains live — only positions
  // are frozen. This prevents both the visible reorder flash and scroll position
  // shifts caused by items moving above the viewport mid-interaction.
  const frozenBranchItemsRef = useRef<{
    items: SidebarBranchItem[];
    expiresAt: number;
  } | null>(null);
  const [freezeVersion, setFreezeVersion] = useState(0);
  const freezeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (freezeTimerRef.current !== null) clearTimeout(freezeTimerRef.current);
  }, []);

  const effectiveBranchItems = useMemo(() => {
    void freezeVersion;
    const frozen = frozenBranchItemsRef.current;
    if (!frozen || Date.now() >= frozen.expiresAt) return branchItems;
    // Live data, frozen order: preserve positions from the hover-time snapshot
    // but replace each item's data with the latest live version so status dots
    // and unread indicators continue to update while positions stay stable.
    const liveById = new Map(branchItems.map(item => [item.id, item]));
    const frozenIds = new Set(frozen.items.map(item => item.id));
    return [
      ...frozen.items
        .filter(item => liveById.has(item.id))
        .map(item => liveById.get(item.id)!),
      // Items that appeared after the freeze was taken append at the end
      ...branchItems.filter(item => !frozenIds.has(item.id)),
    ];
  }, [branchItems, freezeVersion]);

  // Activate freeze when cursor enters the branch list: snapshot current order,
  // hold indefinitely until cursor leaves. Capturing branchItems here is
  // intentional — this is the order we want to lock in.
  const handleListMouseEnter = useCallback(() => {
    if (freezeTimerRef.current !== null) {
      clearTimeout(freezeTimerRef.current);
      freezeTimerRef.current = null;
    }
    frozenBranchItemsRef.current = { items: branchItems, expiresAt: Infinity };
    setFreezeVersion(v => v + 1);
  }, [branchItems]);

  // Hold freeze for 1s after cursor leaves (covers click + re-render settling),
  // then release so the list reflects the live order again.
  const handleListMouseLeave = useCallback(() => {
    if (!frozenBranchItemsRef.current) return;
    frozenBranchItemsRef.current = { ...frozenBranchItemsRef.current, expiresAt: Date.now() + 1000 };
    if (freezeTimerRef.current !== null) clearTimeout(freezeTimerRef.current);
    freezeTimerRef.current = setTimeout(() => {
      frozenBranchItemsRef.current = null;
      setFreezeVersion(v => v + 1);
    }, 1000);
  }, []);
  // ---- end hover-freeze ----

  // Use shared useWorktreeList hook for sorting, filtering, and grouping (Issue #600 Task 3.8)
  const { sortedItems: flatBranches, groupedItems } = useWorktreeList({
    items: effectiveBranchItems,
    sortKey,
    sortDirection,
    viewMode,
    filterText: searchQuery,
  });

  // Apply saved repository order to groupedItems (only when not searching)
  const orderedGroups: BranchGroup[] | null = useMemo(() => {
    if (viewMode !== 'grouped' || !groupedItems) return null;

    if (searchQuery.trim() || repositoryOrder.length === 0) {
      // No custom order: use default (alphabetical from groupBranches)
      return groupedItems;
    }

    // Place known repos first in saved order, then append any new repos at end
    const orderMap = new Map(repositoryOrder.map((name, idx) => [name, idx]));
    return [...groupedItems].sort((a, b) => {
      const ia = orderMap.has(a.repositoryName) ? orderMap.get(a.repositoryName)! : Infinity;
      const ib = orderMap.has(b.repositoryName) ? orderMap.get(b.repositoryName)! : Infinity;
      if (ia === ib) return a.repositoryName.localeCompare(b.repositoryName);
      return ia - ib;
    });
  }, [viewMode, groupedItems, repositoryOrder, searchQuery]);

  // Adapt groupedItems to match previous interface (null when flat mode)
  const groupedBranches = viewMode === 'grouped' ? orderedGroups : null;

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

  const saveBranchListScroll = useCallback(() => {
    persistSidebarScrollTop(branchListRef.current?.scrollTop ?? 0);
  }, []);

  // Restore saved scroll position when items first appear (initial data load) and
  // on viewMode change. Intentionally NOT triggered by every list-length change —
  // that would cause visible scroll jumps whenever the hover-freeze/unfreeze cycle
  // briefly changes the rendered item count.
  const hasAnyItems = flatBranches.length > 0 || (groupedBranches?.length ?? 0) > 0;
  useEffect(() => {
    const branchList = branchListRef.current;
    if (!branchList) return;

    const frameId = window.requestAnimationFrame(() => {
      branchList.scrollTop = readSidebarScrollTop();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [hasAnyItems, viewMode]);

  // Handle branch selection.
  // Note: no fallback timer — Next.js App Router defers history.pushState to a React
  // effect, so window.location.pathname does not update synchronously with router.push().
  // A fallback timer that checks window.location.pathname would fire before the URL
  // updates and trigger a spurious full-page reload on every navigation.
  const handleBranchClick = useCallback((branchId: string) => {
    saveBranchListScroll();
    selectWorktree(branchId);
    router.push(`/worktrees/${branchId}`);
    closeMobileDrawer();
  }, [saveBranchListScroll, selectWorktree, router, closeMobileDrawer]);

  // DnD sensors: require 8px move before activating (distinguishes click from drag)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  // Handle group reorder via DnD
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id || !groupedBranches) return;

      const currentOrder = groupedBranches.map((g) => g.repositoryName);
      const oldIndex = currentOrder.indexOf(String(active.id));
      const newIndex = currentOrder.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1) return;

      const newOrder = arrayMove(currentOrder, oldIndex, newIndex);

      // Optimistic update
      setRepositoryOrder(newOrder);

      // Persist to server
      fetch('/api/sidebar/group-order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: newOrder }),
      }).catch(() => {
        // Revert on error
        setRepositoryOrder(currentOrder);
      });
    },
    [groupedBranches]
  );

  // Check if list is empty (for both modes)
  const isEmpty = viewMode === 'flat'
    ? flatBranches.length === 0
    : (groupedBranches?.length ?? 0) === 0;

  return (
    <nav
      data-testid="sidebar"
      aria-label="Branch navigation"
      className="h-full flex flex-col bg-gray-800 text-white"
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
            bg-gray-700 text-white placeholder-gray-400
            border border-gray-600
            focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent
          "
        />
      </div>

      {/* Branch list */}
      <div
        ref={branchListRef}
        data-testid="branch-list"
        onScroll={saveBranchListScroll}
        onMouseEnter={handleListMouseEnter}
        onMouseLeave={handleListMouseLeave}
        className="flex-1 overflow-y-auto"
      >
        {isEmpty ? (
          <div className="px-4 py-8 text-center text-gray-400">
            {searchQuery ? 'No branches found' : 'No branches available'}
          </div>
        ) : viewMode === 'grouped' && groupedBranches ? (
          // Grouped view with DnD reordering
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={groupedBranches.map((g) => g.repositoryName)}
              strategy={verticalListSortingStrategy}
            >
              {groupedBranches.map((group) => {
                const isExpanded = !groupCollapsed[group.repositoryName] || !!searchQuery.trim();
                return (
                  <SortableGroupItem
                    key={group.repositoryName}
                    group={group}
                    isExpanded={isExpanded}
                    selectedWorktreeId={selectedWorktreeId}
                    onToggle={() => toggleGroup(group.repositoryName)}
                    onBranchClick={handleBranchClick}
                    isDragDisabled={!!searchQuery.trim()}
                  />
                );
              })}
            </SortableContext>
          </DndContext>
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
// SortableGroupItem
// ============================================================================

/** Sortable wrapper for a repository group (DnD-enabled) */
function SortableGroupItem({
  group,
  isExpanded,
  selectedWorktreeId,
  onToggle,
  onBranchClick,
  isDragDisabled,
}: {
  group: BranchGroup;
  isExpanded: boolean;
  selectedWorktreeId: string | null;
  onToggle: () => void;
  onBranchClick: (branchId: string) => void;
  isDragDisabled: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: group.repositoryName, disabled: isDragDisabled });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <GroupHeader
        repositoryName={group.repositoryName}
        branchCount={group.branches.length}
        isExpanded={isExpanded}
        onClick={onToggle}
        dragHandleRef={setActivatorNodeRef}
        dragHandleListeners={isDragDisabled ? undefined : listeners}
        dragHandleAttributes={isDragDisabled ? undefined : attributes}
      />
      {isExpanded &&
        group.branches.map((branch) => (
          <BranchListItem
            key={branch.id}
            branch={branch}
            isSelected={branch.id === selectedWorktreeId}
            onClick={() => onBranchClick(branch.id)}
            showRepositoryName={false}
          />
        ))}
    </div>
  );
}

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

/** Group header showing repository name with collapse/expand toggle and drag handle */
function GroupHeader({
  repositoryName,
  branchCount,
  isExpanded,
  onClick,
  dragHandleRef,
  dragHandleListeners,
  dragHandleAttributes,
}: {
  repositoryName: string;
  branchCount: number;
  isExpanded: boolean;
  onClick: () => void;
  dragHandleRef?: (node: HTMLElement | null) => void;
  dragHandleListeners?: React.HTMLAttributes<HTMLElement>;
  dragHandleAttributes?: React.HTMLAttributes<HTMLElement>;
}) {
  return (
    <div className="flex items-center w-full">
      {/* Drag handle — separate from the clickable header button */}
      {dragHandleListeners && (
        <div
          ref={dragHandleRef}
          {...dragHandleListeners}
          {...dragHandleAttributes}
          aria-label="Drag to reorder group"
          className="
            flex-shrink-0 flex items-center justify-center
            w-6 h-full pl-2 cursor-grab active:cursor-grabbing
            text-gray-500 hover:text-gray-300 transition-colors
          "
        >
          <GripVerticalIcon />
        </div>
      )}

      <button
        data-testid="group-header"
        type="button"
        onClick={onClick}
        aria-expanded={isExpanded}
        className="
          flex-1 flex items-center gap-2 px-2 py-2
          text-xs font-semibold text-gray-300 uppercase tracking-wider
          focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cyan-500
          transition-colors
        "
      >
        <ChevronIcon isExpanded={isExpanded} />
        <GroupIcon color={generateRepositoryColor(repositoryName)} />
        <span className="flex-1 text-left truncate">{repositoryName}</span>
        <span className="text-gray-500 font-normal pr-2">{branchCount}</span>
      </button>
    </div>
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

/** Folder/group icon with optional repository color */
function GroupIcon({ className = 'w-3.5 h-3.5', color }: { className?: string; color?: string }) {
  return (
    <svg
      className={`${className} flex-shrink-0`}
      viewBox="0 0 24 24"
      fill={color ?? 'none'}
      stroke={color ? 'none' : 'currentColor'}
      strokeWidth={color ? 0 : 2}
      aria-hidden="true"
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

/** Grip vertical (drag handle) icon */
function GripVerticalIcon() {
  return (
    <svg
      className="w-3 h-3"
      fill="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="9" cy="5" r="1.5" />
      <circle cx="15" cy="5" r="1.5" />
      <circle cx="9" cy="12" r="1.5" />
      <circle cx="15" cy="12" r="1.5" />
      <circle cx="9" cy="19" r="1.5" />
      <circle cx="15" cy="19" r="1.5" />
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
