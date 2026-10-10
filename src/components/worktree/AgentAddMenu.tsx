/**
 * AgentAddMenu Component (Issue #3514)
 *
 * The "+" at the right end of the desktop header's agent pills. It opens a
 * small form — which agent CLI (installed ones only), an optional name, and
 * where to open it (a new split / replace the current split / add only) — and
 * registers the new instance on the worktree's roster.
 *
 * ## What "add" does
 *
 * It PATCHes the roster (the same `PATCH /api/worktrees/[id]` +
 * `agentInstances` write `AgentInstancesPane` uses) and hands the new instance
 * and the chosen placement to the caller, which shows it in the chosen split.
 * It does NOT start a session: a split showing an instance with no session is
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
    return installed.filter(
      (id): id is CLIToolType => typeof id === 'string' && known.has(id),
    );
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
  const formId = useId();

  const [open, setOpen] = useState(false);
  // `undefined` = not read yet, `null` = could not be read (list everything).
  const [installed, setInstalled] = useState<CLIToolType[] | null | undefined>(undefined);
  const [toolId, setToolId] = useState<CLIToolType | ''>('');
  const [name, setName] = useState('');
  const [placement, setPlacement] = useState<AgentPlacement>(() =>
    resolveDefaultAgentPlacement(splitCount),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const atMax = instances.length >= MAX_AGENT_INSTANCES;

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
    void fetchInstalledAgentTools().then((list) => {
      if (!cancelled) setInstalled(list);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Keep the chosen tool selectable once the installed list arrives.
  useEffect(() => {
    if (installed === undefined) return;
    setToolId((prev) => (prev && isToolSelectable(prev) ? prev : firstSelectable));
  }, [installed, isToolSelectable, firstSelectable]);

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
    setOpen(true);
  }, [splitCount]);

  const handleClose = useCallback(() => {
    if (saving) return;
    setOpen(false);
  }, [saving]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!toolId || !isToolSelectable(toolId) || atMax || saving) return;
      if (!isAgentPlacementAvailable(placement, splitCount)) return;
      const id = nextInstanceId(toolId, instances);
      const alias = name.trim() || defaultAlias(toolId, id);
      const added: AgentInstance = { id, cliTool: toolId, alias, order: instances.length };
      const next = [...instances, added].map((inst, order) => ({ ...inst, order }));
      setSaving(true);
      setError(null);
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentInstances: next }),
        });
        if (!response.ok) {
          setError(t('agentAdd.saveError'));
          return;
        }
        onInstancesChange(next);
        onAdded?.(added, placement);
        setOpen(false);
      } catch {
        setError(t('agentAdd.saveError'));
      } finally {
        setSaving(false);
      }
    },
    [toolId, isToolSelectable, atMax, saving, placement, splitCount, instances, name, worktreeId, t, onInstancesChange, onAdded],
  );

  const buttonLabel = atMax
    ? t('agentAdd.maxReached', { max: MAX_AGENT_INSTANCES })
    : t('agentAdd.button');
  const noneInstalled = Array.isArray(installed) && installed.length === 0;
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
              onChange={(e) => setToolId(e.target.value as CLIToolType)}
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
          {noneInstalled && (
            <p data-testid="agent-add-none-installed" className="text-xs text-warning">
              {t('agentAdd.noInstalled')}
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
