/**
 * NewTaskDialog (Issue #3511)
 *
 * "New task": write a request and send it to any agent of any branch, from
 * any screen. Mounted by `NewTaskDialogHost` only while open.
 *
 * - Destination: repository → branch → agent, kept as worktree ID + instance
 *   ID. It starts on the screen's own worktree and agent, else the last
 *   destination sent to, else the first agent listed. The last three
 *   destinations are one click away.
 * - A stopped agent is started by the send route itself; the dialog says so
 *   before the user sends.
 * - Model: offered only where the send route honours it (see
 *   `resolveModelAvailability`), with the reason when it is not.
 * - Auto-Yes: the instance's own, time-limited Auto-Yes — there is no
 *   per-send variant. An armed one shows its time left and is left alone; an
 *   unarmed one stays off unless a duration is picked.
 * - Every refusal (409 prompt waiting, 400 model, 503 still starting, any
 *   failure) keeps the dialog and the request open and says why.
 * - Sent: the dialog closes, the branch screen opens with the instance
 *   selected (`?instance=`, the path the sessions list uses, Issue #2656), and
 *   a toast names the destination and goes back when clicked.
 */

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Kbd } from '@/components/ui/Kbd';
import { useToast } from '@/components/common/Toast';
import { useNewTask } from '@/contexts/NewTaskContext';
import { worktreeApi, type RepositorySummary } from '@/lib/api-client';
import type { Worktree } from '@/types/models';
import { buildSessionRowHref } from '@/lib/sidebar-utils';
import {
  ALLOWED_DURATIONS,
  AUTO_YES_COUNTDOWN_INTERVAL_MS,
  DURATION_LABELS,
  formatTimeRemaining,
  isAllowedDuration,
  type AutoYesDuration,
} from '@/config/auto-yes-config';
import { isMacPlatform, resolveShortcutKey, MOD_KEY_TOKEN } from '@/config/keyboard-shortcuts';
import {
  pushRecentTarget,
  readRecentTargets,
  sameTarget,
  type NewTaskTarget,
} from '@/lib/new-task/recent-targets';
import {
  buildRepositoryOptions,
  describeTargetState,
  findTarget,
  resolveInitialTarget,
  resolveModelAvailability,
  resolveWorktreeInstances,
} from '@/lib/new-task/new-task-targets';
import {
  sendNewTask,
  type NewTaskSendResult,
} from '@/lib/new-task/send-new-task';
import { isSendNewTaskChord } from '@/lib/new-task/new-task-shortcut';

/** How long the "sent" toast (and its way back) stays up. */
const SENT_TOAST_DURATION_MS = 6000;

const FIELD_CLASS =
  'w-full px-3 py-2 border border-input rounded-lg bg-surface text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent disabled:opacity-60';
const LABEL_CLASS = 'block text-xs font-medium text-muted-foreground mb-1';

type ListState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; worktrees: Worktree[]; repositories: RepositorySummary[] };

type Failure = Extract<NewTaskSendResult, { ok: false }>;

