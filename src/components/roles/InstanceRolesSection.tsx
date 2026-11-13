/**
 * The role of each session in a worktree, in the roster pane (Issue #4117), and so on
 * a phone as well: `MobileAgentInstancesPane` renders the same pane.
 *
 * Reads nothing until it is opened: the roster pane issues no request of its own for
 * a roster of ordinary tools (#2054), and its other disclosures keep to that too.
 *
 * The rows are the API's, not the pane's: a primary derived from `selectedAgents` has
 * an entry and can hold a setting with no roster saved.
 */

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useHandoffPageOwner } from '@/hooks/useHandoffPageOwner';
import {
  beginHandoffPageOperation,
  fetchForHandoffPage,
  handoffPageOperationOptions,
  isHandoffPageOperationRefused,
  type HandoffPageOperation,
} from '@/lib/handoff/page-owner';
import { readRunningInstancesForPage } from '@/hooks/page-owned-reads';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { getCliToolDisplayName } from '@/lib/cli-tools/types';
import { roleApi } from '@/lib/api-client-agent-roles';
import {
  clearRosterSnapshot,
  useInstanceRoleSettings,
  useRoleCatalogChanged,
  writeInstanceRoleSettings,
} from '@/hooks/useInstanceRoleSettings';
import type { AgentRoleSummary, InstanceRoleEntry } from '@/types/agent-roles';
import { RoleChoiceSelect } from './RoleChoiceSelect';
import {
  effectiveRoleLabel,
  roleApplicationView,
  roleChoiceOf,
  roleInputOf,
  roleSourceText,
  roleToolNoteKeys,
  storedRoleOption,
  type RoleTranslate,
} from './role-display';

/** The deadline every other role write has. A kill that outlives it may still have ended the session. */
const KILL_SESSION_TIMEOUT_MS = 15000;

