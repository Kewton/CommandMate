/**
 * Sessions Page (/sessions)
 *
 * Issue #600: UX refresh - Worktree exploration, search, and filtering.
 * Issue #606: Sessions enhancement - sort options and last sent message display.
 * Issue #709: Reads cached worktrees through `useWorktreesCacheContext()`
 * instead of `useWorktreesCache()` directly so the page shares a single
 * polling loop with `WorktreesCacheProvider` (otherwise `/api/worktrees`
 * is polled twice while this page is mounted).
 *
 * Sidebar auto-collapses on this page (via useLayoutConfig).
 */

'use client';

import { useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { AppShell } from '@/components/layout';
import { useWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import { deriveCliStatus } from '@/types/sidebar';
import { getCliToolDisplayName } from '@/lib/cli-tools/types';
import { SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';
import { DEFAULT_SELECTED_AGENTS } from '@/lib/selected-agents-validator';
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import { compareByTimestamp } from '@/lib/sidebar-utils';
import { formatRelativeTime } from '@/lib/date-utils';
import {
  MESSAGE_PREVIEW_MAX_LENGTH_PC,
  MESSAGE_PREVIEW_MAX_LENGTH_SP,
  sanitizePreview,
} from '@/config/message-preview-config';
import type { SortKey, SortDirection } from '@/lib/sidebar-utils';
import type { Worktree } from '@/types/models';
import type { BranchStatus } from '@/types/sidebar';

// ============================================================================
// Constants
// ============================================================================

/** Sort options for Sessions page (includes lastSent, no branchName/updatedAt) [CON-002] */
const SESSIONS_SORT_OPTIONS: ReadonlyArray<{ key: SortKey; label: string }> = [
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

/** Status display labels */
const STATUS_LABELS: Record<string, string> = {
  ready: 'Ready',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
};

/** Format status display label */
function formatStatus(status: string | null | undefined): string {
  if (!status) return '';
  return STATUS_LABELS[status] ?? status;
}

/** Status badge CSS classes keyed by status value */
const STATUS_BADGE_CLASSES: Record<string, string> = {
  done: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
  in_review: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400',
  in_progress: 'bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-400',
};

const DEFAULT_BADGE_CLASS = 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300';

// ============================================================================
// Component
// ============================================================================

export default function SessionsPage() {
  const { worktrees, isLoading, error } = useWorktreesCacheContext();
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
          wt.repositoryName.toLowerCase().includes(lower) ||
          (wt.repositoryDisplayName?.toLowerCase().includes(lower) ?? false)
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
          const repoA = (a.repositoryDisplayName ?? a.repositoryName).toLowerCase();
          const repoB = (b.repositoryDisplayName ?? b.repositoryName).toLowerCase();
          comparison = repoA.localeCompare(repoB);
          if (comparison === 0) {
            comparison = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
          }
          break;
        }
        case 'status': {
          const priorityA = WORKTREE_STATUS_PRIORITY[a.status ?? ''] ?? DEFAULT_STATUS_PRIORITY;
          const priorityB = WORKTREE_STATUS_PRIORITY[b.status ?? ''] ?? DEFAULT_STATUS_PRIORITY;
          comparison = priorityA - priorityB;
          if (comparison === 0) {
            const repoA2 = (a.repositoryDisplayName ?? a.repositoryName).toLowerCase();
            const repoB2 = (b.repositoryDisplayName ?? b.repositoryName).toLowerCase();
            comparison = repoA2.localeCompare(repoB2);
          }
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

  // Selecting a new sort key applies its default direction [CON-005].
  const handleSortKeyChange = useCallback((key: string) => {
    const sortKeyValue = key as SortKey;
    setSortKey(sortKeyValue);
    setSortDirection(SESSIONS_DEFAULT_DIRECTIONS[sortKeyValue] ?? 'asc');
  }, []);

  const toggleSortDirection = useCallback(() => {
    setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
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
        <div className="mb-6 flex items-center gap-3">
          <Input
            type="text"
            placeholder="Filter by name or repository..."
            value={filterText}
            onChange={handleFilterChange}
            className="max-w-md flex-1"
            data-testid="sessions-filter"
            aria-label="Filter sessions by name or repository"
          />
          <Select value={sortKey} onValueChange={handleSortKeyChange}>
            <SelectTrigger
              className="w-40"
              data-testid="sessions-sort-select"
              aria-label="Sort by"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SESSIONS_SORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.key} value={opt.key}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={toggleSortDirection}
            data-testid="sessions-sort-direction"
            aria-label={sortDirection === 'asc' ? 'Sort ascending' : 'Sort descending'}
            className="rounded-md border border-input bg-surface p-2 text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {sortDirection === 'asc' ? (
              <ArrowUp size={16} aria-hidden="true" />
            ) : (
              <ArrowDown size={16} aria-hidden="true" />
            )}
          </button>
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
                    className="block bg-surface rounded-lg p-4 border border-border shadow-sm hover:border-accent-300 dark:hover:border-accent-700 transition-colors"
                    data-testid={`session-item-${wt.id}`}
                  >
                    {/* Row 1: Name, Agent statuses */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                          {wt.repositoryDisplayName ?? wt.repositoryName}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                          {wt.name}
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
                          STATUS_BADGE_CLASSES[wt.status ?? ''] ?? DEFAULT_BADGE_CLASS
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
