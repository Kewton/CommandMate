/**
 * "Agent CLI versions and updates" (Issue #2069).
 *
 * One component, two homes — the More screen's Settings block and the agent
 * pane's roster editor — because they are the same question asked from two
 * places, and a second copy is how the pane ends up with a stale idea of what
 * an update does to a live session.
 *
 * ## What the update button actually does
 *
 * It posts to `/api/agents/update`, which runs the tool's own updater as a
 * child of the SERVER. Not in the pane: codex's own "Update now" terminates
 * codex and does not restart it, so a pane that runs it is left at a bare shell
 * (#2070). The consequence the user has to be told about is the other side of
 * that same coin — a session that is already running keeps the binary it
 * started with — which is what the warning and the restart button below are
 * for.
 *
 * The restart is `kill-session`, scoped to one instance. There is no
 * "start session" endpoint to pair it with: sessions are created by
 * `POST /api/worktrees/:id/send`, so the honest description is "end it, and the
 * next send starts a fresh one on the new binary". The copy says that.
 *
 * ## Why the version numbers are trustworthy without a network
 *
 * `installed` is `<cli> --version`. `latestVersion` is codex's OWN release
 * check, read out of `~/.codex/version.json` — CommandMate contacts nothing.
 * Every other tool therefore shows an installed version and no update column,
 * which is this Issue's 実装内容 2 rather than an omission.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useHandoffPageOwner } from '@/hooks/useHandoffPageOwner';
import { fetchForHandoffPage } from '@/lib/handoff/page-owner';
import { AlertTriangle, ArrowUpCircle, RotateCcw } from 'lucide-react';
import { Button, Card, Spinner } from '@/components/ui';
import { getCliToolDisplayName, type CLIToolType } from '@/lib/cli-tools/types';
import { useAgentUpdates, type AgentVersionView } from '@/hooks/useAgentUpdates';
import { readRunningInstances } from '@/lib/api-client-agent-roles';

/** The deadline `InstanceRolesSection` gives the same request. A kill that outlives it may still have ended the session. */
const KILL_SESSION_TIMEOUT_MS = 15000;

/** A roster row this card may offer to restart. */
export interface AgentUpdateInstance {
  id: string;
  cliTool: string;
  alias: string;
}

export interface AgentUpdatesCardProps {
  /**
   * Worktree whose sessions can be restarted from here.
   *
   * Omitted on the More screen, which is server-wide and has no session to
   * name — there the warning is generic and no restart button is rendered.
   */
  worktreeId?: string;
  /** The roster, so a restart button can say which instance it ends. */
  instances?: AgentUpdateInstance[];
  /** `plain` drops the Card chrome for a pane that supplies its own. */
  variant?: 'card' | 'plain';
}

/** Which roster instances currently have a live session, by instance id. */
function useRunningInstances(
  worktreeId: string | undefined,
  instances: AgentUpdateInstance[] | undefined,
  refreshToken: number
): Record<string, boolean> {
  const [running, setRunning] = useState<Record<string, boolean>>({});
  // Issue #4345 1c: drawn in a worktree page's agents pane, the page's registration holder; on the
  // settings screen none (no page owns the request: nothing is reported).
  const handoffOwner = useHandoffPageOwner();

  useEffect(() => {
    // No worktree, or no roster: nothing to ask about, and the More screen must
    // not pay for a worktree read it has no id for.
    if (!worktreeId || !instances || instances.length === 0) {
      setRunning({});
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchForHandoffPage(handoffOwner, `/api/worktrees/${worktreeId}`);
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (cancelled) return;
        const statuses = (body as {
          sessionStatusByInstance?: Record<string, { isRunning?: boolean }>;
        }).sessionStatusByInstance;
        const next: Record<string, boolean> = {};
        for (const [instanceId, status] of Object.entries(statuses ?? {})) {
          if (status?.isRunning) next[instanceId] = true;
        }
        setRunning(next);
      } catch {
        // A read that failed leaves the last answer standing. The warning is an
        // annotation; a transient 500 must not read as "nothing is running".
      }
    })();
    return () => {
      cancelled = true;
    };
    // A single read, re-run when an update finishes (refreshToken) rather than
    // on an interval: this card is not a session monitor.
  }, [worktreeId, instances, refreshToken, handoffOwner]);

  return running;
}

/** Display name for a probe row, falling back to the raw id for unknown tools. */
function toolLabel(tool: string): string {
  return getCliToolDisplayName(tool as CLIToolType) || tool;
}

