/**
 * Sessions Page (/sessions)
 *
 * Issue #600: UX refresh - Worktree exploration, search, and filtering.
 * Uses useWorktreeList() and useWorktreesCache() for shared logic [DR1-005].
 * Sidebar auto-collapses on this page (via useLayoutConfig).
 */

'use client';

import { useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/layout';
import { useWorktreesCache } from '@/hooks/useWorktreesCache';
import type { Worktree } from '@/types/models';

export default function SessionsPage() {
  const { worktrees, isLoading, error } = useWorktreesCache();
  const [filterText, setFilterText] = useState('');

  const filteredWorktrees = useMemo(() => {
    if (!filterText) return worktrees;
    const lower = filterText.toLowerCase();
    return worktrees.filter(
      (wt) =>
        wt.name.toLowerCase().includes(lower) ||
        wt.repositoryName.toLowerCase().includes(lower)
    );
  }, [worktrees, filterText]);

  const handleFilterChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setFilterText(e.target.value);
  }, []);

  return (
    <AppShell>
      <div className="container-custom py-8 overflow-auto h-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">Sessions</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            All worktree sessions across repositories.
          </p>
        </div>

        {/* Search / Filter */}
        <div className="mb-6">
          <input
            type="text"
            placeholder="Filter by name or repository..."
            value={filterText}
            onChange={handleFilterChange}
            className="w-full max-w-md px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
            data-testid="sessions-filter"
          />
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="text-gray-500 dark:text-gray-400" data-testid="sessions-loading">
            Loading sessions...
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="text-red-500 dark:text-red-400" data-testid="sessions-error">
            Failed to load sessions: {error.message}
          </div>
        )}

        {/* Session list */}
        {!isLoading && !error && (
          <div className="space-y-2" data-testid="sessions-list">
            {filteredWorktrees.length === 0 ? (
              <div className="text-gray-500 dark:text-gray-400 py-8 text-center" data-testid="sessions-empty">
                {filterText ? 'No matching sessions found.' : 'No sessions yet.'}
              </div>
            ) : (
              filteredWorktrees.map((wt: Worktree) => (
                <Link
                  key={wt.id}
                  href={`/worktrees/${wt.id}`}
                  className="block bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700 hover:border-cyan-300 dark:hover:border-cyan-700 transition-colors"
                  data-testid={`session-item-${wt.id}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {wt.name}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {wt.repositoryName}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      {wt.cliToolId && (
                        <span className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                          {wt.cliToolId}
                        </span>
                      )}
                      {wt.status && (
                        <span className={`text-xs px-2 py-0.5 rounded ${
                          wt.status === 'done'
                            ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                            : wt.status === 'doing'
                            ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                            : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                        }`}>
                          {wt.status}
                        </span>
                      )}
                      {wt.isSessionRunning && (
                        <span className="w-2 h-2 rounded-full bg-green-500" title="Running" />
                      )}
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
