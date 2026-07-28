/**
 * SkillOperationHistory (Issue #1248)
 *
 * The append-only operation log, rendered as the thing a user actually needs it
 * for: finding out what happened while they were away. Every row names the
 * outcome, the version transition and the immutable source coordinates, and a
 * failed row names its error code and offers the way back to retrying it — a
 * failure with no next step is just a complaint.
 *
 * Loading, empty and error are distinct renderings. An unreachable API must not
 * degrade into an empty log, because "nothing has happened" and "we could not
 * read what happened" would lead to opposite conclusions (UX-06).
 *
 * @module components/skills/SkillOperationHistory
 */

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Badge, Button, Card, Skeleton } from '@/components/ui';
import { SkillNotice } from './SkillNotice';
import { fetchSkillOperations, type SkillFetchFailure } from './skills-client';
import {
  OPERATION_ACTOR_LABEL_KEY,
  OPERATION_KIND_LABEL_KEY,
  OPERATION_RESULT_LABEL_KEY,
  OPERATION_RESULT_TONE,
} from './skill-vocabulary';
import type { SkillOperationAuditRecord } from './types';

const SELECT_CLASS =
  'w-full rounded-md border border-input bg-surface px-3 py-2 text-sm text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const OPERATION_OPTIONS = ['install', 'uninstall', 'update'] as const;
const RESULT_OPTIONS = ['succeeded', 'failed', 'reconciled'] as const;

const PAGE_SIZE = 20;

export interface SkillOperationHistoryProps {
  /** Restrict the feed to one worktree. Omit to read across all of them. */
  worktreeId?: string;
  skillId?: string;
}

interface HistoryState {
  status: 'loading' | 'loaded' | 'error';
  operations: SkillOperationAuditRecord[];
  nextCursor: string | null;
  failure: SkillFetchFailure | null;
}

const INITIAL_STATE: HistoryState = {
  status: 'loading',
  operations: [],
  nextCursor: null,
  failure: null,
};

function formatTimestamp(value: number): string {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 19);
}

function shortCommit(commit: string | null): string | null {
  return commit === null ? null : commit.slice(0, 12);
}