export function AgentUpdatesCard({ worktreeId, instances, variant = 'card' }: AgentUpdatesCardProps) {
  const t = useTranslations('common');
  const { versions, isLoading, loadError, run, isUpdating, update } = useAgentUpdates(true);
  // Issue #4345 1c: see useRunningInstances (the kill below is the page's in its agents pane only).
  const handoffOwner = useHandoffPageOwner();

  const [refreshToken, setRefreshToken] = useState(0);
  const running = useRunningInstances(worktreeId, instances, refreshToken);
  const [restarted, setRestarted] = useState<Record<string, boolean>>({});
  const [restarting, setRestarting] = useState<Record<string, boolean>>({});
  const [restartError, setRestartError] = useState<string | null>(null);
  // Issue #4160: the instance past the deadline with its session still there. Not a
  // failure, and it stops being true as soon as a read shows the session gone.
  const [inProgressId, setInProgressId] = useState<string | null>(null);
  useEffect(() => {
    setInProgressId((id) => (id !== null && !running[id] ? null : id));
  }, [running]);

  // Keep the newest output in view without yanking the whole page around: only
  // the log box scrolls.
  const logRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run?.output]);

  const finishedOk = run?.ok === true;
  useEffect(() => {
    if (!finishedOk) return;
    setRefreshToken((token) => token + 1);
    // Issue #4160: an "ended" from before this update is not about the new version.
    setRestarted({});
  }, [finishedOk]);

  // Issue #4160: instance ids repeat across worktrees, and the pane keeps this card
  // across a switch: what A's restart said is not about B's row.
  const worktreeIdRef = useRef(worktreeId);
  worktreeIdRef.current = worktreeId;
  useEffect(() => {
    setRestarted({});
    setRestarting({});
    setRestartError(null);
    setInProgressId(null);
  }, [worktreeId]);

  const runningFor = useCallback(
    (tool: string): AgentUpdateInstance[] =>
      (instances ?? []).filter((inst) => inst.cliTool === tool && running[inst.id]),
    [instances, running]
  );

  const restart = useCallback(
    async (instance: AgentUpdateInstance): Promise<void> => {
      if (!worktreeId) return;
      setRestartError(null);
      setInProgressId(null);
      setRestarting((prev) => ({ ...prev, [instance.id]: true }));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), KILL_SESSION_TIMEOUT_MS);
      // Issue #4145: only a refusal says it did not happen. A 5xx, no answer or the
      // deadline say nothing, so what is running now decides.
      let outcome: 'ended' | 'refused' | 'errored' | 'silent' = 'ended';
      try {
        const query = new URLSearchParams({ cliTool: instance.cliTool, instance: instance.id });
        const response = await fetchForHandoffPage(
          handoffOwner,
          `/api/worktrees/${worktreeId}/kill-session?${query.toString()}`,
          { method: 'POST', signal: controller.signal }
        );
        // 404 means the session already ended, which is the goal — treat it as
        // success rather than making the user press again.
        if (!response.ok && response.status !== 404) {
          outcome = response.status < 500 ? 'refused' : 'errored';
        }
      } catch {
        outcome = 'silent';
      } finally {
        clearTimeout(timer);
      }
      if (worktreeIdRef.current !== worktreeId) return;
      if (outcome === 'errored' || outcome === 'silent') {
        const runningNow = await readRunningInstances(worktreeId);
        if (worktreeIdRef.current !== worktreeId) return;
        if (runningNow === null) {
          setRestartError(t('agentUpdates.restartUnknown'));
        } else if (runningNow[instance.id] === true) {
          // Issue #4160: a 5xx means the server has finished and the session is still
          // there. With no answer it may still be working on it (a graceful exit takes
          // seconds), so that is not called a failure.
          if (outcome === 'errored') setRestartError(t('agentUpdates.restartError'));
          else setInProgressId(instance.id);
        } else {
          outcome = 'ended';
        }
        setRefreshToken((token) => token + 1);
      } else if (outcome === 'refused') {
        setRestartError(t('agentUpdates.restartError'));
      }
      if (outcome === 'ended') {
        setRestarted((prev) => ({ ...prev, [instance.id]: true }));
        setRefreshToken((token) => token + 1);
      }
      setRestarting((prev) => ({ ...prev, [instance.id]: false }));
    },
    [worktreeId, t, handoffOwner]
  );

  const body = (() => {
    if (isLoading && !versions) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size="sm" />
          {t('loadingPage')}
        </div>
      );
    }

    if (loadError && !versions) {
      return (
        <div className="text-sm text-danger-foreground" data-testid="agent-updates-load-error">
          {t('agentUpdates.loadError')}
        </div>
      );
    }

    const rows = versions ?? [];

    return (
      <div className="space-y-3" data-testid="agent-updates">
        <div>
          <div className="text-sm font-medium text-foreground">{t('agentUpdates.title')}</div>
          <p className="mt-1 text-xs text-muted-foreground">{t('agentUpdates.description')}</p>
        </div>

        <ul className="space-y-2" data-testid="agent-updates-rows">
          {rows.map((row: AgentVersionView) => {
            const liveInstances = runningFor(row.tool);
            const restartRows = (instances ?? []).filter(
              (inst) => inst.cliTool === row.tool && (running[inst.id] || restarted[inst.id])
            );
            const canUpdate = row.updatable && row.installed !== null;
            return (
              <li
                key={row.tool}
                className="rounded-md border border-border bg-surface px-3 py-2"
                data-testid={`agent-updates-row-${row.tool}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-foreground">{toolLabel(row.tool)}</span>
                  <span
                    className="text-xs text-muted-foreground"
                    data-testid={`agent-updates-installed-${row.tool}`}
                  >
                    {row.installed
                      ? t('agentUpdates.installed', { version: row.installed })
                      : t('agentUpdates.notInstalled')}
                  </span>
                  {row.updateAvailable && (
                    <span
                      className="rounded bg-info-subtle px-1.5 py-0.5 text-xs text-info-foreground"
                      data-testid={`agent-updates-available-${row.tool}`}
                    >
                      {t('agentUpdates.available', { version: row.latestVersion ?? '' })}
                    </span>
                  )}
                  {/* Says the version is dismissed, never WHO dismissed it:
                      on the default #2068 policy CommandMate answers codex's
                      own update dialog with the digit that writes
                      `dismissed_version`, so on a stock install this is the
                      server's automatic answer rather than the user's. */}
                  {row.dismissedInCodex && (
                    <span
                      className="text-xs text-muted-foreground"
                      data-testid={`agent-updates-dismissed-${row.tool}`}
                    >
                      {t('agentUpdates.dismissed')}
                    </span>
                  )}
                  {canUpdate && (
                    <Button
                      size="sm"
                      className="ml-auto"
                      disabled={isUpdating}
                      onClick={() => void update(row.tool)}
                      data-testid={`agent-updates-update-${row.tool}`}
                    >
                      <ArrowUpCircle className="h-4 w-4" aria-hidden="true" />
                      {isUpdating && run?.tool === row.tool
                        ? t('agentUpdates.updating')
                        : t('agentUpdates.update')}
                    </Button>
                  )}
                </div>

                {canUpdate && liveInstances.length > 0 && (
                  <div
                    className="mt-2 flex items-start gap-1 text-xs text-warning-foreground"
                    data-testid={`agent-updates-restart-warning-${row.tool}`}
                  >
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                    <span>
                      {t('agentUpdates.restartWarning', {
                        sessions: liveInstances.map((inst) => inst.alias).join(', '),
                      })}
                    </span>
                  </div>
                )}

                {/* The generic form of the warning above, for the surface that
                    has no worktree to name (More). Carries a testid so its
                    ABSENCE on the pane — where the named warning is the right
                    one — is assertable; without it the guard could be deleted
                    and no test could see the extra paragraph appear. */}
                {canUpdate && liveInstances.length === 0 && worktreeId === undefined && (
                  <p
                    className="mt-2 text-xs text-muted-foreground"
                    data-testid={`agent-updates-restart-notice-${row.tool}`}
                  >
                    {t('agentUpdates.restartNotice')}
                  </p>
                )}

                {/* Issue #4160: the read after a restart takes the instance off the
                    running list, and the result has to outlive that. The button does
                    not: there is nothing left for it to end. */}
                {finishedOk &&
                  run?.tool === row.tool &&
                  restartRows.map((inst) => (
                    <div key={inst.id} className="mt-2 flex items-center gap-2">
                      {running[inst.id] && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={restarted[inst.id] || restarting[inst.id]}
                          onClick={() => void restart(inst)}
                          data-testid={`agent-updates-restart-${inst.id}`}
                        >
                          <RotateCcw className="h-4 w-4" aria-hidden="true" />
                          {t('agentUpdates.restart', { alias: inst.alias })}
                        </Button>
                      )}
                      {/* Issue #4160: once the button goes, this is all that says which
                          instance of the tool ended. */}
                      {restarted[inst.id] && (
                        <span
                          className="text-xs text-muted-foreground"
                          data-testid={`agent-updates-restarted-${inst.id}`}
                        >
                          <span className="font-medium text-foreground">{inst.alias}</span>{' '}
                          <span>{t('agentUpdates.restarted')}</span>
                        </span>
                      )}
                    </div>
                  ))}
              </li>
            );
          })}
        </ul>

        {run && (
          <div className="space-y-2" data-testid="agent-updates-run">
            {run.command && (
              <div className="text-xs text-muted-foreground" data-testid="agent-updates-command">
                {t('agentUpdates.running', { command: run.command })}
              </div>
            )}
            {run.output && (
              /* Always-dark island: this is verbatim terminal output, and it
                 stays readable as such in both themes. */
              <pre
                ref={logRef}
                data-testid="agent-updates-output"
                className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-terminal-surface p-2 text-xs text-terminal-foreground"
              >
                {run.output}
              </pre>
            )}
            {run.ok === true && (
              <div className="text-xs text-success-foreground" data-testid="agent-updates-success">
                {t('agentUpdates.succeeded', {
                  from: run.previousVersion ?? '?',
                  to: run.installed ?? '?',
                })}
              </div>
            )}
            {run.ok === false && (
              <div className="text-xs text-danger-foreground" data-testid="agent-updates-failure">
                {t('agentUpdates.failed', { error: run.error ?? '' })}
              </div>
            )}
          </div>
        )}

        {inProgressId !== null && (
          <div className="text-xs text-warning-foreground" role="status" data-testid="agent-updates-restart-progress">
            {t('agentUpdates.restartInProgress')}
          </div>
        )}

        {restartError && (
          <div className="text-xs text-danger-foreground" data-testid="agent-updates-restart-error">
            {restartError}
          </div>
        )}
      </div>
    );
  })();

  return variant === 'plain' ? body : <Card>{body}</Card>;
}
