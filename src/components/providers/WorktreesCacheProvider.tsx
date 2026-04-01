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
 */
export function WorktreesCacheProvider({ children }: WorktreesCacheProviderProps) {
  const { worktrees } = useWorktreesCache();

  return (
    <WorktreeSelectionProvider externalWorktrees={worktrees}>
      {children}
    </WorktreeSelectionProvider>
  );
}
