/**
 * Roles in the settings (Issue #4117): create, edit and delete them, and pick the
 * system default per tool. Part of "General", so the PC dialog and `/more` show the
 * same card.
 *
 * A delete is asked for once here and refused by the server when the role is in use;
 * the references shown come from that 409, and removing them takes a second decision.
 */

'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui';
import { getCliToolDisplayName } from '@/lib/cli-tools/types';
import { roleApi, roleInUseReferences, type RoleApiFailure } from '@/lib/api-client-agent-roles';
import { refreshAllShownInstanceRoleSettings } from '@/hooks/useInstanceRoleSettings';
import {
  MAX_ROLE_BODY_BYTES,
  MAX_ROLE_NAME_LENGTH,
  type AgentRoleReferences,
  type AgentRoleSummary,
  type SystemRoleDefaultEntry,
} from '@/types/agent-roles';

const BUTTON_CLASS =
  'min-h-9 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed';
const PRIMARY_BUTTON_CLASS =
  'min-h-9 rounded-md border border-accent-200 dark:border-accent-700 bg-accent-50 dark:bg-accent-900/30 px-3 py-1.5 text-sm font-medium text-accent-700 dark:text-accent-300 hover:bg-accent-100 dark:hover:bg-accent-900/50 disabled:opacity-40 disabled:cursor-not-allowed';
const DANGER_BUTTON_CLASS =
  'min-h-9 rounded-md border border-danger-border bg-danger-subtle px-3 py-1.5 text-sm text-danger-foreground disabled:opacity-40 disabled:cursor-not-allowed';
const FIELD_CLASS =
  'w-full text-sm border border-input rounded-md px-2 py-2 bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50';

function bodyBytes(body: string): number {
  return new TextEncoder().encode(body).length;
}

/** Name and body, for a new role or an existing one. */
function RoleForm({
  initialName,
  initialBody,
  saving,
  error,
  testIdPrefix,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialName: string;
  initialBody: string;
  saving: boolean;
  error: string | null;
  testIdPrefix: string;
  submitLabel: string;
  onSubmit: (name: string, body: string) => void;
  onCancel?: () => void;
}): React.ReactElement {
  const t = useTranslations('common');
  const [name, setName] = useState(initialName);
  const [body, setBody] = useState(initialBody);
  const bytes = useMemo(() => bodyBytes(body), [body]);
  const overLimit = bytes > MAX_ROLE_BODY_BYTES;
  return (
    <form
      className="space-y-2"
      data-testid={`${testIdPrefix}-form`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!overLimit) onSubmit(name, body);
      }}
    >
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">{t('agentRoles.manage.name')}</span>
        <input
          type="text"
          data-testid={`${testIdPrefix}-name`}
          value={name}
          maxLength={MAX_ROLE_NAME_LENGTH}
          disabled={saving}
          required
          onChange={(e) => setName(e.target.value)}
          className={FIELD_CLASS}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">{t('agentRoles.manage.body')}</span>
        <textarea
          data-testid={`${testIdPrefix}-body`}
          value={body}
          rows={8}
          disabled={saving}
          required
          placeholder={t('agentRoles.manage.bodyPlaceholder')}
          onChange={(e) => setBody(e.target.value)}
          className={`${FIELD_CLASS} resize-y`}
        />
      </label>
      <p
        data-testid={`${testIdPrefix}-bytes`}
        className={`text-xs ${overLimit ? 'text-danger-foreground' : 'text-muted-foreground'}`}
      >
        {t('agentRoles.manage.bytes', { bytes, max: MAX_ROLE_BODY_BYTES })}
      </p>
      {error && (
        <p role="alert" data-testid={`${testIdPrefix}-error`} className="text-xs text-danger-foreground">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          data-testid={`${testIdPrefix}-submit`}
          disabled={saving || overLimit}
          className={PRIMARY_BUTTON_CLASS}
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" disabled={saving} onClick={onCancel} className={BUTTON_CLASS}>
            {t('agentRoles.manage.cancel')}
          </button>
        )}
      </div>
    </form>
  );
}

/** Everything a role is set on, as the 409 listed it. */
function RoleReferencesList({ references }: { references: AgentRoleReferences }): React.ReactElement {
  const t = useTranslations('common');
  return (
    <ul className="list-disc space-y-0.5 pl-4 text-xs text-foreground" data-testid="agent-role-references">
      {references.instances.map((ref) => (
        <li key={`i-${ref.worktreeId}-${ref.instanceId}`} className="break-all">
          {t('agentRoles.manage.referenceInstance', { worktree: ref.worktreeId, instance: ref.instanceId })}
        </li>
      ))}
      {references.repositories.map((ref) => (
        <li key={`r-${ref.repositoryId}-${ref.cliToolId}`} className="break-all">
          {t('agentRoles.manage.referenceRepository', {
            path: ref.repositoryPath,
            tool: getCliToolDisplayName(ref.cliToolId as never) || ref.cliToolId,
          })}
        </li>
      ))}
      {references.system.map((ref) => (
        <li key={`s-${ref.cliToolId}`}>
          {t('agentRoles.manage.referenceSystem', {
            tool: getCliToolDisplayName(ref.cliToolId as never) || ref.cliToolId,
          })}
        </li>
      ))}
    </ul>
  );
}

