/**
 * AgentInstancesPane Component (Issue #869)
 *
 * PC instance-management UI that replaces the CLI-tool checkbox list. Each row
 * is an {@link AgentInstance}: a base CLI tool plus a user-editable alias. Users
 * can add instances (including multiple of the same tool — e.g. "Claude" and
 * "Claude (review)"), rename them, reorder them (drag or move buttons), and
 * delete them. The roster is bounded to {@link MIN_AGENT_INSTANCES}..
 * {@link MAX_AGENT_INSTANCES} and persisted via PATCH /api/worktrees/[id]
 * (`agentInstances`), decoupled from `selectedAgents`.
 *
 * The instance list drives the terminal header tabs, split selectors, and the
 * header badge through their shared alias (see {@link getInstanceLabel}).
 */

'use client';

import React, { useState, useCallback, useEffect, memo } from 'react';
import { useTranslations } from 'next-intl';
import {
  GripVertical,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Trash2,
  Plus,
  MoreVertical,
  AlertTriangle,
  Radio,
} from 'lucide-react';
import {
  CLI_TOOL_IDS,
  getCliToolDisplayName,
  MAX_AGENT_INSTANCES,
  MAX_AGENT_ALIAS_LENGTH,
  type AgentInstance,
  type CLIToolType,
} from '@/lib/cli-tools/types';
import { MIN_AGENT_INSTANCES } from '@/lib/agent-instances-validator';
import { VibeLocalSettings } from '@/components/worktree/VibeLocalSettings';
// Issue #2069: the same card the More screen renders. Shared rather than
// re-implemented so the pane cannot grow its own idea of what an update does to
// a live session.
import { AgentUpdatesCard } from '@/components/settings';
import { Spinner } from '@/components/ui/Spinner';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { TruncationTooltip } from '@/components/common/TruncationTooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import {
  formatAgentSourceLabel,
  isAgentSourceDegraded,
} from '@/components/worktree/WorktreeDetailSubComponents';
import { AGENT_SOURCE_POLL_INTERVAL_MS } from '@/config/agent-source-config';
import type { AgentEventSourceView, Worktree } from '@/types/models';

// ============================================================================
// Types
// ============================================================================

