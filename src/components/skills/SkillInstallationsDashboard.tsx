/**
 * SkillInstallationsDashboard (Issue #1248)
 *
 * One screen for "which worktree has what, and is any of it broken" (UX-02).
 * Rows are ordered by how much they need attention, so a drifting install is
 * the first thing on screen rather than something to scroll for.
 *
 * Every row shows **each install root separately**. Since #1460 a package lives
 * in `.agents/skills` and `.claude/skills`; collapsing them into one line would
 * hide exactly the case this screen exists for — the Claude-side copy deleted
 * while the Codex-side copy looks fine.
 *
 * Two states are deliberately never conflated: a scan that could not run is an
 * error, not an empty list, and an unreachable Catalog disables the "update
 * available" claim rather than silently reporting everything as current.
 *
 * @module components/skills/SkillInstallationsDashboard
 */

'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Badge, Button, Card, Input, Skeleton } from '@/components/ui';
import { SkillNotice } from './SkillNotice';
import { SkillOperationHistory } from './SkillOperationHistory';
import {
  fetchSkillInstallations,
  rebuildSkillIndex,
  type SkillFetchFailure,
} from './skills-client';
import {
  INSTALLATION_STATUS_HINT_KEY,
  INSTALLATION_STATUS_LABEL_KEY,
  INSTALLATION_STATUS_TONE,
} from './skill-vocabulary';
import type { SkillInstallRootStatus, SkillInstallationStatusEntry } from './types';

const SELECT_CLASS =
  'w-full rounded-md border border-input bg-surface px-3 py-2 text-sm text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const STATUS_OPTIONS = [
  'missing',
  'modified',
  'unmanaged',
  'update_available',
  'installed',
] as const;

/** Attention first: a broken install outranks an available update. */
const STATUS_ORDER: Record<string, number> = {
  missing: 0,
  modified: 1,
  unmanaged: 2,
  update_available: 3,
  installed: 4,
};

interface DashboardState {
  status: 'loading' | 'loaded' | 'error';
  scannedAt: number | null;
  worktreeCount: number;
  truncated: boolean;
  unreadableWorktreeIds: string[];
  catalogAvailable: boolean;
  installations: SkillInstallationStatusEntry[];
  failure: SkillFetchFailure | null;
}

const INITIAL_STATE: DashboardState = {
  status: 'loading',
  scannedAt: null,
  worktreeCount: 0,
  truncated: false,
  unreadableWorktreeIds: [],
  catalogAvailable: false,
  installations: [],
  failure: null,
};

interface ReindexState {
  running: boolean;
  outcome: { indexed: number; removed: number; skipped: number } | null;
  failure: SkillFetchFailure | null;
}

function formatTimestamp(value: number): string {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 19);
}

function driftCount(root: SkillInstallRootStatus): number {
  return root.modifiedFiles + root.missingFiles + root.unmanagedFiles + root.irregularPaths;
}

