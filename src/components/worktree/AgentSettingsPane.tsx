/**
 * AgentSettingsPane Component
 *
 * UI for selecting the CLI tools used in a worktree.
 * Renders `availableAgents` as checkboxes, capped at `maxAgents` selections
 * (PC: 6, mobile: 6 / all agents — Issue #851, #989).
 * When persisting to the server, a selection of >= 2 calls
 * PATCH /api/worktrees/[id]; mobile (persistToServer=false) skips the PATCH.
 * Also renders Ollama model dropdown when vibe-local is selected, and the
 * opencode launch settings ({@link OpencodeInstanceSettings}) when an opencode
 * agent is selected (Issue #2048).
 */

'use client';

import React, { useState, useCallback, useRef, useEffect, memo } from 'react';
import { useTranslations } from 'next-intl';
import {
  CLI_TOOL_IDS,
  getCliToolDisplayName,
  type CLIToolType,
} from '@/lib/cli-tools/types';
import { VibeLocalSettings } from '@/components/worktree/VibeLocalSettings';
import { Checkbox, Spinner } from '@/components/ui';
import {
  EMPTY_OPENCODE_INSTANCE_SETTINGS,
  type OpencodeInstanceSettings as OpencodeInstanceSettingsValue,
  type OpencodeInstanceSettingsResponse,
  type OpencodeLaunchCatalog,
  type OpencodeModelChoice,
} from '@/types/opencode-instance-settings';

// ============================================================================
// Types
// ============================================================================

/** Props for the AgentSettingsPane component */
export interface AgentSettingsPaneProps {
  /** Worktree ID for API calls */
  worktreeId: string;
  /** Currently selected agents (2-4 CLI tool IDs) */
  selectedAgents: CLIToolType[];
  /** Callback when selected agents change (after successful API persist) */
  onSelectedAgentsChange: (agents: CLIToolType[]) => void;
  /** Maximum number of agents that can be selected (6 on mobile, 6 on PC — Issue #989) */
  maxAgents?: number;
  /**
   * Issue #837: The selectable agent pool rendered as checkboxes.
   * Defaults to all CLI tools. Mobile passes the DB `selectedAgents` so the
   * local preference can only pick from agents the PC has activated.
   */
  availableAgents?: readonly CLIToolType[];
  /**
   * Issue #837: When false, a selection change is NOT persisted to the DB
   * (no PATCH); only `onSelectedAgentsChange` is invoked so the caller can
   * persist elsewhere (e.g. localStorage on mobile). Defaults to true.
   */
  persistToServer?: boolean;
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
// Constants
// ============================================================================

/** Default maximum number of agents that can be selected */
const DEFAULT_MAX_AGENTS = 2;

/** Minimum number of agents required for persistence */
const MIN_AGENTS_FOR_PERSIST = 2;

/**
 * The primary opencode instance, which is what this pane can address.
 *
 * Module-scoped rather than built in the render so the array identity is stable
 * and the memoised child below is not re-rendered by every keystroke in the
 * checkbox list.
 */
const PRIMARY_OPENCODE_INSTANCE: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'opencode', label: getCliToolDisplayName('opencode') },
];

/** Props for {@link OpencodeInstanceSettings}. */
export interface OpencodeInstanceSettingsProps {
  /** Worktree ID for API calls */
  worktreeId: string;
  /**
   * The opencode-backed instances to edit, in roster order.
   *
   * A list rather than a single id because a worktree may run several opencode
   * instances (Issue #868) and each one launches with its own settings. This
   * pane passes the primary one; a roster-aware caller passes
   * `instances.filter((i) => i.cliTool === 'opencode')`.
   */
  instances: ReadonlyArray<{ id: string; label: string }>;
}

/** `provider/model`, split at the FIRST slash — model ids contain slashes too. */
function splitModelReference(reference: string): { providerId: string; modelId: string } | null {
  const slash = reference.indexOf('/');
  if (slash <= 0 || slash === reference.length - 1) return null;
  return {
    providerId: reference.slice(0, slash),
    modelId: reference.slice(slash + 1),
  };
}