type DeleteState =
  | { step: 'asking' }
  | { step: 'in-use'; references: AgentRoleReferences }
  | { step: 'failed' };

export function AgentRolesSettings(): React.ReactElement {
  const t = useTranslations('common');
  const [roles, setRoles] = useState<AgentRoleSummary[] | null>(null);
  const [defaults, setDefaults] = useState<SystemRoleDefaultEntry[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createKey, setCreateKey] = useState(0);
  const [editing, setEditing] = useState<{ id: string; name: string; body: string; version: number } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Record<string, DeleteState>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [defaultError, setDefaultError] = useState(false);

  const reload = useCallback(async () => {
    const [list, system] = await Promise.all([roleApi.list(), roleApi.systemDefaults()]);
    if (list.ok) setRoles(list.data.roles);
    if (system.ok) setDefaults(system.data.defaults);
    setLoadFailed(!list.ok);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** The list, the defaults and every session on screen follow a change to a role. */
  const afterChange = useCallback(async () => {
    await reload();
    refreshAllShownInstanceRoleSettings();
  }, [reload]);

  const failureText = useCallback(
    (failure: RoleApiFailure): string => {
      if (failure.error === 'name_conflict') return t('agentRoles.manage.nameConflict');
      if (failure.error === 'version_conflict') return t('agentRoles.manage.versionConflict');
      if (failure.error === 'invalid_request' && failure.message) return failure.message;
      return t('agentRoles.manage.saveError');
    },
    [t],
  );

  const handleCreate = useCallback(
    async (name: string, body: string) => {
      setBusy(true);
      setCreateError(null);
      setNotice(null);
      const result = await roleApi.create({ name, body });
      if (result.ok) {
        setCreating(false);
        setCreateKey((key) => key + 1);
        await afterChange();
      } else {
        setCreateError(failureText(result));
      }
      setBusy(false);
    },
    [afterChange, failureText],
  );

  const handleStartEdit = useCallback(
    async (id: string) => {
      setBusy(true);
      setEditError(null);
      setNotice(null);
      const result = await roleApi.get(id);
      if (result.ok) {
        const { role } = result.data;
        setEditing({ id, name: role.name, body: role.body, version: role.bodyVersion });
      } else {
        setNotice(t('agentRoles.loadError'));
      }
      setBusy(false);
    },
    [t],
  );

  const handleSaveEdit = useCallback(
    async (name: string, body: string) => {
      if (!editing) return;
      setBusy(true);
      setEditError(null);
      const result = await roleApi.update(editing.id, { name, body, expectedBodyVersion: editing.version });
      if (result.ok) {
        setEditing(null);
        const { affected } = result.data;
        setNotice(
          t('agentRoles.manage.edited', {
            count: affected.instances.length + affected.repositories.length + affected.system.length,
          }),
        );
        await afterChange();
      } else {
        setEditError(failureText(result));
      }
      setBusy(false);
    },
    [afterChange, editing, failureText, t],
  );

  const handleDelete = useCallback(
    async (id: string, force: boolean) => {
      setBusy(true);
      setNotice(null);
      const result = await roleApi.remove(id, { force });
      if (result.ok) {
        setDeleting((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setNotice(t('agentRoles.manage.deleted', { name: result.data.deleted.name }));
        await afterChange();
      } else {
        const references = roleInUseReferences(result);
        setDeleting((prev) => ({
          ...prev,
          [id]: references ? { step: 'in-use', references } : { step: 'failed' },
        }));
      }
      setBusy(false);
    },
    [afterChange, t],
  );

  const handleSetDefault = useCallback(
    async (cliToolId: string, roleId: string) => {
      setBusy(true);
      setDefaultError(false);
      const result = await roleApi.setSystemDefault(cliToolId, roleId === '' ? null : roleId);
      if (result.ok) {
        setDefaults(result.data.defaults);
        refreshAllShownInstanceRoleSettings();
      } else {
        setDefaultError(true);
      }
      setBusy(false);
    },
    [],
  );

  return (
    <Card>
      <div className="space-y-4" data-testid="agent-roles-settings">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">{t('agentRoles.title')}</h3>
          <p className="text-xs text-muted-foreground">{t('agentRoles.description')}</p>
          <p className="text-xs text-muted-foreground" data-testid="agent-roles-persona-note">
            {t('agentRoles.personaNote')}
          </p>
        </div>

        {loadFailed && (
          <p role="alert" data-testid="agent-roles-load-error" className="text-xs text-danger-foreground">
            {t('agentRoles.loadError')}
          </p>
        )}
        {notice && (
          <p role="status" data-testid="agent-roles-notice" className="text-xs text-muted-foreground">
            {notice}
          </p>
        )}

        {roles !== null && roles.length === 0 && (
          <p data-testid="agent-roles-empty" className="text-xs text-muted-foreground">
            {t('agentRoles.manage.empty')}
          </p>
        )}
        <ul className="space-y-2">
          {(roles ?? []).map((role) => {
            const deleteState = deleting[role.id];
            return (
              <li key={role.id} data-testid={`agent-role-row-${role.id}`} className="rounded-lg border border-border p-2 space-y-2">
                {editing?.id === role.id ? (
                  <RoleForm
                    initialName={editing.name}
                    initialBody={editing.body}
                    saving={busy}
                    error={editError}
                    testIdPrefix="agent-role-edit"
                    submitLabel={t('agentRoles.manage.save')}
                    onSubmit={(name, body) => void handleSaveEdit(name, body)}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={role.name}>
                      {role.name}
                    </span>
                    <button
                      type="button"
                      data-testid={`agent-role-edit-${role.id}`}
                      disabled={busy}
                      onClick={() => void handleStartEdit(role.id)}
                      className={BUTTON_CLASS}
                    >
                      {t('agentRoles.manage.edit')}
                    </button>
                    <button
                      type="button"
                      data-testid={`agent-role-delete-${role.id}`}
                      disabled={busy}
                      onClick={() => setDeleting((prev) => ({ ...prev, [role.id]: { step: 'asking' } }))}
                      className={BUTTON_CLASS}
                    >
                      {t('agentRoles.manage.delete')}
                    </button>
                  </div>
                )}
                {deleteState && (
                  <div className="space-y-2" data-testid={`agent-role-delete-panel-${role.id}`}>
                    {deleteState.step === 'asking' && (
                      <p className="text-xs text-foreground">{t('agentRoles.manage.deleteAsk', { name: role.name })}</p>
                    )}
                    {deleteState.step === 'in-use' && (
                      <>
                        <p className="text-xs text-warning">{t('agentRoles.manage.inUse')}</p>
                        <RoleReferencesList references={deleteState.references} />
                      </>
                    )}
                    {deleteState.step === 'failed' && (
                      <p role="alert" className="text-xs text-danger-foreground">
                        {t('agentRoles.manage.deleteError')}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {deleteState.step === 'in-use' ? (
                        <button
                          type="button"
                          data-testid={`agent-role-force-delete-${role.id}`}
                          disabled={busy}
                          onClick={() => void handleDelete(role.id, true)}
                          className={DANGER_BUTTON_CLASS}
                        >
                          {t('agentRoles.manage.forceDelete')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          data-testid={`agent-role-delete-confirm-${role.id}`}
                          disabled={busy}
                          onClick={() => void handleDelete(role.id, false)}
                          className={DANGER_BUTTON_CLASS}
                        >
                          {t('agentRoles.manage.delete')}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          setDeleting((prev) => {
                            const next = { ...prev };
                            delete next[role.id];
                            return next;
                          })
                        }
                        className={BUTTON_CLASS}
                      >
                        {t('agentRoles.manage.cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {creating ? (
          <RoleForm
            key={createKey}
            initialName=""
            initialBody=""
            saving={busy}
            error={createError}
            testIdPrefix="agent-role-create"
            submitLabel={t('agentRoles.manage.create')}
            onSubmit={(name, body) => void handleCreate(name, body)}
            onCancel={() => {
              setCreating(false);
              setCreateError(null);
            }}
          />
        ) : (
          <button
            type="button"
            data-testid="agent-role-new"
            disabled={busy}
            onClick={() => setCreating(true)}
            className={PRIMARY_BUTTON_CLASS}
          >
            {t('agentRoles.manage.new')}
          </button>
        )}

        {defaults.length > 0 && (
          <div className="space-y-2 border-t border-border pt-3">
            <h4 className="text-xs font-medium text-foreground">{t('agentRoles.system.title')}</h4>
            <p className="text-xs text-muted-foreground">{t('agentRoles.system.description')}</p>
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {defaults.map((entry) => (
                <li key={entry.cliToolId} className="min-w-0 space-y-1">
                  <label className="block space-y-1">
                    <span className="text-xs text-foreground">{getCliToolDisplayName(entry.cliToolId)}</span>
                    <select
                      data-testid={`agent-role-system-default-${entry.cliToolId}`}
                      value={entry.stored.state === 'role' ? entry.stored.roleId : ''}
                      disabled={busy}
                      onChange={(e) => void handleSetDefault(entry.cliToolId, e.target.value)}
                      className={FIELD_CLASS}
                    >
                      <option value="">{t('agentRoles.choice.unset')}</option>
                      {(roles ?? []).map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!entry.adapterEnabled && (
                    <p className="text-xs text-warning">{t('agentRoles.adapterDisabledNote')}</p>
                  )}
                </li>
              ))}
            </ul>
            {defaultError && (
              <p role="alert" data-testid="agent-roles-default-error" className="text-xs text-danger-foreground">
                {t('agentRoles.manage.saveError')}
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
