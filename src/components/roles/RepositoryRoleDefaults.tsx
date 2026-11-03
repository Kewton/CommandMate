/**
 * A repository's role per tool (Issue #4117): the system's, none, or a role. Stored
 * per registered root, and it stays while the root is excluded from scans.
 */

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { getCliToolDisplayName } from '@/lib/cli-tools/types';
import { roleApi } from '@/lib/api-client-agent-roles';
import { refreshAllShownInstanceRoleSettings } from '@/hooks/useInstanceRoleSettings';
import type { AgentRoleSummary, RepositoryRoleDefaultEntry } from '@/types/agent-roles';
import { RoleChoiceSelect } from './RoleChoiceSelect';
import { roleChoiceOf, roleInputOf, roleSourceText, roleToolNoteKeys, storedRoleOption } from './role-display';

export function RepositoryRoleDefaults({ repositoryId }: { repositoryId: string }): React.ReactElement {
  const t = useTranslations('common');
  const [defaults, setDefaults] = useState<RepositoryRoleDefaultEntry[] | null>(null);
  const [roles, setRoles] = useState<AgentRoleSummary[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [savingTool, setSavingTool] = useState<string | null>(null);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void roleApi.repositoryDefaults(repositoryId).then((result) => {
      if (cancelled) return;
      if (result.ok) setDefaults(result.data.defaults);
      else setLoadFailed(true);
    });
    void roleApi.list().then((result) => {
      if (!cancelled && result.ok) setRoles(result.data.roles);
    });
    return () => {
      cancelled = true;
    };
  }, [repositoryId]);

  const handleChange = useCallback(
    async (cliToolId: string, choice: string) => {
      setSavingTool(cliToolId);
      setSaveError(false);
      const result = await roleApi.setRepositoryDefault(repositoryId, cliToolId, roleInputOf(choice));
      if (result.ok) {
        setDefaults(result.data.defaults);
        refreshAllShownInstanceRoleSettings();
      } else {
        setSaveError(true);
      }
      setSavingTool(null);
    },
    [repositoryId],
  );

  if (loadFailed) {
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
          {t('agentRoles.repository.saveError')}
        </p>
      )}
    </div>
  );
}
