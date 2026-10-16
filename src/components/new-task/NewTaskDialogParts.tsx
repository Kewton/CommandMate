'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import {
  ALLOWED_DURATIONS,
  DURATION_LABELS,
  formatTimeRemaining,
  isAllowedDuration,
  type AutoYesDuration,
} from '@/config/auto-yes-config';
import { sameTarget, type NewTaskTarget } from '@/lib/new-task/recent-targets';
import { describeTargetState } from '@/lib/new-task/new-task-targets';
import type { NewTaskSendResult } from '@/lib/new-task/send-new-task';
import type { Worktree } from '@/types/models';

export const FIELD_CLASS =
  'w-full px-3 py-2 border border-input rounded-lg bg-surface text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent disabled:opacity-60';
export const LABEL_CLASS = 'block text-xs font-medium text-muted-foreground mb-1';

type Failure = Extract<NewTaskSendResult, { ok: false }>;
type Instance = Parameters<typeof describeTargetState>[1];
type TargetState = NonNullable<ReturnType<typeof describeTargetState>>;
type ModelAvailability =
  | { selectable: true }
  | { selectable: false; reason: string }
  | null;

export function ListStatusNotice({
  status,
  isEmpty,
  onRetry,
}: {
  status: 'loading' | 'error' | 'ready';
  isEmpty: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations('common');
  return (
    <>
      {status === 'loading' && (
        <p className="text-sm text-muted-foreground" data-testid="new-task-loading">
          {t('newTask.loading')}
        </p>
      )}

      {status === 'error' && (
        <div className="space-y-2" role="alert" data-testid="new-task-load-error">
          <p className="text-sm text-danger">{t('newTask.loadError')}</p>
          <button
            type="button"
            onClick={onRetry}
            className="px-3 py-1.5 text-sm font-medium text-foreground bg-muted hover:bg-muted/80 rounded-lg"
          >
            {t('retry')}
          </button>
        </div>
      )}

      {status === 'ready' && isEmpty && (
        <p className="text-sm text-muted-foreground" data-testid="new-task-empty">
          {t('newTask.noTargets')}
        </p>
      )}
    </>
  );
}

export function RecentTargets({
  recentOptions,
  targetState,
  worktreeId,
  onSelect,
}: {
  recentOptions: Array<{ target: NewTaskTarget; label: string }>;
  targetState: TargetState | null;
  worktreeId: string;
  onSelect: (target: NewTaskTarget) => void;
}) {
  const t = useTranslations('common');
  if (recentOptions.length === 0) return null;
  return (
    <div>
      <span className={LABEL_CLASS}>{t('newTask.recentLabel')}</span>
      <div className="flex flex-wrap gap-2" data-testid="new-task-recents">
        {recentOptions.map(({ target, label }) => {
          const selected = targetState
            ? sameTarget(target, { worktreeId, instanceId: targetState.instance.id })
            : false;
          return (
            <button
              key={`${target.worktreeId}:${target.instanceId}`}
              type="button"
              aria-pressed={selected}
              data-testid="new-task-recent"
              onClick={() => onSelect(target)}
              className={`max-w-full truncate rounded-full border px-3 py-1 text-xs transition-colors ${
                selected
                  ? 'border-accent-500 bg-accent-500/15 text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TargetSelectors({
  repositoryOptions,
  repository,
  worktreeId,
  worktree,
  instances,
  instance,
  onRepositoryChange,
  onBranchChange,
  onAgentChange,
}: {
  repositoryOptions: Array<{ path: string; name: string }>;
  repository: { path: string; worktrees: Worktree[] } | null;
  worktreeId: string;
  worktree: Worktree | null;
  instances: Instance[];
  instance: Instance | null;
  onRepositoryChange: (path: string) => void;
  onBranchChange: (id: string) => void;
  onAgentChange: (instanceId: string) => void;
}) {
  const t = useTranslations('common');
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div>
        <label htmlFor="new-task-repository" className={LABEL_CLASS}>
          {t('newTask.repositoryLabel')}
        </label>
        <select
          id="new-task-repository"
          data-testid="new-task-repository"
          value={repository?.path ?? ''}
          onChange={(e) => onRepositoryChange(e.target.value)}
          className={FIELD_CLASS}
        >
          {repositoryOptions.map((repo) => (
            <option key={repo.path} value={repo.path}>
              {repo.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="new-task-branch" className={LABEL_CLASS}>
          {t('newTask.branchLabel')}
        </label>
        <select
          id="new-task-branch"
          data-testid="new-task-branch"
          value={worktreeId}
          onChange={(e) => onBranchChange(e.target.value)}
          className={FIELD_CLASS}
        >
          {(repository?.worktrees ?? []).map((wt) => (
            <option key={wt.id} value={wt.id}>
              {wt.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="new-task-agent" className={LABEL_CLASS}>
          {t('newTask.agentLabel')}
        </label>
        <select
          id="new-task-agent"
          data-testid="new-task-agent"
          value={instance?.id ?? ''}
          onChange={(e) => onAgentChange(e.target.value)}
          className={FIELD_CLASS}
          disabled={instances.length === 0}
        >
          {instances.map((inst) => {
            const state = worktree ? describeTargetState(worktree, inst) : null;
            const status = state?.starting ? 'starting' : state?.running ? 'running' : 'stopped';
            return (
              <option key={inst.id} value={inst.id}>
                {`${state?.label ?? inst.id} — ${t(`newTask.agentStatus.${status}`)}`}
              </option>
            );
          })}
        </select>
      </div>
    </div>
  );
}

export function StartNotice({
  statusKey,
  agentLabel,
}: {
  statusKey: 'starting' | 'running' | 'stopped' | null;
  agentLabel: string;
}) {
  const t = useTranslations('common');
  return (
    <>
      {statusKey === 'stopped' && (
        <p className="text-xs text-foreground" data-testid="new-task-will-start">
          {t('newTask.willStart', { agent: agentLabel })}
        </p>
      )}
      {statusKey === 'starting' && (
        <p className="text-xs text-warning-foreground" data-testid="new-task-starting">
          {t('newTask.startingNotice', { agent: agentLabel })}
        </p>
      )}
    </>
  );
}

export function ModelField({
  modelAvailability,
  model,
  cliTool,
  agentLabel,
  onChange,
}: {
  modelAvailability: ModelAvailability;
  model: string;
  cliTool: string | undefined;
  agentLabel: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations('common');
  return (
    <div>
      <label htmlFor="new-task-model" className={LABEL_CLASS}>
        {t('newTask.modelLabel')}
      </label>
      <input
        id="new-task-model"
        data-testid="new-task-model"
        type="text"
        value={modelAvailability?.selectable ? model : ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('newTask.modelPlaceholder')}
        disabled={!modelAvailability?.selectable}
        className={FIELD_CLASS}
      />
      {modelAvailability && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="new-task-model-note">
          {modelAvailability.selectable
            ? t(cliTool === 'copilot' ? 'newTask.modelHintSwitch' : 'newTask.modelHintLaunch')
            : t(`newTask.modelUnavailable.${modelAvailability.reason}`, { agent: agentLabel })}
        </p>
      )}
    </div>
  );
}

export function AutoYesField({
  armedAutoYes,
  autoYesChoice,
  autoYesUnknown,
  onChoiceChange,
}: {
  armedAutoYes: { expiresAt: number } | null;
  autoYesChoice: AutoYesDuration | null;
  autoYesUnknown: boolean;
  onChoiceChange: (choice: AutoYesDuration | null) => void;
}) {
  const t = useTranslations('common');
  const tAutoYes = useTranslations('autoYes');
  return (
    <div>
      <label htmlFor="new-task-auto-yes" className={LABEL_CLASS}>
        {t('newTask.autoYesLabel')}
      </label>
      {armedAutoYes ? (
        <p className="text-sm text-foreground" data-testid="new-task-auto-yes-active">
          {t('newTask.autoYesActive', { remaining: formatTimeRemaining(armedAutoYes.expiresAt) })}
        </p>
      ) : (
        <>
          <select
            id="new-task-auto-yes"
            data-testid="new-task-auto-yes"
            value={autoYesChoice ?? ''}
            onChange={(e) => {
              const value = Number(e.target.value);
              onChoiceChange(e.target.value !== '' && isAllowedDuration(value) ? value : null);
            }}
            className={FIELD_CLASS}
          >
            <option value="">{t(autoYesUnknown ? 'newTask.autoYesKeepUnknown' : 'newTask.autoYesKeep')}</option>
            {ALLOWED_DURATIONS.map((duration) => (
              <option key={duration} value={duration}>
                {t('newTask.autoYesEnableFor', {
                  duration: tAutoYes(DURATION_LABELS[duration].replace('autoYes.', '')),
                })}
              </option>
            ))}
          </select>
          {autoYesUnknown && (
            <p className="mt-1 text-xs text-warning-foreground" data-testid="new-task-auto-yes-unknown">
              {t('newTask.autoYesUnknown')}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">{t('newTask.autoYesScope')}</p>
          {autoYesChoice !== null && (
            <p className="mt-1 text-xs text-warning-foreground" data-testid="new-task-auto-yes-risk">
              {tAutoYes('riskWarning')}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function FailureNotice({ failure, agentLabel }: { failure: Failure | null; agentLabel: string }) {
  const t = useTranslations('common');
  if (!failure) return null;
  return (
    <div
      role="alert"
      data-testid="new-task-error"
      data-kind={failure.kind}
      className="rounded-lg border border-danger-border bg-danger-subtle px-3 py-2 text-sm text-danger-foreground"
    >
      <p>{t(`newTask.errors.${failure.kind}`, { agent: agentLabel })}</p>
      {failure.detail && (
        <p className="mt-1 break-words text-xs text-muted-foreground" data-testid="new-task-error-detail">
          {failure.detail}
        </p>
      )}
    </div>
  );
}