function InstanceRoleRow({
  worktreeId,
  entry,
  rosterRevision,
  roles,
  isRunning,
  onChanged,
  t,
}: {
  worktreeId: string;
  entry: InstanceRoleEntry;
  /** The roster this row was read with: a choice applies to that roster only (#4132). */
  rosterRevision: string;
  roles: readonly AgentRoleSummary[];
  /** Null: the read failed. Undefined: not answered yet, so nothing is said about the launch. */
  isRunning: boolean | null | undefined;
  onChanged: () => void;
  t: RoleTranslate;
}): React.ReactElement {
  const confirm = useConfirm();
  const tSchedule = useTranslations('schedule');
  // Issue #4345 1c: drawn in a worktree page's agents pane, the page's registration holder (the
  // kill below is the page's); elsewhere none, and nothing is reported.
  const handoffOwner = useHandoffPageOwner();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Issue #4160: past the deadline with the session still there. Not a failure, and it
  // stops being true as soon as a read shows the session gone.
  const [killInProgress, setKillInProgress] = useState(false);
  useEffect(() => {
    if (isRunning === false) setKillInProgress(false);
  }, [isRunning]);
  // Issue #4160: the ref answers a press in the same tick and covers the dialog too,
  // because a second confirm() would cancel the first and carry on as if confirmed.
  const [restarting, setRestarting] = useState(false);
  const restartingRef = useRef(false);
  const id = entry.instanceId;
  const next = entry.application.effectiveNext;

  const handleChange = useCallback(
    async (choice: string) => {
      setSaving(true);
      setError(null);
      const result = await writeInstanceRoleSettings(worktreeId, () =>
        roleApi.setInstanceRole(worktreeId, id, roleInputOf(choice), rosterRevision),
      );
      if (!result.ok && result.error === 'roster_changed') {
        // Nothing was saved, and this row may not be what it was: show what is there to choose from.
        setError(tSchedule('agentInstanceRosterChanged'));
        clearRosterSnapshot(worktreeId);
        onChanged();
      } else if (!result.ok) {
        setError(t(result.outcomeUnknown ? 'agentRoles.saveUnknown' : 'agentRoles.instances.saveError'));
      }
      setSaving(false);
    },
    [worktreeId, id, rosterRevision, onChanged, t, tSchedule],
  );

  const endSession = useCallback(async (operation: HandoffPageOperation) => {
    setError(null);
    setKillInProgress(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), KILL_SESSION_TIMEOUT_MS);
    // Issue #4133: only a refusal says it did not happen. A 5xx, no answer or the
    // deadline say nothing, so what is running now decides, and either way the rows
    // are read again.
    let failed = false;
    let saidNothing: 'errored' | 'silent' | null = null;
    try {
      // The query scopes it: without both, this route ends every session of the worktree.
      const query = new URLSearchParams({ cliTool: entry.cliToolId, instance: id });
      // Issue #4345 1c 再指示 2 (K1): the press's token goes to the gate.
      const response = await fetchForHandoffPage(
        handoffOwner,
        `/api/worktrees/${worktreeId}/kill-session?${query.toString()}`,
        { method: 'POST', signal: controller.signal },
        handoffPageOperationOptions(operation),
      );
      // 404: already ended, which is the goal.
      if (!response.ok && response.status !== 404) {
        failed = response.status < 500;
        if (!failed) saidNothing = 'errored';
      }
    } catch (err) {
      // Issue #4345 1c 再指示 2 (K1): not sent (the page's gate refused it) — not a kill's result:
      // nothing is said, nothing read again.
      if (isHandoffPageOperationRefused(err)) {
        clearTimeout(timer);
        return;
      }
      saidNothing = 'silent';
    } finally {
      clearTimeout(timer);
    }
    if (saidNothing) {
      // Issue #4345 1c 再指示 1: the running read is the page's too (its 401 reaches the gateway).
      const running = await readRunningInstancesForPage(handoffOwner, worktreeId);
      if (running === null) {
        // Issue #4145: a read that failed cannot say either way, and the screen says that.
        setError(t('agentRoles.instances.restartUnknown'));
      } else if (running[id] === true) {
        // Issue #4160: a 5xx means the server has finished and the session is still
        // there. With no answer it may still be working on it (a graceful exit takes
        // seconds), so that is not called a failure.
        failed = saidNothing === 'errored';
        setKillInProgress(!failed);
      }
    }
    if (failed) setError(t('agentRoles.instances.restartError'));
    onChanged();
  }, [entry.cliToolId, id, onChanged, t, worktreeId, handoffOwner]);

  const handleRestart = useCallback(async () => {
    if (restartingRef.current) return;
    restartingRef.current = true;
    // Issue #4345 1c 再指示 1: the page's registration when pressed. A 401 taken while the person
    // confirms (or the page made again) starts no kill: checked at the press and after the answer.
    const operation = beginHandoffPageOperation(handoffOwner);
    try {
      if (!operation.mayStart()) return;
      if (!(await confirm({ description: t('agentRoles.instances.restartConfirm', { alias: entry.alias }) }))) return;
      if (!operation.mayStart()) return;
      setRestarting(true);
      await endSession(operation);
    } finally {
      restartingRef.current = false;
      setRestarting(false);
    }
  }, [confirm, endSession, entry.alias, t, handoffOwner]);

  const view = isRunning === undefined ? null : roleApplicationView(entry, isRunning, t);
  const inherited = entry.stored.state === 'inherit';
  // The first option names what "from above" gives: the tool's default, not this
  // row's own explicit choice, which would read the same in the closed select.
  const inheritLabel = inherited
    ? t('agentRoles.choice.inheritNamed', { label: effectiveRoleLabel(next, t) || t('agentRoles.application.ambiguous') })
    : t('agentRoles.choice.inherit');

  return (
    <li data-testid={`instance-role-row-${id}`} className="space-y-1 rounded-lg border border-border bg-surface p-2">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="min-w-0 truncate font-medium text-foreground">{entry.alias}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{getCliToolDisplayName(entry.cliToolId)}</span>
      </div>
      {entry.supported ? (
        <>
          <RoleChoiceSelect
            value={roleChoiceOf(entry.stored)}
            inheritLabel={inheritLabel}
            roles={roles}
            storedRole={storedRoleOption(entry.stored)}
            disabled={saving}
            ariaLabel={t('agentRoles.instances.selectLabel', { alias: entry.alias })}
            testId={`instance-role-select-${id}`}
            onChange={(choice) => void handleChange(choice)}
          />
          <p data-testid={`instance-role-source-${id}`} className="text-xs text-muted-foreground break-words">
            {roleSourceText(next, inherited, t)}
          </p>
          {view && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                data-testid={`instance-role-status-${id}`}
                className={view.pending ? 'text-warning' : 'text-muted-foreground'}
              >
                {view.text}
              </span>
              {view.restartable && (
                <button
                  type="button"
                  data-testid={`instance-role-restart-${id}`}
                  title={t('agentRoles.application.restartHint')}
                  disabled={restarting}
                  onClick={() => void handleRestart()}
                  className="min-h-8 rounded px-2 text-accent-700 dark:text-accent-300 underline hover:bg-muted disabled:opacity-50"
                >
                  {t('agentRoles.application.restart')}
                </button>
              )}
            </div>
          )}
          {!entry.adapterEnabled && (
            <p data-testid={`instance-role-adapter-off-${id}`} className="text-xs text-warning">
              {t('agentRoles.adapterDisabledNote')}
            </p>
          )}
          {entry.application.resumedAcrossRole && (
            <p data-testid={`instance-role-resumed-${id}`} className="text-xs text-warning">
              {t('agentRoles.resumedAcrossRoleNote')}
            </p>
          )}
          {roleToolNoteKeys(entry.cliToolId).map((key) => (
            <p key={key} className="text-xs text-muted-foreground">
              {t(key)}
            </p>
          ))}
        </>
      ) : (
        <p data-testid={`instance-role-unsupported-${id}`} className="text-xs text-muted-foreground">
          {t('agentRoles.unsupportedNote')}
        </p>
      )}
      {killInProgress && (
        <p role="status" data-testid={`instance-role-progress-${id}`} className="text-xs text-warning">
          {t('agentRoles.instances.restartInProgress')}
        </p>
      )}
      {error && (
        <p role="alert" data-testid={`instance-role-error-${id}`} className="text-xs text-danger-foreground">
          {error}
        </p>
      )}
    </li>
  );
}

