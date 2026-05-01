/**
 * WorktreesCacheProvider - Bridges useWorktreesCache with WorktreeSelectionProvider.
 *
 * Issue #600: UX refresh - Task 3.7
 * Provides a single source of truth for worktree list data by feeding
 * useWorktreesCache() results into WorktreeSelectionProvider via
 * the externalWorktrees prop.
 *
 * This replaces the duplicate polling that previously existed in
 * WorktreeSelectionContext.
 */

'use client';

import { type ReactNode } from 'react';
import { useWorktreesCache } from '@/hooks/useWorktreesCache';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';

interface WorktreesCacheProviderProps {
  children: ReactNode;
}

/**
 * Provider that wires useWorktreesCache into WorktreeSelectionProvider.
 *
 * Usage: Place inside SidebarProvider, wraps children with WorktreeSelectionProvider.
 *
 * Issue #690: Also propagates the cached `repositories` payload (with
 * `visible` / `enabled`) so the Sidebar can filter hidden repositories.
 */
export function WorktreesCacheProvider({ children }: WorktreesCacheProviderProps) {
  const { worktrees, repositories } = useWorktreesCache();

  return (
    <WorktreeSelectionProvider
      externalWorktrees={worktrees}
      externalRepositories={repositories}
    >
      {children}
    </WorktreeSelectionProvider>
  );
}
