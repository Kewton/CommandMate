/**
 * Sessions Page (/sessions)
 *
 * Issue #600: UX refresh - Worktree exploration, search, and filtering.
 * Issue #606: Sessions enhancement - sort options and last sent message display.
 * Issue #2509: two layouts. `list` is the rows this page has always had; `tile`
 * is a two-column wall of `SessionTile`s, each carrying that worktree's live
 * conversation, so several agents can be watched without opening one worktree
 * screen per agent. The choice is a localStorage preference defaulting to
 * `list`, and only the tile branch drops `container-custom` — every list-mode
 * behaviour, down to the wrapper's classes, is unchanged.
 * Issue #709: Reads cached worktrees through `useWorktreesCacheContext()`
 * instead of `useWorktreesCache()` directly so the page shares a single
 * polling loop with `WorktreesCacheProvider` (otherwise `/api/worktrees`
 * is polled twice while this page is mounted).
 *
 * Issue #4389: a role condition (roles of each instance, `GET /api/sessions/roles`
 * read once). While it is applied, a tile switches only between the matching
 * instances, a list row counts only those and names their roles, and the row's
 * link opens the first match (`?instance=`). Unfiltered, all of that is as before.
 *
 * Issue #4388: the saved default condition is applied once when the page opens
 * (`useSessionsDefaultFilter`); changes made here are not saved, so leaving and
 * coming back starts from the default again. The filter button carries a mark
 * while the condition differs from the default.
 *
 * Sidebar auto-collapses on this page (via useLayoutConfig).
 */