function OpenInstanceRoles({ worktreeId, rosterKey }: { worktreeId: string; rosterKey: string }): React.ReactElement {
  const t = useTranslations('common');
  const { settings, stale, refresh } = useInstanceRoleSettings(worktreeId, rosterKey);
  const [roles, setRoles] = useState<AgentRoleSummary[]>([]);
  // Undefined until the first answer; null when a read failed, which is not "stopped".
  const [running, setRunning] = useState<Record<string, boolean> | null | undefined>(undefined);
  const [readToken, setReadToken] = useState(0);
  const [catalogToken, setCatalogToken] = useState(0);
  const [rolesFailed, setRolesFailed] = useState(false);
  // Issue #4345 1c 再指示 1: the running read below is the page's when drawn in its agents pane.
  const handoffOwner = useHandoffPageOwner();

  const onCatalogChanged = useCallback(() => setCatalogToken((token) => token + 1), []);
  useRoleCatalogChanged(onCatalogChanged);

  useEffect(() => {
    let cancelled = false;
    void roleApi.list().then((result) => {
      if (cancelled) return;
      if (result.ok) setRoles(result.data.roles);
      setRolesFailed(!result.ok);
    });
    return () => {
      cancelled = true;
    };
  }, [catalogToken]);

  // Whenever the settings move, not only on opening: a session started elsewhere shows
  // up in them, and its row must not go on reading as stopped. No polling of its own.
  useEffect(() => {
    if (!settings) return;
    let cancelled = false;
    void readRunningInstancesForPage(handoffOwner, worktreeId).then((next) => {
      if (!cancelled) setRunning(next);
    });
    return () => {
      cancelled = true;
    };
  }, [worktreeId, rosterKey, readToken, settings, handoffOwner]);

  const onChanged = useCallback(() => {
    setReadToken((token) => token + 1);
    void refresh();
  }, [refresh]);

  if (!settings) {
    return <p className="text-xs text-muted-foreground">{t('agentRoles.loading')}</p>;
  }
  return (
    <>
      {running === null && (
        <p data-testid="instance-roles-running-unknown" className="text-xs text-warning">
          {t('agentRoles.instances.runningUnknown')}
        </p>
      )}
      {stale && (
        <p role="status" data-testid="instance-roles-stale" className="text-xs text-warning">
          {t('agentRoles.savedStale')}
        </p>
      )}
      {rolesFailed && (
        <p role="alert" data-testid="instance-roles-list-error" className="text-xs text-danger-foreground">
          {t('agentRoles.loadError')}
        </p>
      )}
      <ul className="space-y-2" data-testid="instance-roles-list">
        {settings.instances.map((entry) => (
          <InstanceRoleRow
            // Issue #4160: instance ids repeat across worktrees, and what this row is
            // doing or has said belongs to the one it was pressed in.
            key={`${worktreeId}:${entry.instanceId}`}
            worktreeId={worktreeId}
            entry={entry}
            rosterRevision={settings.rosterRevision}
            roles={roles}
            isRunning={running ? running[entry.instanceId] === true : running}
            onChanged={onChanged}
            t={t}
          />
        ))}
      </ul>
    </>
  );
}

export function InstanceRolesSection({
  worktreeId,
  rosterKey,
}: {
  worktreeId: string;
  /** Changes when the roster does, so the rows follow it. */
  rosterKey: string;
}): React.ReactElement {
  const t = useTranslations('common');
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-6 border-t border-border pt-4">
      <button
        type="button"
        data-testid="instance-roles-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1 text-left text-sm font-semibold text-foreground hover:text-accent-600 dark:hover:text-accent-400"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        {t('agentRoles.instances.title')}
      </button>
      {open && (
        <div className="mt-2 space-y-2" data-testid="instance-roles-section">
          <p className="text-xs text-muted-foreground">{t('agentRoles.instances.description')}</p>
          <OpenInstanceRoles worktreeId={worktreeId} rosterKey={rosterKey} />
        </div>
      )}
    </div>
  );
}