export function NewTaskDialog() {
  const { requestedTarget, screenTarget, closeNewTask } = useNewTask();
  const router = useRouter();
  const { showToast } = useToast();
  const t = useTranslations('common');
  const tAutoYes = useTranslations('autoYes');

  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [loadToken, setLoadToken] = useState(0);
  const [recents] = useState<NewTaskTarget[]>(() => readRecentTargets());
  const [worktreeId, setWorktreeId] = useState('');
  const [instanceId, setInstanceId] = useState('');
  const [content, setContent] = useState('');
  const [model, setModel] = useState('');
  const [autoYesChoice, setAutoYesChoice] = useState<AutoYesDuration | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [isMac, setIsMac] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    setIsMac(isMacPlatform());
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The start position is decided once, from what was known when it opened.
  const initialCandidatesRef = useRef<Array<NewTaskTarget | null>>([
    requestedTarget,
    screenTarget,
    recents[0] ?? null,
  ]);
  const initializedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setList({ status: 'loading' });
    worktreeApi
      .getAll()
      .then((response) => {
        if (cancelled) return;
        const worktrees = response.worktrees ?? [];
        const repositories = response.repositories ?? [];
        setList({ status: 'ready', worktrees, repositories });
        if (initializedRef.current) return;
        initializedRef.current = true;
        const initial = resolveInitialTarget(worktrees, initialCandidatesRef.current, repositories);
        if (initial) {
          setWorktreeId(initial.worktreeId);
          setInstanceId(initial.instanceId);
        }
      })
      .catch(() => {
        if (!cancelled) setList({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [loadToken]);

  const worktrees = useMemo(() => (list.status === 'ready' ? list.worktrees : []), [list]);
  const repositoryOptions = useMemo(
    () => (list.status === 'ready' ? buildRepositoryOptions(list.worktrees, list.repositories) : []),
    [list],
  );

  const worktree = worktrees.find((wt) => wt.id === worktreeId) ?? null;
  const instances = useMemo(() => (worktree ? resolveWorktreeInstances(worktree) : []), [worktree]);
  const instance = instances.find((inst) => inst.id === instanceId) ?? null;
  const targetState = worktree && instance ? describeTargetState(worktree, instance) : null;
  const repository = worktree
    ? repositoryOptions.find((repo) => repo.path === worktree.repositoryPath) ?? null
    : null;
  const modelAvailability = targetState
    ? resolveModelAvailability(targetState.instance.cliTool, targetState)
    : null;
  const armedAutoYes = targetState?.autoYes ?? null;

  // Re-render once a second while an armed Auto-Yes counts down.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!armedAutoYes) return;
    const timer = setInterval(() => setNow(Date.now()), AUTO_YES_COUNTDOWN_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [armedAutoYes]);

  useEffect(() => {
    if (list.status === 'ready') textareaRef.current?.focus();
  }, [list.status]);

  const recentOptions = useMemo(
    () =>
      recents.flatMap((recent) => {
        const found = findTarget(worktrees, recent);
        if (!found) return [];
        const repo = repositoryOptions.find((r) => r.path === found.worktree.repositoryPath);
        const agent = describeTargetState(found.worktree, found.instance).label;
        return [{ target: recent, label: `${repo?.name ?? found.worktree.repositoryName} / ${found.worktree.name} / ${agent}` }];
      }),
    [recents, worktrees, repositoryOptions],
  );

  const selectTarget = useCallback((target: NewTaskTarget) => {
    setWorktreeId(target.worktreeId);
    setInstanceId(target.instanceId);
    setFailure(null);
  }, []);

  const handleRepositoryChange = useCallback(
    (path: string) => {
      const repo = repositoryOptions.find((r) => r.path === path);
      const next = repo?.worktrees.find((wt) => resolveWorktreeInstances(wt).length > 0) ?? repo?.worktrees[0];
      if (!next) return;
      selectTarget({ worktreeId: next.id, instanceId: resolveWorktreeInstances(next)[0]?.id ?? '' });
    },
    [repositoryOptions, selectTarget],
  );

  const handleBranchChange = useCallback(
    (id: string) => {
      const next = worktrees.find((wt) => wt.id === id);
      if (!next) return;
      const roster = resolveWorktreeInstances(next);
      // The same agent on the new branch when it has one; its first agent otherwise.
      const keep = roster.find((inst) => inst.id === instanceId);
      selectTarget({ worktreeId: next.id, instanceId: keep?.id ?? roster[0]?.id ?? '' });
    },
    [worktrees, instanceId, selectTarget],
  );

  const canSend = !!targetState && content.trim() !== '' && !sending;

  const handleSubmit = useCallback(async () => {
    if (!canSend || !worktree || !targetState) return;
    const target: NewTaskTarget = { worktreeId: worktree.id, instanceId: targetState.instance.id };
    setSending(true);
    setFailure(null);
    const result = await sendNewTask({
      target,
      cliToolId: targetState.instance.cliTool,
      content: content.trim(),
      model: modelAvailability?.selectable ? model : undefined,
      autoYesDuration: armedAutoYes ? null : autoYesChoice,
    });
    if (!mountedRef.current) return;
    if (!result.ok) {
      setFailure(result);
      setSending(false);
      return;
    }

    pushRecentTarget(target);
    const backHref = `${window.location.pathname}${window.location.search}`;
    const destination = `${worktree.name} / ${targetState.label}`;
    closeNewTask();
    router.push(buildSessionRowHref(target));
    showToast(t('newTask.sentToast', { target: destination }), 'success', SENT_TOAST_DURATION_MS, {
      onClick: () => router.push(backHref),
    });
  }, [
    canSend,
    worktree,
    targetState,
    content,
    modelAvailability,
    model,
    armedAutoYes,
    autoYesChoice,
    closeNewTask,
    router,
    showToast,
    t,
  ]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!isSendNewTaskChord(event.nativeEvent)) return;
      event.preventDefault();
      void handleSubmit();
    },
    [handleSubmit],
  );

  const agentLabel = targetState?.label ?? '';
  const statusKey = targetState
    ? targetState.starting
      ? 'starting'
      : targetState.running
        ? 'running'
        : 'stopped'
    : null;

  return (
    <Modal isOpen onClose={closeNewTask} title={t('newTask.title')} size="md" disableClose={sending}>
      <div data-testid="new-task-dialog" className="space-y-4" onKeyDown={handleKeyDown}>
        {list.status === 'loading' && (
          <p className="text-sm text-muted-foreground" data-testid="new-task-loading">
            {t('newTask.loading')}
          </p>
        )}

        {list.status === 'error' && (
          <div className="space-y-2" role="alert" data-testid="new-task-load-error">
            <p className="text-sm text-danger">{t('newTask.loadError')}</p>
            <button
              type="button"
              onClick={() => setLoadToken((n) => n + 1)}
              className="px-3 py-1.5 text-sm font-medium text-foreground bg-muted hover:bg-muted/80 rounded-lg"
            >
              {t('retry')}
            </button>
          </div>
        )}

        {list.status === 'ready' && repositoryOptions.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="new-task-empty">
            {t('newTask.noTargets')}
          </p>
        )}

        {list.status === 'ready' && repositoryOptions.length > 0 && (
          <>
            {recentOptions.length > 0 && (
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
                        onClick={() => selectTarget(target)}
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
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="new-task-repository" className={LABEL_CLASS}>
                  {t('newTask.repositoryLabel')}
                </label>
                <select
                  id="new-task-repository"
                  data-testid="new-task-repository"
                  value={repository?.path ?? ''}
                  onChange={(e) => handleRepositoryChange(e.target.value)}
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
                  onChange={(e) => handleBranchChange(e.target.value)}
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
                  onChange={(e) => selectTarget({ worktreeId, instanceId: e.target.value })}
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

            <div>
              <label htmlFor="new-task-message" className={LABEL_CLASS}>
                {t('newTask.messageLabel')}
              </label>
              <textarea
                ref={textareaRef}
                id="new-task-message"
                data-testid="new-task-message"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={t('newTask.messagePlaceholder')}
                rows={5}
                className={`${FIELD_CLASS} resize-y`}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="new-task-model" className={LABEL_CLASS}>
                  {t('newTask.modelLabel')}
                </label>
                <input
                  id="new-task-model"
                  data-testid="new-task-model"
                  type="text"
                  value={modelAvailability?.selectable ? model : ''}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={t('newTask.modelPlaceholder')}
                  disabled={!modelAvailability?.selectable}
                  className={FIELD_CLASS}
                />
                {modelAvailability && (
                  <p className="mt-1 text-xs text-muted-foreground" data-testid="new-task-model-note">
                    {modelAvailability.selectable
                      ? t(
                          targetState?.instance.cliTool === 'copilot'
                            ? 'newTask.modelHintSwitch'
                            : 'newTask.modelHintLaunch',
                        )
                      : t(`newTask.modelUnavailable.${modelAvailability.reason}`, { agent: agentLabel })}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="new-task-auto-yes" className={LABEL_CLASS}>
                  {t('newTask.autoYesLabel')}
                </label>
                {armedAutoYes && armedAutoYes.expiresAt !== null ? (
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
                        setAutoYesChoice(e.target.value !== '' && isAllowedDuration(value) ? value : null);
                      }}
                      className={FIELD_CLASS}
                    >
                      <option value="">{t('newTask.autoYesKeep')}</option>
                      {ALLOWED_DURATIONS.map((duration) => (
                        <option key={duration} value={duration}>
                          {t('newTask.autoYesEnableFor', {
                            duration: tAutoYes(DURATION_LABELS[duration].replace('autoYes.', '')),
                          })}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-muted-foreground">{t('newTask.autoYesScope')}</p>
                    {autoYesChoice !== null && (
                      <p className="mt-1 text-xs text-warning-foreground" data-testid="new-task-auto-yes-risk">
                        {tAutoYes('riskWarning')}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {failure && (
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
        )}

        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
            <Kbd>{resolveShortcutKey(MOD_KEY_TOKEN, isMac)}</Kbd>
            <Kbd>↵</Kbd>
            <span>{t('newTask.sendHint')}</span>
          </span>
          <button
            type="button"
            onClick={closeNewTask}
            disabled={sending}
            className="px-4 py-2 text-sm font-medium text-foreground bg-muted hover:bg-muted/80 rounded-lg transition-colors disabled:opacity-50"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            data-testid="new-task-send"
            onClick={() => void handleSubmit()}
            disabled={!canSend}
            className="px-4 py-2 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
          >
            {sending ? t('newTask.sending') : t('newTask.send')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default NewTaskDialog;
