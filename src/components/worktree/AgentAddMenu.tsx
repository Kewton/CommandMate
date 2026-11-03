/**
 * AgentAddMenu Component (Issue #3514)
 *
 * The "+" at the right end of the desktop header's session field — after the
 * current session and the "N more" list (#3593), whose "Add session…" opens
 * this same form. It opens a small form — which agent CLI (installed ones
 * only), an optional name, and where to open it (a new split / replace the
 * current split / add only) — and registers the new instance on the
 * worktree's roster.
 *
 * ## What "add" does
 *
 * It creates the instance and its role in one request (`POST .../instances/roles`,
 * Issue #4117), so a failure leaves neither, and hands the new instance and the
 * chosen placement to the caller, which shows it in the chosen split. When the
 * role settings could not be read there is no role to choose, and it falls back to
 * the roster `PATCH /api/worktrees/[id]` the pane uses, which adds the instance with
 * the default role: "could not check" must not lock the "+", as with the installed
 * list below. Either way the save carries a revision; the queue refuses it with none.
 *
 * What the default is comes from the same GET's `toolDefaults`; nothing is resolved
 * here. It does NOT start a session: a split showing an instance with no session is
 * the ordinary state of every freshly added roster row, and the session starts
 * on the existing path — the first message sent from that split's composer
 * (`POST /api/worktrees/[id]/send` starts the agent when it is not running).
 * Starting it here would be a second launch path with its own failure modes for
 * a session nobody has given anything to do yet.
 *
 * Rename / reorder / delete stay in `AgentInstancesPane`; this is only the
 * quick "add one and look at it" entry point.
 */

'use client';