/** The model entry a settings value points at, or null when nothing matches. */
function findModel(
  catalog: OpencodeLaunchCatalog,
  settings: OpencodeInstanceSettingsValue
): OpencodeModelChoice | null {
  if (!settings.providerId || !settings.modelId) return null;
  const provider = catalog.providers.find((entry) => entry.id === settings.providerId);
  return provider?.models.find((model) => model.id === settings.modelId) ?? null;
}

/**
 * opencode's per-instance launch settings — agent, model and variant (#2048).
 *
 * ## The three fields do not all do the same thing, and the pane says so
 *
 * Measured on opencode 1.18.22 in an isolated `HOME`
 * (`docs/design/opencode-server-live-verification.md` §20):
 *
 *  - **agent** and **model** are launch flags (`--agent`, `-m provider/model`),
 *    so they take effect the next time the pane starts;
 *  - **variant** is not. The TUI has no `--variant` — it is a flag of
 *    `opencode run` — and a launch line carrying one makes opencode print its
 *    usage and exit. It is applied on the prompts CommandMate posts, which is
 *    the one channel measured to set it, and takes effect on the next message.
 *
 * That difference is surfaced as a note under the variant control rather than
 * hidden, because a setting whose timing the operator cannot predict is a
 * setting they will assume is broken.
 *
 * ## Why the candidate lists can be empty
 *
 * They come from a **running** opencode (`GET /config/providers`, `GET /agent`
 * — the TUI serves both once it has a port), so a worktree whose panes are
 * stopped has nothing to offer. That is the ordinary state, not a failure: the
 * controls fall back to free text and the values are validated server-side
 * either way.
 */
