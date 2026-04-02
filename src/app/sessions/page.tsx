/**
 * Sessions Page (/sessions)
 *
 * Issue #600: UX refresh - Worktree exploration, search, and filtering.
 * Issue #606: Sessions enhancement - sort options and last sent message display.
 * Uses useWorktreesCache() for shared logic [DR1-005].
 * Sidebar auto-collapses on this page (via useLayoutConfig).
 */

'use client';

import { useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/layout';
import { useWorktreesCache } from '@/hooks/useWorktreesCache';
import { deriveCliStatus } from '@/types/sidebar';
import { getCliToolDisplayName } from '@/lib/cli-tools/types';
import { SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';
import { DEFAULT_SELECTED_AGENTS } from '@/lib/selected-agents-validator';
import { SortSelectorBase } from '@/components/sidebar/SortSelectorBase';
import { compareByTimestamp } from '@/lib/sidebar-utils';
import { formatRelativeTime } from '@/lib/date-utils';
import {
  MESSAGE_PREVIEW_MAX_LENGTH_PC,
  MESSAGE_PREVIEW_MAX_LENGTH_SP,
  sanitizePreview,
} from '@/config/message-preview-config';
import type { SortKey, SortDirection } from '@/lib/sidebar-utils';
import type { SortOption } from '@/components/sidebar/SortSelectorBase';
import type { Worktree } from '@/types/models';
import type { BranchStatus } from '@/types/sidebar';

// ============================================================================
// Constants
// ============================================================================

/** Sort options for Sessions page (includes lastSent, no branchName/updatedAt) [CON-002] */
const SESSIONS_SORT_OPTIONS: ReadonlyArray<SortOption> = [
  { key: 'repositoryName', label: 'Repository' },
  { key: 'status', label: 'Status' },
  { key: 'lastSent', label: 'Last Sent' },
];

/** Default directions for Sessions sort keys */
const SESSIONS_DEFAULT_DIRECTIONS: Partial<Record<SortKey, SortDirection>> = {
  lastSent: 'desc',
  updatedAt: 'desc',
};

/** Status priority for sorting (lower = higher priority) */
const WORKTREE_STATUS_PRIORITY: Record<string, number> = {
  ready: 0,
  in_progress: 1,
  in_review: 2,
  done: 3,
};

/** Default priority for null/unknown status */
const DEFAULT_STATUS_PRIORITY = 4;

// ============================================================================
// Helpers
// ============================================================================

/** Small CLI status dot for Sessions list */
function CliDot({ status, label }: { status: BranchStatus; label: string }) {
  const config = SIDEBAR_STATUS_CONFIG[status];
  const title = `${label}: ${config.label}`;
  const base = 'w-2.5 h-2.5 rounded-full flex-shrink-0';

  if (config.type === 'spinner') {
    return (
      <span
        className={`${base} border-2 border-t-transparent animate-spin ${config.className}`}
        title={title}
      />
    );
  }
  return <span className={`${base} ${config.className}`} title={title} />;
}

/** Format status display label */
function formatStatus(status: string | null | undefined): string {
  if (!status) return '';
  switch (status) {
    case 'ready': return 'Ready';
    case 'in_progress': return 'In Progress';
    case 'in_review': return 'In Review';
    case 'done': return 'Done';
    default: return status;
  }
}

// ============================================================================
// Component
// ============================================================================

export default function SessionsPage() {
  const { worktrees, isLoading, error } = useWorktreesCache();
  const [filterText, setFilterText] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('lastSent');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const filteredAndSorted = useMemo(() => {
    let result = worktrees;

    // Filter
    if (filterText) {
      const lower = filterText.toLowerCase();
      result = result.filter(
        (wt) =>
          wt.name.toLowerCase().includes(lower) ||
          wt.repositoryName.toLowerCase().includes(lower)
      );
    }

    // Sort
    const sorted = [...result];
    sorted.sort((a, b) => {
      let comparison = 0;

      switch (sortKey) {
        case 'lastSent': {
          const cmp = compareByTimestamp(a.lastUserMessageAt, b.lastUserMessageAt);
          // Null values go to end regardless of direction
          if (!a.lastUserMessageAt && !b.lastUserMessageAt) return 0;
          if (!a.lastUserMessageAt) return 1;
          if (!b.lastUserMessageAt) return -1;
          comparison = cmp;
          break;
        }
        case 'repositoryName': {
          comparison = a.repositoryName.toLowerCase().localeCompare(b.repositoryName.toLowerCase());
          break;
        }
        case 'status': {
          const priorityA = WORKTREE_STATUS_PRIORITY[a.status ?? ''] ?? DEFAULT_STATUS_PRIORITY;
          const priorityB = WORKTREE_STATUS_PRIORITY[b.status ?? ''] ?? DEFAULT_STATUS_PRIORITY;
          comparison = priorityA - priorityB;
          break;
        }
        default:
          comparison = 0;
          break;
      }

      // Apply direction
      const isDescDefault = sortKey === 'lastSent';
      const isDefaultDirection = isDescDefault ? sortDirection === 'desc' : sortDirection === 'asc';
      return isDefaultDirection ? comparison : -comparison;
    });

    return sorted;
  }, [worktrees, filterText, sortKey, sortDirection]);

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

        {/* Search / Filter + Sort */}
        <div className="mb-6 flex items-center gap-4">
          <input
            type="text"
            placeholder="Filter by name or repository..."
            value={filterText}
            onChange={handleFilterChange}
            className="flex-1 max-w-md px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
            data-testid="sessions-filter"
          />
          <SortSelectorBase
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSortKeyChange={setSortKey}
            onSortDirectionChange={setSortDirection}
            options={SESSIONS_SORT_OPTIONS}
            defaultDirections={SESSIONS_DEFAULT_DIRECTIONS}
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
            {filteredAndSorted.length === 0 ? (
              <div className="text-gray-500 dark:text-gray-400 py-8 text-center" data-testid="sessions-empty">
                {filterText ? 'No matching sessions found.' : 'No sessions yet.'}
              </div>
            ) : (
              filteredAndSorted.map((wt: Worktree) => {
                const agents = wt.selectedAgents ?? DEFAULT_SELECTED_AGENTS;
                const sanitizedMessage = wt.lastUserMessage
                  ? sanitizePreview(wt.lastUserMessage)
                  : null;
                const relativeTime = wt.lastUserMessageAt
                  ? formatRelativeTime(String(wt.lastUserMessageAt))
                  : null;

                return (
                  <Link
                    key={wt.id}
                    href={`/worktrees/${wt.id}`}
                    className="block bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700 hover:border-cyan-300 dark:hover:border-cyan-700 transition-colors"
                    data-testid={`session-item-${wt.id}`}
                  >
                    {/* Row 1: Name, Agent statuses */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                          {wt.name}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                          {wt.repositoryName}
                        </div>
                      </div>

                      {/* Per-agent status dots */}
                      <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                        {agents.map((agent) => {
                          const agentStatus = deriveCliStatus(wt.sessionStatusByCli?.[agent]);
                          return (
                            <div key={agent} className="flex items-center gap-1" data-testid={`session-agent-${agent}`}>
                              <CliDot status={agentStatus} label={getCliToolDisplayName(agent)} />
                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                {getCliToolDisplayName(agent)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Row 2: Description (if present) */}
                    {wt.description && (
                      <div className="mt-2">
                        <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 whitespace-pre-wrap">
                          {wt.description}
                        </p>
                      </div>
                    )}

                    {/* Row 3: Status badge (read-only) */}
                    {wt.status && (
                      <div className="mt-2">
                        <span className={`px-2 py-0.5 text-xs font-medium rounded ${
                          wt.status === 'done'
                            ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                            : wt.status === 'in_review'
                            ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400'
                            : wt.status === 'in_progress'
                            ? 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-400'
                            : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                        }`}>
                          {formatStatus(wt.status)}
                        </span>
                      </div>
                    )}

                    {/* Row 4: Last sent message preview + relative time [Issue #606] */}
                    {sanitizedMessage && (
                      <div className="mt-2 flex items-center gap-2" data-testid={`session-message-${wt.id}`}>
                        <span className="text-xs text-gray-500 dark:text-gray-400 truncate min-w-0 flex-1">
                          {/* PC preview (md and above) */}
                          <span className="hidden md:inline" data-testid={`session-message-pc-${wt.id}`}>
                            {sanitizedMessage.slice(0, MESSAGE_PREVIEW_MAX_LENGTH_PC)}
                            {sanitizedMessage.length > MESSAGE_PREVIEW_MAX_LENGTH_PC ? '...' : ''}
                          </span>
                          {/* SP preview (below md) */}
                          <span className="inline md:hidden" data-testid={`session-message-sp-${wt.id}`}>
                            {sanitizedMessage.slice(0, MESSAGE_PREVIEW_MAX_LENGTH_SP)}
                            {sanitizedMessage.length > MESSAGE_PREVIEW_MAX_LENGTH_SP ? '...' : ''}
                          </span>
                        </span>
                        {relativeTime && (
                          <span
                            className="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0 whitespace-nowrap"
                            data-testid={`session-time-${wt.id}`}
                          >
                            {relativeTime}
                          </span>
                        )}
                      </div>
                    )}
                  </Link>
                );
              })
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
