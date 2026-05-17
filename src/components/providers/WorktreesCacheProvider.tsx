/**
 * WorktreesCacheProvider - Bridges useWorktreesCache with React Context.
 *
 * Issue #600: UX refresh - Task 3.7. Provides a single source of truth for
 * worktree list data by feeding useWorktreesCache() results into
 * WorktreeSelectionProvider via the externalWorktrees prop.
 *
 * Issue #709: The cached values (worktrees / repositories / isLoading /
 * error / refresh) are also published through `WorktreesCacheContext` so
 * that pages such as `/sessions` can consume the same cache instead of
 * calling `useWorktreesCache()` again. Calling `useWorktreesCache()` twice
 * spawns two independent `setInterval` pollers and doubles the load on
 * `/api/worktrees`, which is the root cause behind the sidebar latency
 * tracked in Issue #709.
 */

'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  useWorktreesCache,
  type UseWorktreesCacheReturn,
} from '@/hooks/useWorktreesCache';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';

interface WorktreesCacheProviderProps {
  children: ReactNode;
}

/**
 * React Context that mirrors the return value of `useWorktreesCache`.
 *
 * Initial value is `null` so that calling `useWorktreesCacheContext()`
 * outside the Provider can be detected and reported as an explicit error.
 */
const WorktreesCacheContext = createContext<UseWorktreesCacheReturn | null>(null);

/**
 * Provider that wires `useWorktreesCache` into both `WorktreeSelectionProvider`
 * and the new `WorktreesCacheContext`.
 *
 * Usage: Place inside `SidebarProvider`; wraps children with
 * `WorktreeSelectionProvider` so that the existing
 * `externalWorktrees` / `externalRepositories` propagation keeps working
 * (Issue #600, Issue #690).
 *
 * Consumers that need the raw cache values (worktrees, repositories,
 * isLoading, error, refresh) should call `useWorktreesCacheContext()` —
 * see Issue #709 for the rationale.
 */
export function WorktreesCacheProvider({ children }: WorktreesCacheProviderProps) {
  const cache = useWorktreesCache();
  const { worktrees, repositories, isLoading, error, refresh } = cache;

  // Stable context value — only changes when one of the cache fields changes.
  // This prevents unnecessary re-renders of context consumers when the
  // hook itself recreates its return object but the underlying data is
  // the same reference.
  const contextValue = useMemo<UseWorktreesCacheReturn>(
    () => ({ worktrees, repositories, isLoading, error, refresh }),
    [worktrees, repositories, isLoading, error, refresh]
  );

  return (
    <WorktreesCacheContext.Provider value={contextValue}>
      <WorktreeSelectionProvider
        externalWorktrees={worktrees}
        externalRepositories={repositories}
      >
        {children}
      </WorktreeSelectionProvider>
    </WorktreesCacheContext.Provider>
  );
}

/**
 * Access the cached worktrees data published by `WorktreesCacheProvider`.
 *
 * @throws Error when called outside a `WorktreesCacheProvider`.
 *
 * Issue #709: prefer this hook over calling `useWorktreesCache` directly
 * to avoid creating a second polling loop against `/api/worktrees`.
 *
 * @example
 * ```tsx
 * function MyPage() {
 *   const { worktrees, isLoading, error, refresh } = useWorktreesCacheContext();
 *   // ...
 * }
 * ```
 */
export function useWorktreesCacheContext(): UseWorktreesCacheReturn {
  const ctx = useContext(WorktreesCacheContext);
  if (ctx === null) {
    throw new Error(
      'useWorktreesCacheContext must be used within a WorktreesCacheProvider'
    );
  }
  return ctx;
}