/** Props for the AgentInstancesPane component */
export interface AgentInstancesPaneProps {
  /** Worktree ID for API calls */
  worktreeId: string;
  /** Current agent instances (ordered) */
  instances: AgentInstance[];
  /** Callback when instances change (after a successful PATCH) */
  onInstancesChange: (instances: AgentInstance[]) => void;
  /** Current vibe-local model selection (null = default) */
  vibeLocalModel: string | null;
  /** Callback when vibe-local model changes */
  onVibeLocalModelChange: (model: string | null) => void;
  /** Current vibe-local context window (null = default) */
  vibeLocalContextWindow?: number | null;
  /** Callback when vibe-local context window changes */
  onVibeLocalContextWindowChange?: (value: number | null) => void;
  /**
   * Issue #1783: instanceId -> the model that instance last reported running,
   * from `sessionStatusByInstance`. Read-only; this pane edits the roster, and
   * the model is an observation about a live session rather than a setting.
   *
   * Optional, and an instance with no entry renders no model line — which is the
   * steady state for gemini / copilot and for any tool whose hooks are not
   * configured. Not to be confused with {@link vibeLocalModel}, which is a
   * *chosen* setting for one tool and is edited below.
   */
  modelByInstance?: Readonly<Partial<Record<string, string | null>>>;
  /**
   * Issue #2054: instanceId -> what is reading that instance besides the frame.
   *
   * Supplying it turns the pane's own read off entirely, which is why it exists:
   * a parent that already polls `sessionStatusByInstance` (the detail shells do,
   * for the header chip) can hand the same object down instead of paying for a
   * second request, and a test can drive the row without a network at all. When
   * it is absent the pane reads for itself — **only if its roster contains an
   * opencode instance**; see {@link useAgentSourceByInstance}.
   */
  sourceByInstance?: Readonly<Partial<Record<string, AgentEventSourceView>>>;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a unique, validator-safe instance id for a new instance of
 * `cliTool`. Claims the primary id (`=== cliTool`) when it is still free so the
 * backward-compatible session/poller keys stay anchored; otherwise allocates
 * the smallest free `{cliTool}-{n}` suffix (n >= 2).
 */
function nextInstanceId(cliTool: CLIToolType, existing: AgentInstance[]): string {
  const ids = new Set(existing.map((inst) => inst.id));
  if (!ids.has(cliTool)) return cliTool;
  let n = 2;
  while (ids.has(`${cliTool}-${n}`)) n++;
  return `${cliTool}-${n}`;
}

/** Default alias for a freshly-added instance (tool name, suffixed when extra). */
function defaultAlias(cliTool: CLIToolType, id: string): string {
  const name = getCliToolDisplayName(cliTool);
  if (id === cliTool) return name;
  const suffix = id.slice(cliTool.length + 1);
  return suffix ? `${name} ${suffix}` : name;
}

/**
 * Which machinery is speaking for each roster row (Issue #2054).
 *
 * ## Why the pane reads this itself
 *
 * The warning row needs one field of `sessionStatusByInstance`, and the two
 * shells that render this pane reach it through different parents — PC direct,
 * mobile through `NotesAndLogsPane` — neither of which threads the status map
 * down today. Reading it here keeps the wiring to one place instead of four, and
 * costs nothing on the rosters that cannot use it: **the effect returns before
 * touching the network unless an opencode instance is on the roster**, because
 * opencode is the only tool whose source can be degraded (every push source
 * answers "unknown" by construction — see `describeAgentEventSource`). A
 * worktree of claude and codex panes issues zero requests, which is also what
 * keeps this Issue's "claude / codex は不変" criterion true of the request log
 * and not only of the pixels.
 *
 * `sourceByInstance` given by the caller wins outright and skips the read.
 *
 * @param worktreeId - The worktree whose status map to read
 * @param instances - The roster, used only to decide whether to read at all
 * @param provided - The caller's map, when it has one
 */
function useAgentSourceByInstance(
  worktreeId: string,
  instances: AgentInstance[],
  provided?: Readonly<Partial<Record<string, AgentEventSourceView>>>,
): Readonly<Partial<Record<string, AgentEventSourceView>>> {
  const [fetched, setFetched] = useState<Partial<Record<string, AgentEventSourceView>>>({});
  // A primitive, not the array: `instances` is a fresh array on every render of
  // every parent, and depending on it directly would restart the interval each
  // time. What the effect actually depends on is whether there is anything to
  // ask about.
  const hasSubscriptionSource = instances.some((inst) => inst.cliTool === 'opencode');

  useEffect(() => {
    if (provided) return;
    if (!hasSubscriptionSource) {
      setFetched({});
      return;
    }
    let cancelled = false;
    const read = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}`);
        if (!response.ok) return;
        const body: Worktree = await response.json();
        if (cancelled) return;
        const next: Partial<Record<string, AgentEventSourceView>> = {};
        for (const [instanceId, status] of Object.entries(body.sessionStatusByInstance ?? {})) {
          // Absent is the ordinary answer and stays absent: the row's
          // `{label && …}` guard is what renders nothing, and a null here would
          // make the map full of keys that mean the same as no key.
          if (status?.eventSource) next[instanceId] = status.eventSource;
        }
        setFetched(next);
      } catch {
        // A read that failed leaves the last answer on screen rather than
        // blanking it: the pane is a roster editor, and a transient 500 must not
        // look like a stream that just recovered.
      }
    };
    void read();
    const timer = setInterval(() => void read(), AGENT_SOURCE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [worktreeId, hasSubscriptionSource, provided]);

  return provided ?? fetched;
}

// ============================================================================
// Component
// ============================================================================

export const AgentInstancesPane = memo(function AgentInstancesPane({
  worktreeId,
  instances,
  onInstancesChange,
  vibeLocalModel,
  onVibeLocalModelChange,
  vibeLocalContextWindow,
  onVibeLocalContextWindowChange,
  modelByInstance,
  sourceByInstance,
}: AgentInstancesPaneProps) {
  const t = useTranslations('schedule');
  const tCommon = useTranslations('common');
  // Issue #1783: the model strings live in the `worktree` namespace beside the
  // other session-status wording, not in `schedule` with the roster editor's.
  const tWorktree = useTranslations('worktree');
  const confirm = useConfirm();

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-id alias edit drafts (decoupled from prop to allow free typing).
  const [aliasDrafts, setAliasDrafts] = useState<Record<string, string>>({});
  // Base tool for the "add instance" control.
  const [addToolId, setAddToolId] = useState<CLIToolType>(CLI_TOOL_IDS[0]);
  // Index of the row currently being dragged (HTML5 reorder).
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  // Issue #2069: whether the agent-CLI update section is open. Closed by
  // default so the pane keeps issuing no requests of its own (see the note at
  // the disclosure itself).
  const [showUpdates, setShowUpdates] = useState(false);

  // Issue #2054: read before the first row is built so every row resolves from
  // one snapshot rather than from a map that could change mid-render.
  const sourceStatusByInstance = useAgentSourceByInstance(
    worktreeId,
    instances,
    sourceByInstance,
  );

  const atMax = instances.length >= MAX_AGENT_INSTANCES;
  const atMin = instances.length <= MIN_AGENT_INSTANCES;
  const hasVibeLocal = instances.some((inst) => inst.cliTool === 'vibe-local');

  /** Normalize order to array index and PATCH the full roster. */
  const persist = useCallback(
    async (next: AgentInstance[]) => {
      const normalized = next.map((inst, order) => ({ ...inst, order }));
      setSaving(true);
      setError(null);
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentInstances: normalized }),
        });
        if (response.ok) {
          onInstancesChange(normalized);
        } else {
          setError(t('agentInstanceSaveError'));
        }
      } catch {
        setError(t('agentInstanceSaveError'));
      } finally {
        setSaving(false);
      }
    },
    [worktreeId, onInstancesChange, t]
  );

  const handleAdd = useCallback(() => {
    if (instances.length >= MAX_AGENT_INSTANCES) return;
    const id = nextInstanceId(addToolId, instances);
    const next: AgentInstance[] = [
      ...instances,
      { id, cliTool: addToolId, alias: defaultAlias(addToolId, id), order: instances.length },
    ];
    void persist(next);
  }, [addToolId, instances, persist]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (instances.length <= MIN_AGENT_INSTANCES) return;
      const target = instances.find((inst) => inst.id === id);
      if (
        !(await confirm({
          description: tCommon('confirmDelete', { name: target?.alias ?? '' }),
          variant: 'danger',
        }))
      ) {
        return;
      }
      void persist(instances.filter((inst) => inst.id !== id));
    },
    [instances, persist, confirm, tCommon]
  );

  const handleMove = useCallback(
    (index: number, direction: -1 | 1) => {
      const target = index + direction;
      if (target < 0 || target >= instances.length) return;
      const next = [...instances];
      [next[index], next[target]] = [next[target], next[index]];
      void persist(next);
    },
    [instances, persist]
  );

  /** Commit an alias edit (from blur / Enter). Clears the draft either way. */
  const commitAlias = useCallback(
    (id: string, value: string) => {
      setAliasDrafts((drafts) => {
        if (!(id in drafts)) return drafts;
        const next = { ...drafts };
        delete next[id];
        return next;
      });
      const inst = instances.find((item) => item.id === id);
      if (!inst || value === inst.alias) return;
      void persist(instances.map((item) => (item.id === id ? { ...item, alias: value } : item)));
    },
    [instances, persist]
  );

  const reorderTo = useCallback(
    (from: number, to: number) => {
      if (from === to || from < 0 || to < 0 || from >= instances.length || to >= instances.length) {
        return;
      }
      const next = [...instances];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      void persist(next);
    },
    [instances, persist]
  );

  return (
    <div className="p-4" data-testid="agent-instances-pane">
      <h3 className="text-sm font-semibold text-foreground mb-1">
        {t('agentInstances')}
      </h3>
      <p className="text-xs text-muted-foreground mb-4">
        {t('agentInstancesDescription')}
      </p>

      <div className="space-y-2">
        {instances.map((inst, index) => {
          const aliasValue = inst.id in aliasDrafts ? aliasDrafts[inst.id] : inst.alias;
          const isDragging = draggingIndex === index;
          // Issue #1783: observed model for this instance, or null.
          const instanceModel = modelByInstance?.[inst.id] ?? null;
          // Issue #2054: what is reading this instance besides the frame. Null
          // — render nothing — for every tool whose source cannot be degraded,
          // which is every tool but opencode today.
          const instanceSource = sourceStatusByInstance?.[inst.id];
          const sourceLabel = formatAgentSourceLabel(instanceSource, tWorktree);
          const sourceDegraded = isAgentSourceDegraded(instanceSource);
          return (
            <div
              key={inst.id}
              data-testid={`agent-instance-row-${inst.id}`}
              draggable
              onDragStart={() => setDraggingIndex(index)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (draggingIndex !== null) reorderTo(draggingIndex, index);
                setDraggingIndex(null);
              }}
              onDragEnd={() => setDraggingIndex(null)}
              className={`flex items-center gap-2 p-2 rounded-lg border border-border bg-surface transition-colors hover:border-accent-300 dark:hover:border-accent-700 focus-within:border-accent-500 ${
                isDragging ? 'opacity-50' : ''
              }`}
            >
              <span
                className="cursor-grab text-muted-foreground shrink-0"
                aria-hidden="true"
              >
                <GripVertical className="w-4 h-4" />
              </span>

              {/* Issue #1130: name is primary — the alias input takes the full row
                  width and the base-tool name gets a TruncationTooltip so it stays
                  readable in the narrow activity column. Reorder/delete moved to
                  the kebab menu so they no longer compete for horizontal space. */}
              <div className="flex-1 min-w-0">
                <input
                  type="text"
                  data-testid={`agent-instance-alias-${inst.id}`}
                  aria-label={t('agentInstanceAliasLabel')}
                  value={aliasValue}
                  maxLength={MAX_AGENT_ALIAS_LENGTH}
                  disabled={saving}
                  placeholder={t('agentInstanceAliasPlaceholder')}
                  onChange={(e) =>
                    setAliasDrafts((drafts) => ({ ...drafts, [inst.id]: e.target.value }))
                  }
                  onBlur={(e) => commitAlias(inst.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                  className="w-full text-sm font-medium border border-input rounded-md px-2 py-1 bg-surface dark:bg-surface-2 text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-accent-500 disabled:opacity-50"
                />
                <TruncationTooltip
                  content={getCliToolDisplayName(inst.cliTool)}
                  className="mt-0.5 block truncate text-xs text-muted-foreground"
                />
                {/* Issue #1783: read-only, and absent entirely when the agent
                    has not reported a model. A third line saying "unknown" on
                    every row of a roster whose tools mostly never report one
                    would be pure noise. */}
                {instanceModel && (
                  <span
                    data-testid={`agent-instance-model-${inst.id}`}
                    title={tWorktree('agentModel.modelLabel', { model: instanceModel })}
                    className="mt-0.5 block truncate text-xs text-muted-foreground"
                  >
                    {instanceModel}
                  </span>
                )}
                {/* Issue #2054: the warning row. Absent whenever the server had
                    nothing to say, on exactly #1783's terms — a line reading
                    "events fine" on every claude row would be noise, and the
                    tools that cannot answer the question at all must not grow a
                    line that implies they were asked. Styled as a warning only
                    while something IS degraded; a healthy opencode stream is
                    reported in the same muted grey the model line uses. */}
                {sourceLabel && (
                  <span
                    data-testid={`agent-instance-source-${inst.id}`}
                    title={tWorktree(
                      sourceDegraded ? 'agentSource.degradedTitle' : 'agentSource.healthyTitle'
                    )}
                    className={`mt-0.5 flex items-center gap-1 truncate text-xs ${
                      sourceDegraded ? 'text-warning' : 'text-muted-foreground'
                    }`}
                  >
                    {sourceDegraded ? (
                      <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                    ) : (
                      <Radio className="w-3 h-3 shrink-0" aria-hidden="true" />
                    )}
                    <span className="truncate">{sourceLabel}</span>
                  </span>
                )}
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    data-testid={`agent-instance-menu-${inst.id}`}
                    aria-label={t('agentInstanceActions')}
                    title={t('agentInstanceActions')}
                    disabled={saving}
                    className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    data-testid={`agent-instance-move-up-${inst.id}`}
                    disabled={index === 0}
                    onSelect={() => handleMove(index, -1)}
                  >
                    <ChevronUp className="w-4 h-4" />
                    {t('agentInstanceMoveUp')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid={`agent-instance-move-down-${inst.id}`}
                    disabled={index === instances.length - 1}
                    onSelect={() => handleMove(index, 1)}
                  >
                    <ChevronDown className="w-4 h-4" />
                    {t('agentInstanceMoveDown')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid={`agent-instance-delete-${inst.id}`}
                    disabled={atMin}
                    onSelect={() => {
                      void handleDelete(inst.id);
                    }}
                    className="text-danger-foreground focus:text-danger-foreground"
                  >
                    <Trash2 className="w-4 h-4" />
                    {t('agentInstanceDelete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </div>

      {/* Add instance */}
      <div className="mt-4 flex items-center gap-2">
        <select
          data-testid="agent-instance-add-tool"
          aria-label={t('agentInstanceBaseTool')}
          value={addToolId}
          disabled={saving || atMax}
          onChange={(e) => setAddToolId(e.target.value as CLIToolType)}
          className="flex-1 min-w-0 text-sm border border-input rounded-md px-2 py-2 bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-accent-500 disabled:opacity-50"
        >
          {CLI_TOOL_IDS.map((toolId) => (
            <option key={toolId} value={toolId}>
              {getCliToolDisplayName(toolId)}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="agent-instance-add"
          disabled={saving || atMax}
          onClick={handleAdd}
          className="flex items-center gap-1 text-sm font-medium px-3 py-2 rounded-md border border-accent-200 dark:border-accent-700 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300 hover:bg-accent-100 dark:hover:bg-accent-900/50 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          <Plus className="w-4 h-4" />
          {t('agentInstanceAdd')}
        </button>
      </div>

      {atMax && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('agentInstanceMax', { max: MAX_AGENT_INSTANCES })}
        </p>
      )}
      {atMin && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('agentInstanceMin', { min: MIN_AGENT_INSTANCES })}
        </p>
      )}

      {saving && (
        <div
          data-testid="agent-instances-loading"
          className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"
        >
          <Spinner size="xs" variant="muted" />
          {t('loading')}
        </div>
      )}

      {error && (
        <p data-testid="agent-instances-error" className="mt-3 text-xs text-danger-foreground">
          {error}
        </p>
      )}

      {/* Ollama model selector (shown when any instance backs vibe-local) */}
      {hasVibeLocal && (
        <VibeLocalSettings
          worktreeId={worktreeId}
          vibeLocalModel={vibeLocalModel}
          onVibeLocalModelChange={onVibeLocalModelChange}
          vibeLocalContextWindow={vibeLocalContextWindow}
          onVibeLocalContextWindowChange={onVibeLocalContextWindowChange}
        />
      )}

      {/* Issue #2069: agent CLI versions and the update button, APPENDED below
          the roster editor rather than woven into a row. The roster's rows are
          about which sessions exist; this is about the binaries underneath
          them, and it is also where the "a running session keeps the old
          binary" warning and the per-instance restart belong — which is why it
          is handed the roster it is rendered next to.

          Behind a disclosure, and that is not a styling choice: mounting the
          card runs a `--version` fan-out plus a worktree read, and #2054's
          criterion for this pane is that a roster of claude and codex panes
          issues ZERO requests — true of the request log, not only of the
          pixels. A closed disclosure fetches nothing, so opening the roster
          editor still costs nothing and the user pays only when they ask what
          version they are on. */}
      <div className="mt-6 border-t border-border pt-4">
        <button
          type="button"
          data-testid="agent-updates-toggle"
          aria-expanded={showUpdates}
          onClick={() => setShowUpdates((open) => !open)}
          className="flex w-full items-center gap-1 text-left text-sm font-semibold text-foreground hover:text-accent-600 dark:hover:text-accent-400"
        >
          {showUpdates ? (
            <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          {tCommon('agentUpdates.title')}
        </button>
        {showUpdates && (
          <div className="mt-2">
            <AgentUpdatesCard
              worktreeId={worktreeId}
              instances={instances.map((inst) => ({
                id: inst.id,
                cliTool: inst.cliTool,
                alias: inst.alias,
              }))}
              variant="plain"
            />
          </div>
        )}
      </div>
    </div>
  );
});

export default AgentInstancesPane;
