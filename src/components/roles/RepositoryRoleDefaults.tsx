/**
 * A repository's role per tool (Issue #4117): the system's, none, or a role. Stored
 * per registered root, and it stays while the root is excluded from scans.
 */

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { getCliToolDisplayName } from '@/lib/cli-tools/types';
import { isOutcomeUnknown, roleApi } from '@/lib/api-client-agent-roles';
import { refreshAllShownInstanceRoleSettings, useRoleCatalogChanged } from '@/hooks/useInstanceRoleSettings';
import type { AgentRoleSummary, RepositoryRoleDefaultEntry } from '@/types/agent-roles';
import { RoleChoiceSelect } from './RoleChoiceSelect';
import { roleChoiceOf, roleInputOf, roleSourceText, roleToolNoteKeys, storedRoleOption } from './role-display';

export function RepositoryRoleDefaults({ repositoryId }: { repositoryId: string }): React.ReactElement {
  const t = useTranslations('common');
  const [defaults, setDefaults] = useState<RepositoryRoleDefaultEntry[] | null>(null);
  const [roles, setRoles] = useState<AgentRoleSummary[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [savingTool, setSavingTool] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<'failed' | 'unknown' | null>(null);
  const [savedStale, setSavedStale] = useState(false);

  // Moves on every read and write: an answer that finds it moved may be older than what
  // is shown. A read is then dropped for the later one, and a write reads again.
  const requestRef = useRef(0);

  /** @returns false when this read was answered and failed. A read that was overtaken says nothing. */
  const load = useCallback(async (): Promise<boolean> => {
    requestRef.current += 1;
    const request = requestRef.current;
    const [result, list] = await Promise.all([roleApi.repositoryDefaults(repositoryId), roleApi.list()]);
    if (request !== requestRef.current) return true;
    if (result.ok) {
      setDefaults(result.data.defaults);
      setSavedStale(false);
    }
    setLoadFailed(!result.ok || !list.ok);
    if (list.ok) setRoles(list.data.roles);
    return result.ok;
  }, [repositoryId]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  // A role deleted or renamed, or a system default changed, reads differently here.
  const onCatalogChanged = useCallback(() => void load(), [load]);
  useRoleCatalogChanged(onCatalogChanged);

  const handleChange = useCallback(
    async (cliToolId: string, choice: string) => {
      setSavingTool(cliToolId);
      setSaveError(null);
      requestRef.current += 1;
      const request = requestRef.current;
      const result = await roleApi.setRepositoryDefault(repositoryId, cliToolId, roleInputOf(choice));
      if (result.ok) {
        if (request === requestRef.current) {
          setDefaults(result.data.defaults);
          setSavedStale(false);
        } else if (!(await load())) setSavedStale(true);
        refreshAllShownInstanceRoleSettings();
      } else if (isOutcomeUnknown(result)) {
        // It may have gone through: what is shown comes from reading, and others follow.
        setSaveError('unknown');
        if (!(await load())) setSavedStale(true);
        refreshAllShownInstanceRoleSettings();
      } else {
        setSaveError('failed');
      }
      setSavingTool(null);
    },
    [load, repositoryId],
  );

  if (loadFailed && !defaults) {
    return (
      <p role="alert" data-testid={`repository-roles-error-${repositoryId}`} className="text-xs text-danger-foreground">
        {t('agentRoles.loadError')}
      </p>
    );
  }
  if (!defaults) return <p className="text-xs text-muted-foreground">{t('agentRoles.loading')}</p>;

  return (
    <div className="space-y-3" data-testid={`repository-roles-${repositoryId}`}>
      <p className="text-xs text-muted-foreground">{t('agentRoles.repository.description')}</p>
      {savedStale && (
        <p role="status" data-testid={`repository-roles-stale-${repositoryId}`} className="text-xs text-warning">
          {t('agentRoles.savedStale')}
        </p>
      )}
      {loadFailed && (
        <p role="alert" data-testid={`repository-roles-error-${repositoryId}`} className="text-xs text-danger-foreground">
          {t('agentRoles.loadError')}
        </p>
      )}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {defaults.map((entry) => (
          <li key={entry.cliToolId} className="min-w-0 space-y-1">
            <span className="block text-xs font-medium text-foreground">
              {getCliToolDisplayName(entry.cliToolId)}
            </span>
            <RoleChoiceSelect
              value={roleChoiceOf(entry.stored)}
              inheritLabel={t('agentRoles.choice.useSystem')}
              roles={roles}
              storedRole={storedRoleOption(entry.stored)}
              disabled={savingTool !== null}
              ariaLabel={t('agentRoles.repository.selectLabel', { tool: getCliToolDisplayName(entry.cliToolId) })}
              testId={`repository-role-select-${repositoryId}-${entry.cliToolId}`}
              onChange={(choice) => void handleChange(entry.cliToolId, choice)}
            />
            <p
              data-testid={`repository-role-source-${repositoryId}-${entry.cliToolId}`}
              className="text-xs text-muted-foreground break-words"
            >
              {roleSourceText(entry.effective, entry.stored.state === 'inherit', t)}
            </p>
            {!entry.adapterEnabled && <p className="text-xs text-warning">{t('agentRoles.adapterDisabledNote')}</p>}
            {roleToolNoteKeys(entry.cliToolId).map((key) => (
              <p key={key} className="text-xs text-muted-foreground">
                {t(key)}
              </p>
            ))}
          </li>
        ))}
      </ul>
      {saveError && (
        <p role="alert" data-testid={`repository-roles-save-error-${repositoryId}`} className="text-xs text-danger-foreground">
          {t(saveError === 'unknown' ? 'agentRoles.saveUnknown' : 'agentRoles.repository.saveError')}
        </p>
      )}
    </div>
  );
}
