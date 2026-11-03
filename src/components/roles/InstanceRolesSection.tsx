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

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { getCliToolDisplayName } from '@/lib/cli-tools/types';
import { roleApi } from '@/lib/api-client-agent-roles';
import { applyInstanceRoleSettings, useInstanceRoleSettings } from '@/hooks/useInstanceRoleSettings';
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

/** Which sessions are running. The same read `AgentUpdatesCard` makes for its restart. */
async function readRunningInstances(worktreeId: string): Promise<Record<string, boolean>> {
  try {
    const response = await fetch(`/api/worktrees/${worktreeId}`);
    if (!response.ok) return {};
    const body = (await response.json()) as {
      sessionStatusByInstance?: Record<string, { isRunning?: boolean }>;
    };
    const running: Record<string, boolean> = {};
    for (const [instanceId, status] of Object.entries(body.sessionStatusByInstance ?? {})) {
      if (status?.isRunning) running[instanceId] = true;
    }
    return running;
  } catch {
    return {};
  }
}

function InstanceRoleRow({
  worktreeId,
  entry,
  roles,
  isRunning,
  onChanged,
  t,
}: {
  worktreeId: string;
  entry: InstanceRoleEntry;
  roles: readonly AgentRoleSummary[];
  isRunning: boolean;
  onChanged: () => void;
  t: RoleTranslate;
}): React.ReactElement {
  const confirm = useConfirm();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = entry.instanceId;
  const next = entry.application.effectiveNext;

  const handleChange = useCallback(
    async (choice: string) => {
      setSaving(true);
      setError(null);
      const result = await roleApi.setInstanceRole(worktreeId, id, roleInputOf(choice));
      if (result.ok) applyInstanceRoleSettings(worktreeId, result.data);
      else setError(t('agentRoles.instances.saveError'));
      setSaving(false);
    },
    [worktreeId, id, t],
  );

  const handleRestart = useCallback(async () => {
    if (!(await confirm({ description: t('agentRoles.instances.restartConfirm', { alias: entry.alias }) }))) return;
    setError(null);
    try {
      // The query scopes it: without both, this route ends every session of the worktree.
      const query = new URLSearchParams({ cliTool: entry.cliToolId, instance: id });
      const response = await fetch(`/api/worktrees/${worktreeId}/kill-session?${query.toString()}`, {
        method: 'POST',
      });
      // 404: already ended, which is the goal.
      if (!response.ok && response.status !== 404) throw new Error(String(response.status));
      onChanged();
    } catch {
      setError(t('agentRoles.instances.restartError'));
    }
  }, [confirm, entry.alias, entry.cliToolId, id, onChanged, t, worktreeId]);

  const view = roleApplicationView(entry, isRunning, t);
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
                  onClick={() => void handleRestart()}
                  className="min-h-8 rounded px-2 text-accent-700 dark:text-accent-300 underline hover:bg-muted"
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
  const { settings, refresh } = useInstanceRoleSettings(worktreeId, rosterKey);
  const [roles, setRoles] = useState<AgentRoleSummary[]>([]);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [readToken, setReadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void roleApi.list().then((result) => {
      if (!cancelled && result.ok) setRoles(result.data.roles);
    });
    void readRunningInstances(worktreeId).then((next) => {
      if (!cancelled) setRunning(next);
    });
    return () => {
      cancelled = true;
    };
  }, [worktreeId, rosterKey, readToken]);

  const onChanged = useCallback(() => {
    setReadToken((token) => token + 1);
    void refresh();
  }, [refresh]);

  if (!settings) {
    return <p className="text-xs text-muted-foreground">{t('agentRoles.loading')}</p>;
  }
  return (
    <ul className="space-y-2" data-testid="instance-roles-list">
      {settings.instances.map((entry) => (
        <InstanceRoleRow
          key={entry.instanceId}
          worktreeId={worktreeId}
          entry={entry}
          roles={roles}
          isRunning={running[entry.instanceId] === true}
          onChanged={onChanged}
          t={t}
        />
      ))}
    </ul>
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
