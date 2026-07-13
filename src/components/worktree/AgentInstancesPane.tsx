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

import React, { useState, useCallback, memo } from 'react';
import { useTranslations } from 'next-intl';
import { GripVertical, ChevronUp, ChevronDown, Trash2, Plus } from 'lucide-react';
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
import { Spinner } from '@/components/ui/Spinner';

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
}: AgentInstancesPaneProps) {
  const t = useTranslations('schedule');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-id alias edit drafts (decoupled from prop to allow free typing).
  const [aliasDrafts, setAliasDrafts] = useState<Record<string, string>>({});
  // Base tool for the "add instance" control.
  const [addToolId, setAddToolId] = useState<CLIToolType>(CLI_TOOL_IDS[0]);
  // Index of the row currently being dragged (HTML5 reorder).
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

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
    (id: string) => {
      if (instances.length <= MIN_AGENT_INSTANCES) return;
      void persist(instances.filter((inst) => inst.id !== id));
    },
    [instances, persist]
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
              className={`flex items-center gap-2 p-2 rounded-lg border border-border bg-surface ${
                isDragging ? 'opacity-50' : ''
              }`}
            >
              <span
                className="cursor-grab text-muted-foreground shrink-0"
                aria-hidden="true"
              >
                <GripVertical className="w-4 h-4" />
              </span>

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
                <span className="block text-xs text-muted-foreground mt-0.5 truncate">
                  {getCliToolDisplayName(inst.cliTool)}
                </span>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  data-testid={`agent-instance-move-up-${inst.id}`}
                  aria-label={t('agentInstanceMoveUp')}
                  title={t('agentInstanceMoveUp')}
                  disabled={saving || index === 0}
                  onClick={() => handleMove(index, -1)}
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronUp className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  data-testid={`agent-instance-move-down-${inst.id}`}
                  aria-label={t('agentInstanceMoveDown')}
                  title={t('agentInstanceMoveDown')}
                  disabled={saving || index === instances.length - 1}
                  onClick={() => handleMove(index, 1)}
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronDown className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  data-testid={`agent-instance-delete-${inst.id}`}
                  aria-label={t('agentInstanceDelete')}
                  title={t('agentInstanceDelete')}
                  disabled={saving || atMin}
                  onClick={() => handleDelete(inst.id)}
                  className="p-1 rounded text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
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
        <p data-testid="agent-instances-error" className="mt-3 text-xs text-red-600 dark:text-red-400">
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
    </div>
  );
});

export default AgentInstancesPane;
