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
  AUTO_YES_COUNTDOWN_INTERVAL_MS,
  type AutoYesDuration,
} from '@/config/auto-yes-config';
import { isMacPlatform, resolveShortcutKey, MOD_KEY_TOKEN } from '@/config/keyboard-shortcuts';
import {
  pushRecentTarget,
  readRecentTargets,
  type NewTaskTarget,
} from '@/lib/new-task/recent-targets';
import {
  buildRepositoryOptions,
  describeTargetState,
  findTarget,
  resolveInitialTarget,
  resolveModelAvailability,
  resolveWorktreeInstances,
  isAutoYesActive,
} from '@/lib/new-task/new-task-targets';
import {
  sendNewTask,
  type ArmedAutoYes,
  type NewTaskSendResult,
} from '@/lib/new-task/send-new-task';
import { isSendNewTaskChord } from '@/lib/new-task/new-task-shortcut';
import { DEFAULT_AUTO_YES_ANSWER_MODE, type AutoYesAnswerMode } from '@/types/auto-yes-answer-mode';
import {
  AutoYesField,
  FailureNotice,
  FIELD_CLASS,
  LABEL_CLASS,
  ListStatusNotice,
  ModelField,
  RecentTargets,
  StartNotice,
  TargetSelectors,
} from './NewTaskDialogParts';

/** How long the "sent" toast (and its way back) stays up. */
const SENT_TOAST_DURATION_MS = 6000;

type ListState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; worktrees: Worktree[]; repositories: RepositorySummary[] };

type Failure = Extract<NewTaskSendResult, { ok: false }>;

export function NewTaskDialog() {
  const { requestedTarget, screenTarget, closeNewTask, setCloseLocked } = useNewTask();
  const router = useRouter();
  const { showToast } = useToast();
  const t = useTranslations('common');

  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [loadToken, setLoadToken] = useState(0);
  const [recents] = useState<NewTaskTarget[]>(() => readRecentTargets());
  const [worktreeId, setWorktreeId] = useState('');
  const [instanceId, setInstanceId] = useState('');
  const [content, setContent] = useState('');
  const [model, setModel] = useState('');
  const [autoYesChoice, setAutoYesChoice] = useState<AutoYesDuration | null>(null);
  // Issue #3863: the answer mode to arm with; the default until another is picked.
  const [autoYesAnswerMode, setAutoYesAnswerMode] = useState<AutoYesAnswerMode>(DEFAULT_AUTO_YES_ANSWER_MODE);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [isMac, setIsMac] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mountedRef = useRef(true);
  const sendingRef = useRef(false);
  // Auto-Yes this dialog armed, per destination (`<worktree>:<instance>`). The
  // list payload is a snapshot from opening time; after an arm whose send then
  // failed, the server holds the new state and the dialog must show it, and a
  // resend must not arm again.
  // Targets whose Auto-Yes answer gave no expiry: possibly on, never shown as off (Issue #3563).
  const [unknownHere, setUnknownHere] = useState<Record<string, true>>({});
  const [armedHere, setArmedHere] = useState<Record<string, ArmedAutoYes>>({});

  useEffect(() => {
    mountedRef.current = true;
    setIsMac(isMacPlatform());
    return () => {
      mountedRef.current = false;
      setCloseLocked(false);
    };
  }, [setCloseLocked]);

  /**
   * Every way out of the dialog — the × button, Esc, a backdrop click, Cancel —
   * comes through here, and does nothing while a send is in flight. `Modal`
   * calls `onClose` from its × without consulting `disableClose`, so the guard
   * cannot rely on that prop; the provider's lock covers `closeNewTask()` called
   * from anywhere else.
   */
  const handleClose = useCallback(() => {
    if (sendingRef.current) return;
    closeNewTask();
  }, [closeNewTask]);

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
  const knownAutoYes = targetState
    ? armedHere[`${worktreeId}:${targetState.instance.id}`] ?? targetState.autoYes
    : null;
  // Expired counts as off, as in AutoYesToggle: no "00:00 left" shown as on,
  // and arming is offered again.
  const armedAutoYes = isAutoYesActive(knownAutoYes) ? knownAutoYes : null;
  const autoYesUnknown = targetState ? unknownHere[`${worktreeId}:${targetState.instance.id}`] === true : false;

  // Re-render once a second while an armed Auto-Yes counts down; the render
  // that finds it expired drops `armedAutoYes`, which stops this.
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
    sendingRef.current = true;
    setCloseLocked(true);
    setSending(true);
    setFailure(null);
    const result = await sendNewTask({
      target,
      cliToolId: targetState.instance.cliTool,
      content: content.trim(),
      model: modelAvailability?.selectable ? model : undefined,
      autoYesDuration: armedAutoYes ? null : autoYesChoice,
      autoYesAnswerMode,
    });
    sendingRef.current = false;
    setCloseLocked(false);
    if (!mountedRef.current) return;
    const { armedAutoYes: armedNow } = result;
    const targetKey = `${target.worktreeId}:${target.instanceId}`;
    if (result.autoYesStateUnknown) {
      setUnknownHere((prev) => ({ ...prev, [targetKey]: true }));
    }
    if (armedNow) {
      setUnknownHere((prev) => {
        const { [targetKey]: _dropped, ...rest } = prev;
        return rest;
      });
      setArmedHere((prev) => ({ ...prev, [targetKey]: armedNow }));
      setAutoYesChoice(null);
      setAutoYesAnswerMode(DEFAULT_AUTO_YES_ANSWER_MODE);
    }
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
    autoYesAnswerMode,
    closeNewTask,
    setCloseLocked,
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
    <Modal isOpen onClose={handleClose} title={t('newTask.title')} size="md" disableClose={sending}>
      <div data-testid="new-task-dialog" className="space-y-4" onKeyDown={handleKeyDown}>
        <ListStatusNotice
          status={list.status}
          isEmpty={repositoryOptions.length === 0}
          onRetry={() => setLoadToken((n) => n + 1)}
        />

        {list.status === 'ready' && repositoryOptions.length > 0 && (
          <>
            <RecentTargets
              recentOptions={recentOptions}
              targetState={targetState}
              worktreeId={worktreeId}
              onSelect={selectTarget}
            />

            <TargetSelectors
              repositoryOptions={repositoryOptions}
              repository={repository}
              worktreeId={worktreeId}
              worktree={worktree}
              instances={instances}
              instance={instance}
              onRepositoryChange={handleRepositoryChange}
              onBranchChange={handleBranchChange}
              onAgentChange={(id) => selectTarget({ worktreeId, instanceId: id })}
            />

            <StartNotice statusKey={statusKey} agentLabel={agentLabel} />

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
              <ModelField
                modelAvailability={modelAvailability}
                model={model}
                cliTool={targetState?.instance.cliTool}
                agentLabel={agentLabel}
                onChange={setModel}
              />
              <AutoYesField
                armedAutoYes={armedAutoYes}
                autoYesChoice={autoYesChoice}
                autoYesUnknown={autoYesUnknown}
                onChoiceChange={setAutoYesChoice}
                answerMode={autoYesAnswerMode}
                onAnswerModeChange={setAutoYesAnswerMode}
              />
            </div>
          </>
        )}

        <FailureNotice failure={failure} agentLabel={agentLabel} />

        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
            <Kbd>{resolveShortcutKey(MOD_KEY_TOKEN, isMac)}</Kbd>
            <Kbd>↵</Kbd>
            <span>{t('newTask.sendHint')}</span>
          </span>
          <button
            type="button"
            data-testid="new-task-cancel"
            onClick={handleClose}
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