import React, { memo, useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import {
  CLI_TOOL_IDS,
  getCliToolDisplayName,
  MAX_AGENT_ALIAS_LENGTH,
  MAX_AGENT_INSTANCES,
  type AgentInstance,
  type CLIToolType,
} from '@/lib/cli-tools/types';
import {
  AGENT_PLACEMENTS,
  MAX_SPLITS,
  isAgentPlacementAvailable,
  resolveDefaultAgentPlacement,
  type AgentPlacement,
} from '@/config/terminal-split-config';
import { DEFAULT_AGENTS_ENDPOINT } from '@/config/default-agents';
import { useAgentInstanceCreate, useAgentInstancesRoster, type RosterWriteResult } from '@/hooks/useAgentInstancesRoster';
import { refreshInstanceRoleSettings } from '@/hooks/useInstanceRoleSettings';
import { roleApi } from '@/lib/api-client-agent-roles';
import { RoleChoiceSelect } from '@/components/roles/RoleChoiceSelect';
import {
  ROLE_CHOICE_INHERIT,
  effectiveRoleName,
  roleInputOf,
  roleSourceText,
  roleToolNoteKeys,
} from '@/components/roles/role-display';
import type { AgentRoleSummary, InstanceRoleSettingsResponse } from '@/types/agent-roles';
import { Modal } from '@/components/ui/Modal';
import { Tooltip } from '@/components/common/Tooltip';

// ============================================================================
// Roster helpers (shared with AgentInstancesPane)
// ============================================================================

/**
 * Generate a unique, validator-safe instance id for a new instance of
 * `cliTool`. Claims the primary id (`=== cliTool`) when it is still free so the
 * backward-compatible session/poller keys stay anchored; otherwise allocates
 * the smallest free `{cliTool}-{n}` suffix (n >= 2).
 */
export function nextInstanceId(cliTool: CLIToolType, existing: AgentInstance[]): string {
  const ids = new Set(existing.map((inst) => inst.id));
  if (!ids.has(cliTool)) return cliTool;
  let n = 2;
  while (ids.has(`${cliTool}-${n}`)) n++;
  return `${cliTool}-${n}`;
}

/** Default alias for a freshly-added instance (tool name, suffixed when extra). */
export function defaultAlias(cliTool: CLIToolType, id: string): string {
  const name = getCliToolDisplayName(cliTool);
  if (id === cliTool) return name;
  const suffix = id.slice(cliTool.length + 1);
  return suffix ? `${name} ${suffix}` : name;
}

/**
 * Read which agent CLIs are installed.
 *
 * `?include=installed` on the default-agents route is the one place the server
 * answers that (a cached `which` fan-out). Returns `null` when it cannot be
 * told — an older server, a network error, an unexpected body — and the menu
 * then lists every tool rather than refusing all of them: "could not check" is
 * not "nothing is installed".
 *
 * An EMPTY list is treated the same as `null`. The server
 * (`src/config/installed-agents-cache.ts`) rounds a failed probe to `[]` and
 * still answers 200, so `[]` cannot be told apart from "the check failed" —
 * and refusing every tool on that answer would lock the "+" on a machine whose
 * agents are installed. A non-empty list is trusted as is.
 */
export async function fetchInstalledAgentTools(): Promise<CLIToolType[] | null> {
  try {
    const response = await fetch(`${DEFAULT_AGENTS_ENDPOINT}?include=installed`);
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') return null;
    const installed = (body as { installed?: unknown }).installed;
    if (!Array.isArray(installed)) return null;
    const known = new Set<string>(CLI_TOOL_IDS);
    const list = installed.filter(
      (id): id is CLIToolType => typeof id === 'string' && known.has(id),
    );
    // `[]` may be a failed probe (see above): unknown, not "none installed".
    return list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

// ============================================================================
// Component
// ============================================================================

const PLACEMENT_LABEL_KEYS: Record<AgentPlacement, string> = {
  'new-split': 'placementNewSplit',
  replace: 'placementReplace',
  'roster-only': 'placementRosterOnly',
};

export interface AgentAddMenuProps {
  /** Worktree whose roster is extended. */
  worktreeId: string;
  /** The current roster (ordered). */
  instances: AgentInstance[];
  /** How many terminal splits are open — decides whether `new-split` is possible. */
  splitCount: number;
  /** Called with the saved roster after a successful PATCH. */
  onInstancesChange: (instances: AgentInstance[]) => void;
  /**
   * Called after `onInstancesChange` with the new instance and where the user
   * asked to open it. `roster-only` is reported too, so a caller can tell the
   * two apart without diffing rosters.
   */
  onAdded?: (instance: AgentInstance, placement: AgentPlacement) => void;
}

export const AgentAddMenu = memo(function AgentAddMenu({
  worktreeId,
  instances,
  splitCount,
  onInstancesChange,
  onAdded,
}: AgentAddMenuProps) {
  const t = useTranslations('worktree');
  const tCommon = useTranslations('common');
  const formId = useId();

  const [open, setOpen] = useState(false);
  // `undefined` = not read yet, `null` = could not be read (list everything).
  const [installed, setInstalled] = useState<CLIToolType[] | null | undefined>(undefined);
  const [pickedToolId, setToolId] = useState<CLIToolType | ''>('');
  const [name, setName] = useState('');
  const [placement, setPlacement] = useState<AgentPlacement>(() =>
    resolveDefaultAgentPlacement(splitCount),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Null: not read yet, or could not be read.
  const [roleSettings, setRoleSettings] = useState<InstanceRoleSettingsResponse | null>(null);
  const [roles, setRoles] = useState<AgentRoleSummary[]>([]);
  const [roleChoice, setRoleChoice] = useState(ROLE_CHOICE_INHERIT);

  const atMax = instances.length >= MAX_AGENT_INSTANCES;
  // Issue #3514: the same per-worktree write queue AgentInstancesPane uses.
  const writeRoster = useAgentInstancesRoster(worktreeId, onInstancesChange);
  const createInstance = useAgentInstanceCreate(worktreeId, onInstancesChange);

  const isToolSelectable = useCallback(
    (id: CLIToolType) => installed == null || installed.includes(id),
    [installed],
  );
  const firstSelectable = useMemo(
    () => CLI_TOOL_IDS.find((id) => isToolSelectable(id)) ?? '',
    [isToolSelectable],
  );

  // Read the installed list each time the form opens: an agent installed while
  // the page was open must become choosable without a reload.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setInstalled(undefined);
    setRoleSettings(null);
    setRoles([]);
    // Together, because the submit button opens on `installed` and what it does
    // depends on whether the role settings were read.
    void Promise.all([
      fetchInstalledAgentTools(),
      refreshInstanceRoleSettings(worktreeId),
      roleApi.list(),
    ]).then(([list, settings, roleList]) => {
      if (cancelled) return;
      setRoleSettings(settings);
      if (roleList.ok) setRoles(roleList.data.roles);
      setInstalled(list);
    });
    return () => {
      cancelled = true;
    };
  }, [open, worktreeId]);

  // The tool the form submits: the user's pick while it is selectable, else the
  // first selectable one. Derived (not synced by an effect) so there is no
  // render where the list has arrived but no tool is chosen yet.
  const toolId: CLIToolType | '' =
    pickedToolId && isToolSelectable(pickedToolId) ? pickedToolId : firstSelectable;

  // The split count can change while the form is open (or between openings);
  // never leave an impossible placement selected.
  useEffect(() => {
    setPlacement((prev) =>
      isAgentPlacementAvailable(prev, splitCount) ? prev : resolveDefaultAgentPlacement(splitCount),
    );
  }, [splitCount]);

  const handleOpen = useCallback(() => {
    setName('');
    setError(null);
    setPlacement(resolveDefaultAgentPlacement(splitCount));
    setRoleChoice(ROLE_CHOICE_INHERIT);
    setOpen(true);
  }, [splitCount]);

  const handleClose = useCallback(() => {
    if (saving) return;
    setOpen(false);
  }, [saving]);

  // What a new instance of this tool would get, as the server says. Absent for a
  // tool outside the roles, and while the settings are unread.
  const toolDefault = roleSettings?.toolDefaults.find((entry) => entry.cliToolId === toolId) ?? null;

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!toolId || !isToolSelectable(toolId) || atMax || saving) return;
      if (!isAgentPlacementAvailable(placement, splitCount)) return;
      const tool = toolId;
      const chosenPlacement = placement;
      const trimmed = name.trim();
      // Built against the LATEST roster when the shared queue reaches it (Issue
      // #3514), so a pane write still in flight is kept and its ids are not
      // re-allocated here.
      let added: AgentInstance | null = null;
      const buildAdded = (base: AgentInstance[]): AgentInstance | null => {
        if (base.length >= MAX_AGENT_INSTANCES) return null;
        const id = nextInstanceId(tool, base);
        added = { id, cliTool: tool, alias: trimmed || defaultAlias(tool, id), order: base.length };
        return added;
      };
      setSaving(true);
      setError(null);
      try {
        let result: RosterWriteResult;
        if (roleSettings) {
          // A tool outside the roles can hold nothing but the default.
          const role = roleInputOf(toolDefault ? roleChoice : ROLE_CHOICE_INHERIT);
          result = await createInstance((base) => {
            const instance = buildAdded(base);
            return instance && { id: instance.id, cliTool: instance.cliTool, alias: instance.alias };
          }, role);
        } else {
          result = await writeRoster((base) => {
            const instance = buildAdded(base);
            return instance && [...base, instance];
          });
        }
        if (result.status !== 'saved' || added === null) {
          // The dialog stays open, with what was typed.
          const failure = result.status === 'failed' ? result.error : undefined;
          setError(
            t(
              failure === 'not_found'
                ? 'agentAdd.roleMissing'
                : failure === 'roster_changed'
                  ? 'agentAdd.rosterChanged'
                  : failure === 'roster_unreadable'
                    ? 'agentAdd.rosterUnreadable'
                    : 'agentAdd.saveError',
            ),
          );
          return;
        }
        const saved = result.roster.find((inst) => inst.id === (added as AgentInstance).id);
        onAdded?.(saved ?? added, chosenPlacement);
        setOpen(false);
      } finally {
        setSaving(false);
      }
    },
    [
      toolId,
      isToolSelectable,
      atMax,
      saving,
      placement,
      splitCount,
      name,
      writeRoster,
      createInstance,
      roleSettings,
      toolDefault,
      roleChoice,
      t,
      onAdded,
    ],
  );

  const buttonLabel = atMax
    ? t('agentAdd.maxReached', { max: MAX_AGENT_INSTANCES })
    : t('agentAdd.button');
  const canSubmit =
    !saving && !atMax && installed !== undefined && toolId !== '' && isToolSelectable(toolId);

  return (
    <>
      <Tooltip content={buttonLabel} placement="bottom">
        <button
          type="button"
          onClick={handleOpen}
          disabled={atMax}
          aria-disabled={atMax}
          aria-label={buttonLabel}
          aria-haspopup="dialog"
          data-testid="agent-add-button"
          className="flex flex-shrink-0 items-center justify-center w-6 h-6 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
        </button>
      </Tooltip>
      <Modal isOpen={open} onClose={handleClose} title={t('agentAdd.title')} size="sm">
        <form
          id={formId}
          onSubmit={handleSubmit}
          data-testid="agent-add-form"
          className="space-y-4 text-sm"
        >
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t('agentAdd.tool')}</span>
            <select
              data-testid="agent-add-tool"
              value={toolId}
              disabled={saving || installed === undefined}
              onChange={(e) => {
                setToolId(e.target.value as CLIToolType);
                setRoleChoice(ROLE_CHOICE_INHERIT);
              }}
              className="w-full text-sm border border-input rounded-md px-2 py-2 bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            >
              {CLI_TOOL_IDS.map((id) => {
                const selectable = isToolSelectable(id);
                const label = getCliToolDisplayName(id);
                return (
                  <option key={id} value={id} disabled={!selectable}>
                    {selectable ? label : t('agentAdd.notInstalled', { name: label })}
                  </option>
                );
              })}
            </select>
          </label>
          {installed === null && (
            <p data-testid="agent-add-installed-unknown" className="text-xs text-muted-foreground">
              {t('agentAdd.installedUnknown')}
            </p>
          )}

          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t('agentAdd.name')}</span>
            <input
              type="text"
              data-testid="agent-add-name"
              value={name}
              maxLength={MAX_AGENT_ALIAS_LENGTH}
              placeholder={t('agentAdd.namePlaceholder')}
              disabled={saving}
              onChange={(e) => setName(e.target.value)}
              className="w-full text-sm border border-input rounded-md px-2 py-2 bg-surface text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>

          <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t('agentAdd.role')}</span>
            <RoleChoiceSelect
              value={toolDefault ? roleChoice : ROLE_CHOICE_INHERIT}
              inheritLabel={
                toolDefault
                  ? tCommon('agentRoles.choice.inheritNamed', { label: effectiveRoleName(toolDefault.effective, tCommon) })
                  : tCommon('agentRoles.choice.inherit')
              }
              roles={toolDefault ? roles : []}
              disabled={saving || !toolDefault}
              ariaLabel={t('agentAdd.role')}
              testId="agent-add-role"
              onChange={setRoleChoice}
            />
            {toolDefault && roleChoice === ROLE_CHOICE_INHERIT && (
              <p data-testid="agent-add-role-source" className="text-xs text-muted-foreground break-words">
                {roleSourceText(toolDefault.effective, true, tCommon)}
              </p>
            )}
            {toolDefault && !toolDefault.adapterEnabled && (
              <p data-testid="agent-add-role-adapter-off" className="text-xs text-warning">
                {tCommon('agentRoles.adapterDisabledNote')}
              </p>
            )}
            {roleSettings && !toolDefault && (
              <p data-testid="agent-add-role-unsupported" className="text-xs text-muted-foreground">
                {t('agentAdd.roleUnsupported')}
              </p>
            )}
            {!roleSettings && installed !== undefined && (
              <p data-testid="agent-add-role-unavailable" className="text-xs text-muted-foreground">
                {t('agentAdd.roleUnavailable')}
              </p>
            )}
            {toolDefault &&
              roleToolNoteKeys(toolDefault.cliToolId).map((key) => (
                <p key={key} className="text-xs text-muted-foreground">
                  {tCommon(key)}
                </p>
              ))}
          </div>

          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-muted-foreground">
              {t('agentAdd.placement')}
            </legend>
            {AGENT_PLACEMENTS.map((value) => {
              const available = isAgentPlacementAvailable(value, splitCount);
              return (
                <label
                  key={value}
                  className={`flex items-center gap-2 py-0.5 ${available ? '' : 'opacity-50 cursor-not-allowed'}`}
                >
                  <input
                    type="radio"
                    name={`${formId}-placement`}
                    value={value}
                    data-testid={`agent-add-placement-${value}`}
                    checked={placement === value}
                    disabled={!available || saving}
                    onChange={() => setPlacement(value)}
                  />
                  <span>{t(`agentAdd.${PLACEMENT_LABEL_KEYS[value]}`)}</span>
                  {!available && (
                    <span className="text-xs text-muted-foreground">
                      {t('agentAdd.placementNewSplitFull', { max: MAX_SPLITS })}
                    </span>
                  )}
                </label>
              );
            })}
          </fieldset>

          <p className="text-xs text-muted-foreground">{t('agentAdd.startHint')}</p>
          {error && (
            <p role="alert" data-testid="agent-add-error" className="text-xs text-danger">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={handleClose}
              disabled={saving}
              className="px-3 py-1.5 text-sm rounded-md bg-muted hover:bg-muted/80 text-foreground disabled:opacity-50"
            >
              {t('agentAdd.cancel')}
            </button>
            <button
              type="submit"
              data-testid="agent-add-submit"
              disabled={!canSubmit}
              className="px-3 py-1.5 text-sm font-medium rounded-md border border-accent-200 dark:border-accent-700 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300 hover:bg-accent-100 dark:hover:bg-accent-900/50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('agentAdd.submit')}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
});

export default AgentAddMenu;
