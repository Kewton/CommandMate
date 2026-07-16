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
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { AppShell } from '@/components/layout';
import { PullToRefresh } from '@/components/common/PullToRefresh';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import { deriveCliStatus } from '@/types/sidebar';
import { isWorkingStatus } from '@/lib/agent-status-display';
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
  Skeleton,
  StatusDot,
} from '@/components/ui';
import { compareByTimestamp } from '@/lib/sidebar-utils';
import { formatRelativeTimeShort } from '@/lib/date-utils';
import { STAGGER_ENTER_CLASS, staggerDelay } from '@/lib/utils/stagger';
import { sanitizePreview } from '@/config/message-preview-config';
import type { SortKey, SortDirection } from '@/lib/sidebar-utils';
import type { Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
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

/** Small CLI status dot for Sessions list (Issue #1051: shared StatusDot). */
function CliDot({ status, label }: { status: BranchStatus; label: string }) {
  const tCommon = useTranslations('common');
  const title = `${label}: ${tCommon(SIDEBAR_STATUS_CONFIG[status].labelKey)}`;
  return <StatusDot status={status} size="md" label={title} />;
}

/** Whether any selected agent is actively working (running/generating). */
function isWorktreeActive(wt: Worktree, agents: readonly CLIToolType[]): boolean {
  return agents.some((agent) => {
    const s = deriveCliStatus(wt.sessionStatusByCli?.[agent]);
    return s === 'running' || s === 'generating';
  });
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
  done: 'bg-success-subtle text-success-foreground',
  in_review: 'bg-info-subtle text-info-foreground',
  in_progress: 'bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-400',
};

const DEFAULT_BADGE_CLASS = 'bg-muted text-muted-foreground';

// ============================================================================
// Component
// ============================================================================

export default function SessionsPage() {
  const tCommon = useTranslations('common');
  const isMobile = useIsMobile();
  const { worktrees, isLoading, error, refresh } = useWorktreesCacheContext();
  // [Issue #1050] Whether we have any data to keep mounted. Based on the raw
  // (unfiltered) list so an active text filter never unmounts the list.
  const hasWorktrees = worktrees.length > 0;
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
      {/* Issue #1128: pull-to-refresh (mobile) — the wrapper owns the scroll
          container so the gesture only fires at the top and native PTR is
          suppressed. `refresh` re-fetches the shared worktrees cache. */}
      <PullToRefresh
        onRefresh={refresh}
        enabled={isMobile}
        className="container-custom py-8 h-full"
      >
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground mb-2">Sessions</h1>
          <p className="text-sm text-muted-foreground">
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
            // Issue #1128: surface the search keyboard + "search" enter key on mobile.
            inputMode="search"
            enterKeyHint="search"
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
            className="rounded-md border border-input bg-surface p-2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {sortDirection === 'asc' ? (
              <ArrowUp size={16} aria-hidden="true" />
            ) : (
              <ArrowDown size={16} aria-hidden="true" />
            )}
          </button>
        </div>

        {/*
          * [Issue #1050] Keep the list mounted across transient polling errors.
          * `worktrees` comes from a shared polling cache; a temporary fetch
          * failure (e.g. server rebuild) must NOT unmount the list, otherwise
          * the next successful poll remounts it and re-fires the entrance
          * stagger. Mirrors the #266 SF-IMP-001 "don't collapse the tree on a
          * transient error" pattern: show a non-blocking banner when we already
          * have data, and only surface a blocking error/loading state when we
          * have nothing to show.
          */}
        {hasWorktrees ? (
          <>
            {/* Non-blocking error banner (data already visible below) */}
            {error && (
              <div
                className="mb-4 rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger-foreground"
                role="status"
                data-testid="sessions-error-banner"
              >
                Failed to refresh sessions: {error.message}
              </div>
            )}
            <div className="space-y-2" data-testid="sessions-list">
              {filteredAndSorted.length === 0 ? (
                <div className="text-muted-foreground py-8 text-center" data-testid="sessions-empty">
                  No matching sessions found.
                </div>
              ) : (
                filteredAndSorted.map((wt: Worktree, index: number) => {
                const agents = wt.selectedAgents ?? DEFAULT_SELECTED_AGENTS;
                const sanitizedMessage = wt.lastUserMessage
                  ? sanitizePreview(wt.lastUserMessage)
                  : null;
                const relativeTime = wt.lastUserMessageAt
                  ? formatRelativeTimeShort(String(wt.lastUserMessageAt))
                  : null;
                // [Issue #1078] Only actively-working agents (running/waiting)
                // get a labelled chip; the idle group collapses to a "+N" counter
                // so a working session is never buried under a row of gray dots.
                const agentStatuses = agents.map((agent) => ({
                  agent,
                  status: deriveCliStatus(wt.sessionStatusByCli?.[agent]),
                }));
                const workingAgents = agentStatuses.filter((a) => isWorkingStatus(a.status));
                const idleCount = agentStatuses.length - workingAgents.length;
                // [Issue #1051] Active (running) cards get an accent border +
                // subtle glow so a working session stands out at a glance.
                const isActive = isWorktreeActive(wt, agents);
                const cardStateClasses = isActive
                  ? 'border-accent-500/40 shadow-[0_0_16px_-4px_rgb(var(--accent-500)/0.45)] hover:border-accent-400'
                  : 'border-border shadow-sm hover:border-accent-300 dark:hover:border-accent-700';

                return (
                  // [Issue #1050] Stable key (wt.id) keeps the entrance stagger
                  // from re-firing on polling re-renders.
                  <Link
                    key={wt.id}
                    href={`/worktrees/${wt.id}`}
                    style={{ animationDelay: staggerDelay(index) }}
                    className={`block bg-surface rounded-lg p-4 border transition-colors ${cardStateClasses} ${STAGGER_ENTER_CLASS}`}
                    data-testid={`session-item-${wt.id}`}
                  >
                    {/* Row 1: Name, Agent statuses */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground truncate">
                          {wt.repositoryDisplayName ?? wt.repositoryName}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {wt.name}
                        </div>
                      </div>

                      {/* [Issue #1078] Working agents as labelled chips; idle group collapsed */}
                      <div className="flex items-center gap-2 ml-4 flex-shrink-0" data-testid={`session-agents-${wt.id}`}>
                        {workingAgents.map(({ agent, status }) => (
                          <div key={agent} className="flex items-center gap-1" data-testid={`session-agent-${agent}`}>
                            <CliDot status={status} label={getCliToolDisplayName(agent)} />
                            <span className="text-xs text-muted-foreground">
                              {getCliToolDisplayName(agent)}
                            </span>
                          </div>
                        ))}
                        {idleCount > 0 && (
                          <div
                            className="flex items-center gap-1"
                            data-testid={`session-idle-cluster-${wt.id}`}
                            aria-label={tCommon('sessions.idleAgents', { count: idleCount })}
                          >
                            <StatusDot status="idle" size="sm" aria-hidden title={undefined} />
                            <span className="text-xs text-muted-foreground tabular-nums">
                              +{idleCount}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Row 2: Description (if present) */}
                    {wt.description && (
                      <div className="mt-2">
                        <p className="text-xs text-muted-foreground line-clamp-2 whitespace-pre-wrap">
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
                        {/* [Issue #1078] CSS truncate (not char-slice): byte-width is
                            consistent across JP/EN and adapts to the container width. */}
                        <span
                          className="text-xs text-muted-foreground truncate min-w-0 flex-1"
                          data-testid={`session-message-text-${wt.id}`}
                          title={sanitizedMessage}
                        >
                          {sanitizedMessage}
                        </span>
                        {relativeTime && (
                          <span
                            className="text-xs text-muted-foreground flex-shrink-0 whitespace-nowrap tabular-nums"
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
          </>
        ) : (
          <>
            {/* No data yet: loading / blocking error / empty are mutually exclusive. */}
            {isLoading && (
              // [Issue #1118] First-load only (hasWorktrees keeps the list on
              // re-fetch). Skeleton cards mirror the session card layout:
              // name/branch lines + agent chip, then a message/time footer.
              <div
                className="space-y-2"
                data-testid="sessions-loading"
                role="status"
                aria-label="Loading sessions"
              >
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="block bg-surface rounded-lg p-4 border border-border shadow-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <Skeleton className="h-4 w-40 max-w-full" />
                        <Skeleton className="h-3 w-56 max-w-full" />
                      </div>
                      <Skeleton className="ml-4 h-3 w-16 flex-shrink-0" />
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <Skeleton className="h-3 min-w-0 flex-1" />
                      <Skeleton className="h-3 w-10 flex-shrink-0" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!isLoading && error && (
              <div className="text-danger-foreground" data-testid="sessions-error">
                Failed to load sessions: {error.message}
              </div>
            )}
            {!isLoading && !error && (
              <div className="text-muted-foreground py-8 text-center" data-testid="sessions-empty">
                {filterText ? 'No matching sessions found.' : 'No sessions yet.'}
              </div>
            )}
          </>
        )}
      </PullToRefresh>
    </AppShell>
  );
}