export function SkillInstallationsDashboard() {
  const t = useTranslations('skills');
  const [state, setState] = useState<DashboardState>(INITIAL_STATE);
  const [reindex, setReindex] = useState<ReindexState>({
    running: false,
    outcome: null,
    failure: null,
  });
  const [worktreeFilter, setWorktreeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [query, setQuery] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState(INITIAL_STATE);

    fetchSkillInstallations({ refresh: reloadToken > 0 }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setState(
          response.ok
            ? {
                status: 'loaded',
                scannedAt: response.data.scannedAt,
                worktreeCount: response.data.worktreeCount,
                truncated: response.data.truncated,
                unreadableWorktreeIds: response.data.unreadableWorktreeIds,
                catalogAvailable: response.data.catalogAvailable,
                installations: response.data.installations,
                failure: null,
              }
            : { ...INITIAL_STATE, status: 'error', failure: response.failure }
        );
      })
      .catch(() => {
        // Only an abort reaches here; the request has no outcome to render.
      });

    return () => controller.abort();
  }, [reloadToken]);

  const rescan = useCallback(() => setReloadToken((token) => token + 1), []);

  const runRebuild = useCallback(() => {
    setReindex({ running: true, outcome: null, failure: null });
    rebuildSkillIndex()
      .then((response) => {
        if (response.ok) {
          setReindex({
            running: false,
            outcome: {
              indexed: response.data.indexed,
              removed: response.data.removed,
              skipped: response.data.skipped.length,
            },
            failure: null,
          });
          rescan();
          return;
        }
        setReindex({ running: false, outcome: null, failure: response.failure });
      })
      .catch(() => {
        setReindex({ running: false, outcome: null, failure: null });
      });
  }, [rescan]);

  const worktreeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const entry of state.installations) seen.set(entry.worktreeId, entry.worktreeName);
    return [...seen].sort(([a], [b]) => (a < b ? -1 : 1));
  }, [state.installations]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.installations
      .filter((entry) => worktreeFilter === '' || entry.worktreeId === worktreeFilter)
      .filter((entry) => statusFilter === '' || entry.status === statusFilter)
      .filter((entry) => needle === '' || entry.skillId.toLowerCase().includes(needle))
      .slice()
      .sort((a, b) => {
        const order = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
        if (order !== 0) return order;
        if (a.skillId !== b.skillId) return a.skillId < b.skillId ? -1 : 1;
        return a.worktreeId < b.worktreeId ? -1 : 1;
      });
  }, [state.installations, worktreeFilter, statusFilter, query]);

  if (state.status === 'loading') {
    return (
      <div data-testid="skill-dashboard-loading" className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('state.loading')}</p>
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-24 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <Card data-testid="skill-dashboard-error" className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">{t('state.errorHeading')}</h2>
        <SkillNotice tone="danger">
          <p>{t('dashboard.errorNotice')}</p>
          <p className="mt-1 break-words">
            {t('state.errorCode', { code: state.failure?.code ?? '' })}
          </p>
        </SkillNotice>
        <Button variant="secondary" size="sm" onClick={rescan} data-testid="skill-dashboard-retry">
          {t('state.retry')}
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground" data-testid="skill-dashboard-scanned-at">
          {t('dashboard.scannedAt', {
            timestamp: state.scannedAt === null ? '' : formatTimestamp(state.scannedAt),
          })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('dashboard.worktreeCount', { count: state.worktreeCount })}
        </p>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" size="sm" onClick={rescan} data-testid="skill-dashboard-rescan">
            {t('dashboard.rescan')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={runRebuild}
            disabled={reindex.running}
            data-testid="skill-dashboard-reindex"
          >
            {reindex.running ? t('dashboard.reindexRunning') : t('dashboard.reindex')}
          </Button>
        </div>
      </div>

      {!state.catalogAvailable && (
        <SkillNotice tone="warning" data-testid="skill-dashboard-catalog-unavailable">
          {t('dashboard.catalogUnavailable')}
        </SkillNotice>
      )}

      {state.truncated && (
        <SkillNotice tone="warning" data-testid="skill-dashboard-truncated">
          {t('dashboard.truncated')}
        </SkillNotice>
      )}

      {state.unreadableWorktreeIds.length > 0 && (
        <SkillNotice tone="warning" data-testid="skill-dashboard-unreadable">
          {t('dashboard.unreadableWorktrees', {
            worktrees: state.unreadableWorktreeIds.join(', '),
          })}
        </SkillNotice>
      )}

      {reindex.outcome !== null && (
        <SkillNotice tone="info" data-testid="skill-dashboard-reindex-result">
          {t('dashboard.reindexDone', {
            indexed: reindex.outcome.indexed,
            removed: reindex.outcome.removed,
            skipped: reindex.outcome.skipped,
          })}
        </SkillNotice>
      )}

      {reindex.failure !== null && (
        <SkillNotice tone="danger" data-testid="skill-dashboard-reindex-error">
          <p>{t('dashboard.reindexFailed')}</p>
          <p className="mt-1 break-words">
            {t('state.errorCode', { code: reindex.failure.code })}
          </p>
        </SkillNotice>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block text-xs font-medium text-muted-foreground sm:col-span-1">
          {t('dashboard.filterSkill')}
          <Input
            type="search"
            className="mt-1"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t('dashboard.filterSkill')}
            data-testid="skill-dashboard-search"
          />
        </label>

        <label className="block text-xs font-medium text-muted-foreground">
          {t('dashboard.filterWorktree')}
          <select
            className={`${SELECT_CLASS} mt-1`}
            value={worktreeFilter}
            onChange={(event) => setWorktreeFilter(event.target.value)}
            data-testid="skill-dashboard-filter-worktree"
          >
            <option value="">{t('dashboard.all')}</option>
            {worktreeOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs font-medium text-muted-foreground">
          {t('dashboard.filterStatus')}
          <select
            className={`${SELECT_CLASS} mt-1`}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            data-testid="skill-dashboard-filter-status"
          >
            <option value="">{t('dashboard.all')}</option>
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {t(INSTALLATION_STATUS_LABEL_KEY[status])}
              </option>
            ))}
          </select>
        </label>
      </div>

      {state.installations.length === 0 ? (
        <Card data-testid="skill-dashboard-empty">
          <p className="text-sm text-muted-foreground">{t('dashboard.empty')}</p>
        </Card>
      ) : visible.length === 0 ? (
        <Card data-testid="skill-dashboard-no-results">
          <p className="text-sm text-foreground">{t('state.noResults')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('state.noResultsHint')}</p>
        </Card>
      ) : (
        <ul className="space-y-2" data-testid="skill-dashboard-list">
          {visible.map((entry) => (
            <li
              key={`${entry.worktreeId}:${entry.skillId}`}
              className="rounded-lg border border-border p-3"
              data-testid="skill-dashboard-item"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={INSTALLATION_STATUS_TONE[entry.status] ?? 'gray'}>
                  {t(INSTALLATION_STATUS_LABEL_KEY[entry.status] ?? 'dashboard.status.installed')}
                </Badge>
                <Link
                  href={`/skills/${encodeURIComponent(entry.skillId)}`}
                  className="text-sm font-semibold text-accent-600 hover:underline dark:text-accent-400"
                  data-testid="skill-dashboard-item-link"
                >
                  {entry.skillId}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {entry.repositoryName} / {entry.worktreeName}
                </span>
                <span className="ml-auto text-xs text-foreground">
                  {entry.version ?? t('history.none')}
                  {entry.status === 'update_available' && entry.latestVersion !== null
                    ? ` → ${entry.latestVersion}`
                    : ''}
                </span>
              </div>

              <p className="mt-1 text-xs text-muted-foreground" data-testid="skill-dashboard-hint">
                {t(INSTALLATION_STATUS_HINT_KEY[entry.status] ?? 'dashboard.statusHint.installed')}
              </p>

              <ul className="mt-2 space-y-1" data-testid="skill-dashboard-roots">
                {entry.installRoots.map((root) => (
                  <li
                    key={root.root}
                    className="flex flex-wrap items-center gap-2 text-xs"
                    data-testid="skill-dashboard-root"
                  >
                    <Badge variant={root.present ? 'gray' : 'error'}>
                      {root.present ? t('dashboard.rootPresent') : t('dashboard.rootMissing')}
                    </Badge>
                    <span className="break-all font-mono text-muted-foreground">{root.root}</span>
                    {driftCount(root) > 0 && (
                      <span className="text-warning-foreground" data-testid="skill-dashboard-drift">
                        {t('dashboard.driftSummary', {
                          modified: root.modifiedFiles,
                          missing: root.missingFiles,
                          unmanaged: root.unmanagedFiles,
                          irregular: root.irregularPaths,
                        })}
                      </span>
                    )}
                    {root.truncated && (
                      <span className="text-warning-foreground">{t('dashboard.rootTruncated')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <SkillOperationHistory />
    </div>
  );
}

export default SkillInstallationsDashboard;
