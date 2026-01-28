/**
 * WorktreeList Component
 * Fetches and displays list of worktrees with real-time updates
 */

'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { WorktreeCard } from './WorktreeCard';
import { Button, Badge } from '@/components/ui';
import { worktreeApi, handleApiError, type RepositorySummary } from '@/lib/api-client';
import { useWebSocket, type WebSocketMessage, type SessionStatusPayload, type BroadcastPayload } from '@/hooks/useWebSocket';
import type { Worktree } from '@/types/models';

export type SortOption = 'name' | 'updated' | 'favorite';
export type SortDirection = 'asc' | 'desc';

export interface WorktreeListProps {
  /** Initial worktrees (optional for SSR) */
  initialWorktrees?: Worktree[];
}

/**
 * List component for displaying all worktrees
 *
 * @example
 * ```tsx
 * <WorktreeList />
 * ```
 */
export function WorktreeList({ initialWorktrees = [] }: WorktreeListProps) {
  const [worktrees, setWorktrees] = useState<Worktree[]>(initialWorktrees);
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [loading, setLoading] = useState(!initialWorktrees.length);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('updated');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [selectedRepository, setSelectedRepository] = useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<'todo' | 'doing' | 'done' | 'unset' | null>(null);

  /**
   * Fetch worktrees from API
   * @param silent - If true, don't show loading indicator (for background updates)
   */
  const fetchWorktrees = useCallback(async (silent: boolean = false) => {
    try {
      if (!silent) {
        setLoading(true);
      }
      setError(null);
      const data = await worktreeApi.getAll();
      setWorktrees(data.worktrees);
      setRepositories(data.repositories);
    } catch (err) {
      setError(handleApiError(err));
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, []);

  /**
   * Handle WebSocket messages
   */
  const isSessionStatusPayload = (payload: BroadcastPayload | undefined): payload is SessionStatusPayload => {
    return Boolean(payload && payload.type === 'session_status_changed');
  };

  const handleWebSocketMessage = useCallback((message: WebSocketMessage) => {
    if (isSessionStatusPayload(message.data)) {
      const payload = message.data;
      // Update specific worktree's session status without full refresh
      setWorktrees((prev) =>
        prev.map((wt) =>
          wt.id === payload.worktreeId
            ? { ...wt, isSessionRunning: payload.isRunning }
            : wt
        )
      );
    }

    if (message.type === 'broadcast') {
      // Refresh worktrees when updates occur (silent mode)
      fetchWorktrees(true);
    }
  }, [fetchWorktrees]);

  // WebSocket connection for real-time updates
  const { status: wsStatus } = useWebSocket({
    onMessage: handleWebSocketMessage,
  });

  // Fetch worktrees on mount
  useEffect(() => {
    if (!initialWorktrees.length) {
      fetchWorktrees();
    }
  }, [initialWorktrees.length, fetchWorktrees]);

  // Auto-refresh worktrees every 5 seconds (silent mode)
  useEffect(() => {
    const interval = setInterval(() => {
      fetchWorktrees(true); // Silent update
    }, 5000); // 5 seconds

    return () => clearInterval(interval);
  }, [fetchWorktrees]);

  /**
   * Filter and sort worktrees
   */
  const filteredAndSortedWorktrees = useMemo(() => {
    let result = [...worktrees];

    // Filter by repository
    if (selectedRepository) {
      result = result.filter((wt) => wt.repositoryPath === selectedRepository);
    }

    // Filter by status
    if (selectedStatus !== null) {
      if (selectedStatus === 'unset') {
        result = result.filter((wt) => !wt.status);
      } else {
        result = result.filter((wt) => wt.status === selectedStatus);
      }
    }

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (wt) =>
          wt.name.toLowerCase().includes(query) ||
          wt.path.toLowerCase().includes(query) ||
          wt.repositoryName.toLowerCase().includes(query) ||
          wt.lastMessageSummary?.toLowerCase().includes(query) ||
          wt.description?.toLowerCase().includes(query)
      );
    }

    // Sort
    result.sort((a, b) => {
      let compareValue = 0;

      switch (sortBy) {
        case 'name':
          compareValue = a.name.localeCompare(b.name);
          break;
        case 'updated':
          const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          compareValue = aTime - bTime;
          break;
        case 'favorite':
          const aFav = a.favorite ? 1 : 0;
          const bFav = b.favorite ? 1 : 0;
          compareValue = aFav - bFav;
          break;
      }

      return sortDirection === 'asc' ? compareValue : -compareValue;
    });

    return result;
  }, [worktrees, selectedRepository, selectedStatus, searchQuery, sortBy, sortDirection]);

  /**
   * Group worktrees by repository
   */
  const worktreesByRepository = useMemo(() => {
    const grouped = new Map<string, Worktree[]>();

    for (const wt of filteredAndSortedWorktrees) {
      const repoPath = wt.repositoryPath || 'unknown';
      if (!grouped.has(repoPath)) {
        grouped.set(repoPath, []);
      }
      grouped.get(repoPath)!.push(wt);
    }

    return grouped;
  }, [filteredAndSortedWorktrees]);

  /**
   * Toggle sort direction
   */
  const toggleSort = (option: SortOption) => {
    if (sortBy === option) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(option);
      setSortDirection('asc');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header with Badges and Refresh */}
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="gray">{worktrees.length} branches</Badge>
          {repositories.length > 0 && (
            <Badge variant="info">{repositories.length} {repositories.length === 1 ? 'repository' : 'repositories'}</Badge>
          )}
          {wsStatus === 'connected' && (
            <Badge variant="success" dot>
              Live
            </Badge>
          )}
        </div>

        <div className="flex gap-2 w-full sm:w-auto">
          <Button variant="secondary" size="sm" onClick={() => fetchWorktrees()} disabled={loading}>
            {loading ? 'Loading...' : 'Refresh'}
          </Button>
        </div>
      </div>

      {/* Search Bar - First */}
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          type="text"
          placeholder="Search worktrees..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="input flex-1"
        />
      </div>

      {/* Repository Filter */}
      {repositories.length > 1 && (
        <div className="flex gap-2 flex-wrap items-center">
          <Button
            variant={selectedRepository === null ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setSelectedRepository(null)}
          >
            All ({worktrees.length})
          </Button>
          {repositories.map((repo) => (
            <Button
              key={repo.path}
              variant={selectedRepository === repo.path ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setSelectedRepository(repo.path)}
            >
              {repo.name} ({repo.worktreeCount})
            </Button>
          ))}
        </div>
      )}

      {/* Status Filter */}
      <div className="flex gap-2 flex-wrap items-center">
        <Button
          variant={selectedStatus === null ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => setSelectedStatus(null)}
        >
          All
        </Button>
        <Button
          variant={selectedStatus === 'todo' ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => setSelectedStatus('todo')}
        >
          📝 ToDo
        </Button>
        <Button
          variant={selectedStatus === 'doing' ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => setSelectedStatus('doing')}
        >
          🚧 Doing
        </Button>
        <Button
          variant={selectedStatus === 'done' ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => setSelectedStatus('done')}
        >
          ✅ Done
        </Button>
        <Button
          variant={selectedStatus === 'unset' ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => setSelectedStatus('unset')}
        >
          Not set
        </Button>
      </div>

      {/* Sort Options */}
      <div className="flex gap-2 flex-wrap">
        <span className="text-sm text-gray-600 self-center">Sort by:</span>
        <Button
          variant={sortBy === 'favorite' ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => toggleSort('favorite')}
        >
          ⭐ Favorite {sortBy === 'favorite' && (sortDirection === 'asc' ? '↑' : '↓')}
        </Button>
        <Button
          variant={sortBy === 'name' ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => toggleSort('name')}
        >
          Name {sortBy === 'name' && (sortDirection === 'asc' ? '↑' : '↓')}
        </Button>
        <Button
          variant={sortBy === 'updated' ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => toggleSort('updated')}
        >
          Updated {sortBy === 'updated' && (sortDirection === 'asc' ? '↑' : '↓')}
        </Button>
      </div>

      {/* Error State */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Loading State */}
      {loading && !worktrees.length && (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-gray-300 border-t-blue-600" />
          <p className="mt-4 text-gray-600">Loading worktrees...</p>
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && filteredAndSortedWorktrees.length === 0 && (
        <div className="text-center py-12">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
            />
          </svg>
          <p className="mt-4 text-gray-600">
            {searchQuery ? 'No worktrees found matching your search' : 'No worktrees found'}
          </p>
        </div>
      )}

      {/* Worktree Grid - Grouped by Repository */}
      {!loading && filteredAndSortedWorktrees.length > 0 && (
        <div className="space-y-8">
          {Array.from(worktreesByRepository.entries()).map(([repoPath, repoWorktrees]) => {
            const repoInfo = repositories.find((r) => r.path === repoPath);
            const repoName = repoInfo?.name || 'Unknown Repository';

            return (
              <div key={repoPath} className="space-y-4">
                {/* Repository Header (only show if multiple repositories or not filtered) */}
                {(repositories.length > 1 || !selectedRepository) && (
                  <div className="flex items-center gap-3 pb-2 border-b border-gray-200">
                    <h3 className="text-xl font-semibold text-gray-900">{repoName}</h3>
                    <Badge variant="gray">{repoWorktrees.length}</Badge>
                  </div>
                )}

                {/* Worktree Cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {repoWorktrees.map((worktree) => (
                    <WorktreeCard
                      key={worktree.id}
                      worktree={worktree}
                      onSessionKilled={fetchWorktrees}
                      onStatusChanged={fetchWorktrees}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