export const OpencodeInstanceSettings = memo(function OpencodeInstanceSettings({
  worktreeId,
  instances,
}: OpencodeInstanceSettingsProps) {
  const t = useTranslations('schedule');
  const [settings, setSettings] = useState<Record<string, OpencodeInstanceSettingsValue>>({});
  const [catalog, setCatalog] = useState<OpencodeLaunchCatalog>({
    connected: false,
    providers: [],
    agents: [],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/worktrees/${worktreeId}/instances/opencode`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: OpencodeInstanceSettingsResponse) => {
        if (cancelled) return;
        setSettings(data.settings ?? {});
        setCatalog(data.catalog ?? { connected: false, providers: [], agents: [] });
        setError(null);
      })
      .catch(() => {
        if (cancelled) return;
        // A failed read leaves the controls empty and editable rather than
        // absent: the settings still exist server-side and a write repairs the
        // view, which is better than a pane that cannot be opened.
        setError(t('opencodeSettingsLoadError'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [worktreeId, t]);

  const persist = useCallback(
    async (instanceId: string, next: OpencodeInstanceSettingsValue) => {
      setSettings((current) => ({ ...current, [instanceId]: next }));
      setSaving(true);
      setError(null);
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}/instances/opencode`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instanceId, ...next }),
        });
        if (!response.ok) {
          setError(t('opencodeSettingsSaveError'));
          return;
        }
        // The server is what decides which values survive validation, so its
        // answer replaces the optimistic one rather than confirming it.
        const body: { settings?: OpencodeInstanceSettingsValue } = await response.json();
        if (body.settings) {
          setSettings((current) => ({ ...current, [instanceId]: body.settings! }));
        }
      } catch {
        setError(t('opencodeSettingsSaveError'));
      } finally {
        setSaving(false);
      }
    },
    [worktreeId, t]
  );

  return (
    <div className="mt-4 pt-4 border-t border-border" data-testid="opencode-instance-settings">
      <h4 className="text-sm font-semibold text-foreground mb-1">
        {t('opencodeSettings')}
      </h4>
      <p className="text-xs text-muted-foreground mb-3">
        {t('opencodeSettingsDescription')}
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner size="xs" variant="muted" />
          {t('loading')}
        </div>
      ) : (
        <div className="space-y-4">
          {!catalog.connected && (
            <p
              data-testid="opencode-settings-offline"
              className="text-xs text-muted-foreground"
            >
              {t('opencodeSettingsOffline')}
            </p>
          )}

          {instances.map((instance) => {
            const value = settings[instance.id] ?? { ...EMPTY_OPENCODE_INSTANCE_SETTINGS };
            const modelReference =
              value.providerId && value.modelId ? `${value.providerId}/${value.modelId}` : '';
            const selectedModel = findModel(catalog, value);
            // Only the model the operator actually chose can say which variants
            // exist. With no catalogue (or a model that is not in it) the field
            // stays free text rather than offering a list that would be a guess.
            const variantChoices = selectedModel?.variants ?? [];
            const launchAgents = catalog.agents.filter((agent) => agent.mode === 'primary');

            return (
              <div key={instance.id} className="space-y-2">
                {instances.length > 1 && (
                  <p className="text-xs font-medium text-foreground">{instance.label}</p>
                )}

                {/* Agent */}
                <label className="block text-xs text-muted-foreground">
                  {t('opencodeAgent')}
                  {launchAgents.length > 0 ? (
                    <select
                      data-testid={`opencode-agent-select-${instance.id}`}
                      value={value.agent ?? ''}
                      disabled={saving}
                      onChange={(e) =>
                        void persist(instance.id, {
                          ...value,
                          agent: e.target.value === '' ? null : e.target.value,
                        })
                      }
                      className="mt-1 w-full text-sm border border-input rounded-md px-3 py-2 bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-accent-500 disabled:opacity-50"
                    >
                      <option value="">{t('opencodeDefault')}</option>
                      {launchAgents.map((agent) => (
                        <option key={agent.name} value={agent.name}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      data-testid={`opencode-agent-input-${instance.id}`}
                      defaultValue={value.agent ?? ''}
                      disabled={saving}
                      placeholder={t('opencodeAgentPlaceholder')}
                      onBlur={(e) =>
                        void persist(instance.id, {
                          ...value,
                          agent: e.target.value.trim() === '' ? null : e.target.value.trim(),
                        })
                      }
                      className="mt-1 w-full text-sm border border-input rounded-md px-3 py-2 bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-accent-500 disabled:opacity-50"
                    />
                  )}
                </label>

                {/* Model */}
                <label className="block text-xs text-muted-foreground">
                  {t('opencodeModel')}
                  {catalog.providers.length > 0 ? (
                    <select
                      data-testid={`opencode-model-select-${instance.id}`}
                      value={modelReference}
                      disabled={saving}
                      onChange={(e) => {
                        const parsed = splitModelReference(e.target.value);
                        void persist(instance.id, {
                          ...value,
                          providerId: parsed?.providerId ?? null,
                          modelId: parsed?.modelId ?? null,
                          // A model change can invalidate the variant: variant
                          // names belong to one model's own `variants` map, and
                          // carrying `xhigh` onto a model that has no such entry
                          // would send a word nothing maps.
                          variant: null,
                        });
                      }}
                      className="mt-1 w-full text-sm border border-input rounded-md px-3 py-2 bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-accent-500 disabled:opacity-50"
                    >
                      <option value="">{t('opencodeDefault')}</option>
                      {catalog.providers.map((provider) => (
                        <optgroup key={provider.id} label={provider.name}>
                          {provider.models.map((model) => (
                            <option key={model.id} value={`${provider.id}/${model.id}`}>
                              {model.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      data-testid={`opencode-model-input-${instance.id}`}
                      defaultValue={modelReference}
                      disabled={saving}
                      placeholder={t('opencodeModelPlaceholder')}
                      onBlur={(e) => {
                        const parsed = splitModelReference(e.target.value.trim());
                        void persist(instance.id, {
                          ...value,
                          providerId: parsed?.providerId ?? null,
                          modelId: parsed?.modelId ?? null,
                        });
                      }}
                      className="mt-1 w-full text-sm border border-input rounded-md px-3 py-2 bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-accent-500 disabled:opacity-50"
                    />
                  )}
                </label>

                {/* Variant */}
                <label className="block text-xs text-muted-foreground">
                  {t('opencodeVariant')}
                  {variantChoices.length > 0 ? (
                    <select
                      data-testid={`opencode-variant-select-${instance.id}`}
                      value={value.variant ?? ''}
                      disabled={saving}
                      onChange={(e) =>
                        void persist(instance.id, {
                          ...value,
                          variant: e.target.value === '' ? null : e.target.value,
                        })
                      }
                      className="mt-1 w-full text-sm border border-input rounded-md px-3 py-2 bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-accent-500 disabled:opacity-50"
                    >
                      <option value="">{t('opencodeDefault')}</option>
                      {variantChoices.map((variant) => (
                        <option key={variant} value={variant}>
                          {variant}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      data-testid={`opencode-variant-input-${instance.id}`}
                      defaultValue={value.variant ?? ''}
                      disabled={saving}
                      placeholder={t('opencodeVariantPlaceholder')}
                      onBlur={(e) =>
                        void persist(instance.id, {
                          ...value,
                          variant: e.target.value.trim() === '' ? null : e.target.value.trim(),
                        })
                      }
                      className="mt-1 w-full text-sm border border-input rounded-md px-3 py-2 bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-accent-500 disabled:opacity-50"
                    />
                  )}
                </label>
                {selectedModel && variantChoices.length === 0 && (
                  <p className="text-xs text-muted-foreground">{t('opencodeNoVariants')}</p>
                )}
              </div>
            );
          })}

          {/* The timing difference between the launch flags and the variant. */}
          <p className="text-xs text-muted-foreground">{t('opencodeVariantLaunchNote')}</p>

          {saving && (
            <div
              data-testid="opencode-settings-loading"
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <Spinner size="xs" variant="muted" />
              {t('loading')}
            </div>
          )}

          {error && (
            <p data-testid="opencode-settings-error" className="text-xs text-danger-foreground">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
});

// ============================================================================
// Component
// ============================================================================

export const AgentSettingsPane = memo(function AgentSettingsPane({
  worktreeId,
  selectedAgents,
  onSelectedAgentsChange,
  vibeLocalModel,
  onVibeLocalModelChange,
  vibeLocalContextWindow,
  onVibeLocalContextWindowChange,
  maxAgents = DEFAULT_MAX_AGENTS,
  availableAgents = CLI_TOOL_IDS,
  persistToServer = true,
}: AgentSettingsPaneProps) {
  const t = useTranslations('schedule');

  // Clamp selectedAgents to maxAgents (PC: 5, mobile: 6 — Issue #851)
  const clampedAgents = selectedAgents.length > maxAgents
    ? selectedAgents.slice(0, maxAgents)
    : selectedAgents;

  // Local checked state allows intermediate states (0 or 1 selected)
  const [checkedIds, setCheckedIds] = useState<Set<CLIToolType>>(
    () => new Set(clampedAgents)
  );
  const [saving, setSaving] = useState(false);
  // Prevents polling-driven prop sync from overwriting intermediate checkbox state
  const [isEditing, setIsEditing] = useState(false);

  // Use ref to access latest checkedIds inside async callback without recreating it
  const checkedIdsRef = useRef(checkedIds);
  checkedIdsRef.current = checkedIds;

  // Keep local checkbox state in sync with server-backed selectedAgents prop,
  // guarded by isEditing to prevent polling-driven overwrites during editing.
  useEffect(() => {
    if (!isEditing) {
      setCheckedIds(new Set(clampedAgents));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgents, isEditing, maxAgents]);

  const isVibeLocalChecked = checkedIds.has('vibe-local');
  // Issue #2048: same rule, for the pane below.
  const isOpencodeChecked = checkedIds.has('opencode');

  const handleCheckboxChange = useCallback(
    async (toolId: CLIToolType, checked: boolean) => {
      const next = new Set(checkedIdsRef.current);
      if (checked) {
        next.add(toolId);
      } else {
        next.delete(toolId);
        setIsEditing(true);
      }
      setCheckedIds(next);

      // Persist when at least MIN_AGENTS_FOR_PERSIST are selected
      if (next.size >= MIN_AGENTS_FOR_PERSIST) {
        const pair = Array.from(next) as CLIToolType[];

        // Issue #837: Mobile preference is local-only — never write the DB.
        // Hand the new pair to the caller (localStorage) and skip the PATCH so
        // the PC's DB `selectedAgents` (its source of truth) stays unchanged.
        if (!persistToServer) {
          setCheckedIds(new Set(pair));
          onSelectedAgentsChange(pair);
          setIsEditing(false);
          return;
        }

        setSaving(true);
        try {
          const response = await fetch(`/api/worktrees/${worktreeId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selectedAgents: pair }),
          });
          if (response.ok) {
            setCheckedIds(new Set(pair));
            onSelectedAgentsChange(pair);
          } else {
            // Revert on failure
            setCheckedIds(new Set(clampedAgents));
          }
        } catch {
          // Revert on network error
          setCheckedIds(new Set(clampedAgents));
        } finally {
          setSaving(false);
          setIsEditing(false);
        }
      }
    },
    [worktreeId, clampedAgents, onSelectedAgentsChange, persistToServer]
  );

  const isMaxSelected = checkedIds.size >= maxAgents;

  return (
    <div className="p-4">
      <h3 className="text-sm font-semibold text-foreground mb-1">
        {t('agentSettings')}
      </h3>
      <p className="text-xs text-muted-foreground mb-4">
        {t('selectAgents')}
      </p>

      <div className="space-y-3">
        {availableAgents.map((toolId) => {
          const isChecked = checkedIds.has(toolId);
          const isDisabled = !isChecked && isMaxSelected;

          return (
            <label
              key={toolId}
              className={`flex items-center gap-3 p-2 rounded-lg border transition-colors ${
                isChecked
                  ? 'border-accent-200 dark:border-accent-700 bg-accent-50 dark:bg-accent-900/30'
                  : isDisabled
                    ? 'border-border bg-muted opacity-50'
                    : 'border-border hover:border-input hover:bg-muted'
              }`}
            >
              <Checkbox
                data-testid={`agent-checkbox-${toolId}`}
                aria-label={getCliToolDisplayName(toolId)}
                checked={isChecked}
                disabled={isDisabled || saving}
                onCheckedChange={(checked) => handleCheckboxChange(toolId, checked === true)}
              />
              <span className="text-sm font-medium text-foreground">
                {getCliToolDisplayName(toolId)}
              </span>
            </label>
          );
        })}
      </div>

      {saving && (
        <div
          data-testid="agent-settings-loading"
          className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"
        >
          <Spinner size="xs" variant="muted" />
          {t('loading')}
        </div>
      )}

      {/* Issue #2048: opencode launch settings (agent / model / variant).
          Rendered for the PRIMARY opencode instance, which is the only one this
          pane can address: it edits `selectedAgents`, whose entries are tool ids,
          and an instance id that equals a tool id *is* that tool's primary
          instance (Issue #868). The roster-aware panes pass their own list. */}
      {isOpencodeChecked && (
        <OpencodeInstanceSettings
          worktreeId={worktreeId}
          instances={PRIMARY_OPENCODE_INSTANCE}
        />
      )}

      {/* Ollama model selector (vibe-local only) */}
      {isVibeLocalChecked && (
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

export default AgentSettingsPane;