'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Filter } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import {
  evaluateSessionsFilter,
  hasRoleCondition,
  type FilterTarget,
  type SessionsRoleCondition,
} from '@/lib/sessions-filter';
import {
  agentInstancesFromSelectedAgents,
  getInstanceLabel,
  type AgentInstance,
} from '@/lib/cli-tools/types';
import { PullToRefresh } from '@/components/common/PullToRefresh';
import {
  SessionTileGrid,
  SessionsViewModeSelector,
  SessionsFilterPanel,
  SessionsFilterSheet,
} from '@/components/sessions';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useSessionsViewMode } from '@/hooks/useSessionsViewMode';
import { useSessionsRoles } from '@/hooks/useSessionsRoles';
import {
  useSessionsDefaultFilter,
  type SessionsDefaultSaveError,
  type SessionsRolesReadiness,
} from '@/hooks/useSessionsDefaultFilter';
import type { SessionsFilterCondition } from '@/types/sessions-default-filter';
import { useWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import { deriveCliStatus, isUnclassifiedCliStatus } from '@/types/sidebar';
import {
  UNCLASSIFIED_STATUS_DOT_CLASS,
  UNCLASSIFIED_STATUS_LABEL_KEY,
  resolveUnclassifiedDot,
} from '@/components/sidebar/BranchStatusIndicator';
import { isWorkingStatus } from '@/lib/agent-status-display';
import { getCliToolDisplayName } from '@/lib/cli-tools/types';
import {
  ensureClientDefaultSelectedAgents,
  getClientDefaultSelectedAgents,
} from '@/config/default-agents';
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
import { buildSessionRowHref, compareByTimestamp } from '@/lib/sidebar-utils';
import { formatRelativeTimeShort } from '@/lib/date-utils';
import { STAGGER_ENTER_CLASS, staggerDelay } from '@/lib/utils/stagger';
import { sanitizePreview } from '@/config/message-preview-config';
import type { SortKey, SortDirection } from '@/lib/sidebar-utils';
import type { Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { BranchStatus } from '@/types/sidebar';
import { WORKTREE_STATUS_BADGE_CLASSES, WORKTREE_STATUS_OPTIONS } from '@/lib/worktree-status';

// ============================================================================
// Constants
// ============================================================================

/**
 * Sort options for Sessions page (includes lastSent, no branchName/updatedAt) [CON-002]
 *
 * Holds `common.sort.*` keys rather than labels, mirroring SIDEBAR_SORT_OPTIONS:
 * this is module scope, where t() cannot be called, so a literal would pin the
 * dropdown to English (Issue #1271/#1305).
 */
const SESSIONS_SORT_OPTIONS: ReadonlyArray<{ key: SortKey; labelKey: string }> = [
  { key: 'repositoryName', labelKey: 'sort.repositoryName' },
  { key: 'status', labelKey: 'sort.status' },
  { key: 'lastSent', labelKey: 'sort.lastSent' },
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

/**
 * Small CLI status dot for Sessions list (Issue #1051: shared StatusDot).
 *
 * The status half of the title comes from `common.status.*` — the same
 * dictionary StatusDot resolves internally — rather than the English literals
 * in status-colors.ts, so the tooltip translates without a second source of
 * truth for these labels (Issue #1305, following #1277). `label` is the CLI
 * tool's display name (e.g. "Claude"), a proper noun that is not translated.
 *
 * Issue #2810: `unclassified` draws the "cannot tell" ring and word the
 * Sessions tile (#2775) draws, in place of the `ready` underneath.
 */
function CliDot({
  status,
  label,
  unclassified,
}: {
  status: BranchStatus;
  label: string;
  /** `status` is a `ready` nothing actually read (`isUnclassifiedCliStatus`). */
  unclassified?: boolean;
}) {
  const tCommon = useTranslations('common');
  // `resolveUnclassifiedDot` re-checks `ready`, so no working dot is redrawn.
  const showUnclassified = resolveUnclassifiedDot(status, unclassified);
  const title = `${label}: ${tCommon(showUnclassified ? UNCLASSIFIED_STATUS_LABEL_KEY : `status.${status}`)}`;
  return (
    <StatusDot
      status={status}
      size="md"
      label={title}
      className={showUnclassified ? UNCLASSIFIED_STATUS_DOT_CLASS : undefined}
      data-unclassified={showUnclassified ? 'true' : undefined}
    />
  );
}

/**
 * Compact relative time ("8m ago" / "8分前") for the Sessions row (Issue #4346).
 *
 * `formatRelativeTimeShort` only knows English, so every other locale reads its
 * units from `common.sessions.relativeTime.*`. English keeps calling the shared
 * helper so its wording and thresholds stay in one place. The thresholds below
 * mirror that helper's.
 */
function formatSessionRelativeTime(
  isoString: string,
  locale: string,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  if (locale === 'en') {
    return formatRelativeTimeShort(isoString);
  }
  const date = new Date(isoString);
  if (isNaN(date.getTime())) {
    return '';
  }
  const diffSeconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (diffSeconds < 45) {
    return t('sessions.relativeTime.now');
  }
  const minutes = Math.round(diffSeconds / 60);
  if (minutes < 60) {
    return t('sessions.relativeTime.minutes', { count: minutes });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return t('sessions.relativeTime.hours', { count: hours });
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return t('sessions.relativeTime.days', { count: days });
  }
  if (days < 30) {
    return t('sessions.relativeTime.weeks', { count: Math.round(days / 7) });
  }
  if (days < 365) {
    return t('sessions.relativeTime.months', { count: Math.round(days / 30) });
  }
  return t('sessions.relativeTime.years', { count: Math.round(days / 365) });
}

/** Whether any selected agent is actively working (running/generating). */
function isWorktreeActive(wt: Worktree, agents: readonly CLIToolType[]): boolean {
  return agents.some((agent) => {
    const s = deriveCliStatus(wt.sessionStatusByCli?.[agent]);
    return s === 'running' || s === 'generating';
  });
}

/** Format status display label. Unknown values fall back to the raw status. */
function formatStatus(
  status: string | null | undefined,
  tWorktree: (key: string) => string
): string {
  if (!status) return '';
  const option = WORKTREE_STATUS_OPTIONS.find((o) => o.value === status);
  return option ? tWorktree(option.labelKey) : status;
}

const DEFAULT_BADGE_CLASS = 'bg-muted text-muted-foreground';

/** Same roster the tile shows (SessionTile.resolveInstances): the default agents when omitted. */
function resolveSessionsInstances(wt: FilterTarget): AgentInstance[] {
  const instances =
    wt.agentInstances && wt.agentInstances.length > 0
      ? wt.agentInstances
      : agentInstancesFromSelectedAgents(wt.selectedAgents ?? getClientDefaultSelectedAgents());
  return [...instances].sort((a, b) => a.order - b.order);
}

function resolveSessionsRoster(wt: FilterTarget): string[] {
  return resolveSessionsInstances(wt).map((i) => i.id);
}

const EMPTY_ROLE_CONDITION: SessionsRoleCondition = {};

/** The page's two pieces of condition as the stored shape (Issue #4388). */
function toFilterCondition(branchPattern: string, role: SessionsRoleCondition): SessionsFilterCondition {
  return {
    branchPattern,
    roleIds: [...(role.roleIds ?? [])],
    includeNoRole: role.includeNoRole === true,
    includeAmbiguous: role.includeAmbiguous === true,
  };
}

function describeSaveError(
  error: SessionsDefaultSaveError | null,
  t: (key: string, params?: Record<string, string | number>) => string
): string | null {
  if (!error) return null;
  return error.kind === 'invalid'
    ? t('sessions.defaultFilter.saveInvalid', { detail: error.detail })
    : t('sessions.defaultFilter.saveFailed');
}

// ============================================================================
// Component
// ============================================================================

export default function SessionsPage() {
  const tCommon = useTranslations('common');
  const tWorktree = useTranslations('worktree');
  const locale = useLocale();
  const isMobile = useIsMobile();
  const { worktrees, isLoading, error, refresh } = useWorktreesCacheContext();
  // [Issue #1050] Whether we have any data to keep mounted. Based on the raw
  // (unfiltered) list so an active text filter never unmounts the list.
  const hasWorktrees = worktrees.length > 0;
  const [filterText, setFilterText] = useState('');
  const [branchPattern, setBranchPattern] = useState('');
  const [roleCondition, setRoleCondition] = useState<SessionsRoleCondition>(EMPTY_ROLE_CONDITION);
  const wantsRole = hasRoleCondition(roleCondition);
  const {
    roles,
    rolesStatus,
    source: roleSource,
    reload: reloadRoles,
  } = useSessionsRoles({ poll: wantsRole });
  // Issue #4388: a deleted role can only be told from a role list that was read,
  // and from instance roles that were readable (I2).
  const rolesReadiness: SessionsRolesReadiness =
    rolesStatus === 'error' || roleSource?.rolesUnavailable
      ? 'unavailable'
      : rolesStatus === 'ok' && roles !== null && roleSource !== null
        ? 'ready'
        : 'loading';
  const existingRoleIds = useMemo(() => (roles === null ? null : roles.map((r) => r.id)), [roles]);
  const currentCondition = useMemo(
    () => toFilterCondition(branchPattern, roleCondition),
    [branchPattern, roleCondition]
  );
  const applyCondition = useCallback((c: SessionsFilterCondition) => {
    setBranchPattern(c.branchPattern);
    setRoleCondition({
      roleIds: c.roleIds,
      includeNoRole: c.includeNoRole,
      includeAmbiguous: c.includeAmbiguous,
    });
  }, []);
  const defaultFilter = useSessionsDefaultFilter({
    current: currentCondition,
    existingRoleIds,
    rolesReadiness,
    apply: applyCondition,
  });
  const { noteUserChange } = defaultFilter;
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('lastSent');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  // Issue #2509. Resolved from localStorage in an effect, so the first render is
  // always `list` — which is also the value SSR produces, and therefore the
  // reason switching layouts cannot cause a hydration mismatch.
  const { viewMode, setViewMode } = useSessionsViewMode();
  const isTileMode = viewMode === 'tile';

  // Issue #2065: this page reads worktrees through the shared cache, which hands
  // back rows and not the envelope the default rides in, so it seeds the mirror
  // itself. Single-flight and cached in the module, so mounting this page after
  // /review or a worktree costs nothing.
  useEffect(() => {
    void ensureClientDefaultSelectedAgents();
  }, []);

  const { filteredAndSorted, matchedInstances } = useMemo(() => {
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

    // Issue #4386: branch filter. An unusable pattern keeps everything.
    // Issue #4389: role filter. Roles that could not be read keep everything (and say so).
    const verdict = evaluateSessionsFilter(
      result,
      { branchPattern, role: roleCondition },
      resolveSessionsRoster,
      roleSource
    );
    result = result.filter((wt) => verdict.verdicts.get(wt.id)?.show ?? true);
    const matched = verdict.roleFiltered
      ? new Map(result.map((wt) => [wt.id, verdict.verdicts.get(wt.id)?.instanceIds ?? []] as const))
      : undefined;

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

    return { filteredAndSorted: sorted, matchedInstances: matched };
  }, [worktrees, filterText, branchPattern, roleCondition, roleSource, sortKey, sortDirection]);

  const branchFilter = useMemo(
    () => evaluateSessionsFilter([], { branchPattern, role: roleCondition }, undefined, roleSource),
    [branchPattern, roleCondition, roleSource]
  );
  const activeFilterCount = branchFilter.activeCount;
  const branchFilterError = branchFilter.error;
  const roleFilterError = branchFilter.roleError;
  const clearFilters = useCallback(() => {
    noteUserChange();
    setBranchPattern('');
    setRoleCondition(EMPTY_ROLE_CONDITION);
  }, [noteUserChange]);
  const handleBranchPatternChange = useCallback(
    (value: string) => {
      noteUserChange();
      setBranchPattern(value);
    },
    [noteUserChange]
  );
  const handleRoleChange = useCallback(
    (role: SessionsRoleCondition) => {
      noteUserChange();
      setRoleCondition(role);
    },
    [noteUserChange]
  );
  const openFilter = useCallback(() => {
    setIsFilterOpen(true);
    // Roles may have been added or instances started since the page opened.
    reloadRoles();
  }, [reloadRoles]);
  const handleRefresh = useCallback(async () => {
    reloadRoles();
    await refresh();
  }, [reloadRoles, refresh]);
  const roleOptions = useMemo(
    () => (roles === null ? null : roles.map((r) => ({ id: r.id, name: r.name }))),
    [roles]
  );
  /** "Instance: role" for a matched instance (Issue #4389). */
  const describeInstanceRole = (worktreeId: string, instance: AgentInstance | undefined, instanceId: string) => {
    const summary = roleSource?.roleByWorktree[worktreeId]?.[instanceId];
    const roleLabel =
      summary?.kind === 'role'
        ? summary.roleName
        : summary?.kind === 'ambiguous'
          ? tCommon('sessions.roleFilter.ambiguous')
          : tCommon('sessions.roleFilter.noRole');
    return tCommon('sessions.roleFilter.instanceRole', {
      instance: instance ? getInstanceLabel(instance) : instanceId,
      role: roleLabel,
    });
  };
  const closeFilter = useCallback(() => setIsFilterOpen(false), []);
  const filterPanel = (
    <SessionsFilterPanel
      branchPattern={branchPattern}
      onBranchPatternChange={handleBranchPatternChange}
      error={branchFilterError}
      onClear={clearFilters}
      roles={roleOptions}
      role={roleCondition}
      onRoleChange={handleRoleChange}
      roleError={roleFilterError}
      defaultActions={{
        onSave: () => void defaultFilter.saveAsDefault(),
        onReset: defaultFilter.resetToDefault,
        canReset: defaultFilter.hasDefault,
        saving: defaultFilter.saving,
        saved: defaultFilter.saved,
        saveError: describeSaveError(defaultFilter.saveError, tCommon),
      }}
    />
  );

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
    <>
      {/* Issue #1128: pull-to-refresh (mobile) — the wrapper owns the scroll
          container so the gesture only fires at the top and native PTR is
          suppressed. `refresh` re-fetches the shared worktrees cache. */}
      <PullToRefresh
        onRefresh={handleRefresh}
        enabled={isMobile}
        // Issue #2509: tile mode drops `container-custom`'s `max-w-7xl mx-auto`
        // and keeps only its gutters, so two 640px-wide tiles have room on a
        // wide screen. List mode keeps the exact class it has always had.
        className={`${isTileMode ? 'w-full px-4 sm:px-6 lg:px-8' : 'container-custom'} py-8 h-full`}
      >
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground mb-2">{tCommon('sessions.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {tCommon('sessions.description')}
          </p>
        </div>

        {/* Search / Filter + Sort */}
        <div className="mb-6 flex items-center gap-3">
          <Input
            type="text"
            placeholder={tCommon('sessions.filterPlaceholder')}
            value={filterText}
            onChange={handleFilterChange}
            className="max-w-md flex-1"
            data-testid="sessions-filter"
            aria-label={tCommon('sessions.filterAriaLabel')}
            // Issue #1128: surface the search keyboard + "search" enter key on mobile.
            inputMode="search"
            enterKeyHint="search"
          />
          <button
            type="button"
            onClick={openFilter}
            data-testid="sessions-filter-button"
            className="inline-flex items-center gap-1 rounded-md border border-input bg-surface px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Filter size={16} aria-hidden="true" />
            {tCommon('sessions.branchFilter.button')}
            {activeFilterCount > 0 && (
              <span
                data-testid="sessions-filter-count"
                className="rounded-full bg-accent-600 px-1.5 text-xs text-white"
              >
                {activeFilterCount}
              </span>
            )}
            {/* Issue #4388: differsFromDefault decides this mark, nothing else (I5). */}
            {defaultFilter.differs && (
              <span
                data-testid="sessions-filter-differs"
                title={tCommon('sessions.defaultFilter.differs')}
                className="h-2 w-2 rounded-full bg-warning"
              >
                <span className="sr-only">{tCommon('sessions.defaultFilter.differs')}</span>
              </span>
            )}
          </button>
          <Select value={sortKey} onValueChange={handleSortKeyChange}>
            <SelectTrigger
              className="w-40"
              data-testid="sessions-sort-select"
              aria-label={tCommon('sessions.sortByAriaLabel')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SESSIONS_SORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.key} value={opt.key}>
                  {tCommon(opt.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={toggleSortDirection}
            data-testid="sessions-sort-direction"
            aria-label={
              sortDirection === 'asc'
                ? tCommon('sessions.sortAscending')
                : tCommon('sessions.sortDescending')
            }
            className="rounded-md border border-input bg-surface p-2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {sortDirection === 'asc' ? (
              <ArrowUp size={16} aria-hidden="true" />
            ) : (
              <ArrowDown size={16} aria-hidden="true" />
            )}
          </button>
          {/* Issue #2509: list / tile. Last in the row because it governs what
              the controls to its left are applied TO — the filter and the sort
              feed both layouts unchanged. */}
          <SessionsViewModeSelector value={viewMode} onChange={setViewMode} />
        </div>

        {/* Issue #4388: roles the default named were deleted. They are left out
            (never a silent widening to "everything") and the page says so. */}
        {defaultFilter.droppedRoleIds.length > 0 && (
          <p
            role="status"
            data-testid="sessions-default-filter-dropped-roles"
            className="-mt-4 mb-6 rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-sm text-foreground"
          >
            {tCommon('sessions.defaultFilter.droppedRoles')}
          </p>
        )}

        {isMobile ? (
          <SessionsFilterSheet isOpen={isFilterOpen} onClose={closeFilter}>
            {filterPanel}
          </SessionsFilterSheet>
        ) : (
          <Modal
            isOpen={isFilterOpen}
            onClose={closeFilter}
            title={tCommon('sessions.branchFilter.title')}
            size="sm"
          >
            {filterPanel}
          </Modal>
        )}

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
            {/* Issue #4389: a chosen role condition that cannot be used is said, not hidden. */}
            {roleFilterError && (
              <div
                className="mb-4 rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger-foreground"
                role="status"
                data-testid="sessions-role-unavailable-banner"
              >
                {tCommon('sessions.roleFilter.unavailable')}
              </div>
            )}
            {/* Non-blocking error banner (data already visible below) */}
            {error && (
              <div
                className="mb-4 rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger-foreground"
                role="status"
                data-testid="sessions-error-banner"
              >
                {tCommon('sessions.refreshError', { message: error.message })}
              </div>
            )}
            {/* Issue #2509: the two layouts. Both are fed `filteredAndSorted`,
                which is what makes the filter and the sort controls above apply
                identically in either one. The list branch below is byte-for-byte
                what this page rendered before tile mode existed. */}
            {isTileMode ? (
              filteredAndSorted.length === 0 ? (
                <div className="text-muted-foreground py-8 text-center" data-testid="sessions-empty">
                  {tCommon('sessions.noMatching')}
                </div>
              ) : (
                <SessionTileGrid worktrees={filteredAndSorted} instanceIdsByWorktree={matchedInstances} />
              )
            ) : (
              <div className="space-y-2" data-testid="sessions-list">
                {filteredAndSorted.length === 0 ? (
                  <div className="text-muted-foreground py-8 text-center" data-testid="sessions-empty">
                    {tCommon('sessions.noMatching')}
                  </div>
                ) : (
                  filteredAndSorted.map((wt: Worktree, index: number) => {
                  const agents = wt.selectedAgents ?? getClientDefaultSelectedAgents();
                  const sanitizedMessage = wt.lastUserMessage
                    ? sanitizePreview(wt.lastUserMessage)
                    : null;
                  const relativeTime = wt.lastUserMessageAt
                    ? formatSessionRelativeTime(String(wt.lastUserMessageAt), locale, tCommon)
                    : null;
                  // [Issue #1078] Only actively-working agents (running/waiting)
                  // get a labelled chip; the idle group collapses to a "+N" counter
                  // so a working session is never buried under a row of gray dots.
                  // Issue #2810: an agent whose frame no rule could read gets a
                  // chip too, drawn as "cannot tell". Folded into the counter it
                  // would be one more gray dot — the pane a human should look at,
                  // hidden among the ones they can ignore.
                  // Issue #4389: under a role condition, only the matching
                  // instances are shown and counted, read per instance.
                  const matchedIds = matchedInstances?.get(wt.id);
                  const instanceById = matchedIds
                    ? new Map(resolveSessionsInstances(wt).map((i) => [i.id, i] as const))
                    : null;
                  const agentStatuses = matchedIds && instanceById
                    ? matchedIds.map((id) => {
                        const instance = instanceById.get(id);
                        const entry =
                          wt.sessionStatusByInstance?.[id] ??
                          (instance && instance.id === instance.cliTool
                            ? wt.sessionStatusByCli?.[instance.cliTool]
                            : undefined);
                        return {
                          agent: id,
                          label: instance ? getInstanceLabel(instance) : id,
                          status: deriveCliStatus(entry),
                          unclassified: isUnclassifiedCliStatus(entry),
                        };
                      })
                    : agents.map((agent) => {
                        const entry = wt.sessionStatusByCli?.[agent];
                        return {
                          agent: agent as string,
                          label: getCliToolDisplayName(agent),
                          status: deriveCliStatus(entry),
                          unclassified: isUnclassifiedCliStatus(entry),
                        };
                      });
                  const workingAgents = agentStatuses.filter(
                    (a) => isWorkingStatus(a.status) || a.unclassified
                  );
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
                      href={
                        matchedIds && matchedIds.length > 0
                          ? buildSessionRowHref({ worktreeId: wt.id, instanceId: matchedIds[0] })
                          : `/worktrees/${wt.id}`
                      }
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
                          {matchedIds && instanceById && (
                            <div
                              className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground"
                              data-testid={`session-roles-${wt.id}`}
                            >
                              {matchedIds.map((id) => (
                                <span key={id} data-testid={`session-role-${wt.id}-${id}`}>
                                  {describeInstanceRole(wt.id, instanceById.get(id), id)}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* [Issue #1078] Working agents as labelled chips; idle group collapsed */}
                        <div className="flex items-center gap-2 ml-4 flex-shrink-0" data-testid={`session-agents-${wt.id}`}>
                          {workingAgents.map(({ agent, label, status, unclassified }) => (
                            <div key={agent} className="flex items-center gap-1" data-testid={`session-agent-${agent}`}>
                              <CliDot
                                status={status}
                                label={label}
                                unclassified={unclassified}
                              />
                              <span className="text-xs text-muted-foreground">
                                {label}
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
                            (WORKTREE_STATUS_BADGE_CLASSES as Record<string, string>)[wt.status ?? ''] ?? DEFAULT_BADGE_CLASS
                          }`}>
                            {formatStatus(wt.status, tWorktree)}
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
            )}
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
                aria-label={tCommon('sessions.loadingAriaLabel')}
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
                {tCommon('sessions.loadError', { message: error.message })}
              </div>
            )}
            {!isLoading && !error && (
              <div className="text-muted-foreground py-8 text-center" data-testid="sessions-empty">
                {filterText ? tCommon('sessions.noMatching') : tCommon('sessions.empty')}
              </div>
            )}
          </>
        )}
      </PullToRefresh>
    </>
  );
}
