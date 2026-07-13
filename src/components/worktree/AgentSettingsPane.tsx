/**
 * AgentSettingsPane Component
 *
 * UI for selecting the CLI tools used in a worktree.
 * Renders `availableAgents` as checkboxes, capped at `maxAgents` selections
 * (PC: 6, mobile: 6 / all agents — Issue #851, #989).
 * When persisting to the server, a selection of >= 2 calls
 * PATCH /api/worktrees/[id]; mobile (persistToServer=false) skips the PATCH.
 * Also renders Ollama model dropdown when vibe-local is selected.
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