export function SkillOperationHistory({ worktreeId, skillId }: SkillOperationHistoryProps) {
  const t = useTranslations('skills');
  const [state, setState] = useState<HistoryState>(INITIAL_STATE);
  const [operation, setOperation] = useState('');
  const [result, setResult] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setState(INITIAL_STATE);

    fetchSkillOperations(
      { worktreeId, skillId, operation, result, limit: PAGE_SIZE },
      controller.signal
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        setState(
          response.ok
            ? {
                status: 'loaded',
                operations: response.data.operations,
                nextCursor: response.data.nextCursor,
                failure: null,
              }
            : { status: 'error', operations: [], nextCursor: null, failure: response.failure }
        );
      })
      .catch(() => {
        // Only an abort reaches here; a cancelled request has no outcome to show.
      });

    return () => controller.abort();
  }, [worktreeId, skillId, operation, result]);

  const loadMore = useCallback(() => {
    if (state.nextCursor === null) return;
    setLoadingMore(true);
    fetchSkillOperations({
      worktreeId,
      skillId,
      operation,
      result,
      limit: PAGE_SIZE,
      cursor: state.nextCursor,
    })
      .then((response) => {
        if (!response.ok) return;
        setState((prev) => ({
          ...prev,
          operations: [...prev.operations, ...response.data.operations],
          nextCursor: response.data.nextCursor,
        }));
      })
      .catch(() => {
        // Paging further is best-effort: the rows already shown stay valid.
      })
      .finally(() => setLoadingMore(false));
  }, [state.nextCursor, worktreeId, skillId, operation, result]);

  return (
    <Card className="space-y-3" data-testid="skill-operation-history">
      <h2 className="text-base font-semibold text-foreground">{t('history.heading')}</h2>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-muted-foreground">
          {t('history.filterOperation')}
          <select
            className={`${SELECT_CLASS} mt-1`}
            value={operation}
            onChange={(event) => setOperation(event.target.value)}
            data-testid="skill-history-filter-operation"
          >
            <option value="">{t('dashboard.all')}</option>
            {OPERATION_OPTIONS.map((kind) => (
              <option key={kind} value={kind}>
                {t(OPERATION_KIND_LABEL_KEY[kind])}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs font-medium text-muted-foreground">
          {t('history.filterResult')}
          <select
            className={`${SELECT_CLASS} mt-1`}
            value={result}
            onChange={(event) => setResult(event.target.value)}
            data-testid="skill-history-filter-result"
          >
            <option value="">{t('dashboard.all')}</option>
            {RESULT_OPTIONS.map((outcome) => (
              <option key={outcome} value={outcome}>
                {t(OPERATION_RESULT_LABEL_KEY[outcome])}
              </option>
            ))}
          </select>
        </label>
      </div>

      {state.status === 'loading' && (
        <div className="space-y-2" data-testid="skill-history-loading">
          <p className="text-sm text-muted-foreground">{t('history.loading')}</p>
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      )}

      {state.status === 'error' && (
        <SkillNotice tone="danger" data-testid="skill-history-error">
          <p>{t('history.errorNotice')}</p>
          <p className="mt-1 break-words">
            {t('state.errorCode', { code: state.failure?.code ?? '' })}
          </p>
        </SkillNotice>
      )}

      {state.status === 'loaded' && state.operations.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="skill-history-empty">
          {t('history.empty')}
        </p>
      )}

      {state.status === 'loaded' && state.operations.length > 0 && (
        <ul className="space-y-2" data-testid="skill-history-list">
          {state.operations.map((record) => (
            <li
              key={record.id}
              className="rounded-lg border border-border p-3 text-xs"
              data-testid="skill-history-item"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={OPERATION_RESULT_TONE[record.result] ?? 'gray'}>
                  {t(OPERATION_RESULT_LABEL_KEY[record.result] ?? 'history.result.succeeded')}
                </Badge>
                <span className="font-medium text-foreground">
                  {t(OPERATION_KIND_LABEL_KEY[record.operation] ?? 'history.operation.install')}
                </span>
                <span className="font-medium text-foreground">{record.skillId}</span>
                <span className="text-muted-foreground">{record.worktreeId}</span>
                <span className="ml-auto text-muted-foreground">
                  {t('history.recordedAt', { timestamp: formatTimestamp(record.recordedAt) })}
                </span>
              </div>

              <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                <div className="flex gap-1">
                  <dt className="text-muted-foreground">{t('history.transitionLabel')}</dt>
                  <dd className="text-foreground">
                    {t('history.transition', {
                      from: record.fromVersion ?? t('history.none'),
                      to: record.toVersion ?? t('history.none'),
                    })}
                  </dd>
                </div>
                <div className="flex gap-1">
                  <dt className="text-muted-foreground">{t('history.actorLabel')}</dt>
                  <dd className="text-foreground">
                    {t(OPERATION_ACTOR_LABEL_KEY[record.actorType] ?? 'history.actor.system')}
                  </dd>
                </div>
                {record.sourceOrigin !== null && (
                  <div className="flex gap-1">
                    <dt className="text-muted-foreground">{t('history.origin')}</dt>
                    <dd className="text-foreground">{record.sourceOrigin}</dd>
                  </div>
                )}
                {record.sourceCommit !== null && (
                  <div className="flex gap-1">
                    <dt className="text-muted-foreground">{t('history.sourceCommit')}</dt>
                    <dd className="break-all font-mono text-foreground">
                      {shortCommit(record.sourceCommit)}
                    </dd>
                  </div>
                )}
                {record.artifactSha256 !== null && (
                  <div className="flex gap-1">
                    <dt className="text-muted-foreground">{t('history.artifactDigest')}</dt>
                    <dd className="break-all font-mono text-foreground">
                      {shortCommit(record.artifactSha256)}
                    </dd>
                  </div>
                )}
              </dl>

              {record.errorCode !== null && (
                <div className="mt-2 space-y-1" data-testid="skill-history-failure">
                  <SkillNotice tone="danger">
                    <p className="break-words">{t('state.errorCode', { code: record.errorCode })}</p>
                    {record.errorMessage !== null && (
                      <p className="mt-1 break-words">{record.errorMessage}</p>
                    )}
                  </SkillNotice>
                  <Link
                    href={`/skills/${encodeURIComponent(record.skillId)}`}
                    className="inline-flex text-accent-600 hover:underline dark:text-accent-400"
                    data-testid="skill-history-retry"
                  >
                    {t('history.retry')}
                  </Link>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {state.nextCursor !== null && (
        <Button
          variant="secondary"
          size="sm"
          onClick={loadMore}
          disabled={loadingMore}
          data-testid="skill-history-load-more"
        >
          {t('history.loadMore')}
        </Button>
      )}
    </Card>
  );
}

export default SkillOperationHistory;
