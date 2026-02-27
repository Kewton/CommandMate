/**
 * AgentSettingsPane Component
 * Issue #368: UI for selecting 2 CLI tools per worktree
 *
 * Renders CLI_TOOL_IDS as checkboxes with max 2 selection constraint.
 * When 2 are selected, calls PATCH /api/worktrees/[id] to persist.
 *
 * Also renders Ollama model dropdown when vibe-local is selected.
 *
 * [R4-006] No dangerouslySetInnerHTML - all display names rendered as text nodes.
 */

'use client';

import React, { useState, useCallback, useRef, useEffect, memo } from 'react';
import { useTranslations } from 'next-intl';
import { CLI_TOOL_IDS, getCliToolDisplayName, type CLIToolType } from '@/lib/cli-tools/types';

// ============================================================================
// Types
// ============================================================================

/** Props for the AgentSettingsPane component */
export interface AgentSettingsPaneProps {
  /** Worktree ID for API calls */
  worktreeId: string;
  /** Currently selected agent pair */
  selectedAgents: [CLIToolType, CLIToolType];
  /** Callback when selected agents change (after successful API persist) */
  onSelectedAgentsChange: (agents: [CLIToolType, CLIToolType]) => void;
  /** Current vibe-local model selection (null = default) */
  vibeLocalModel: string | null;
  /** Callback when vibe-local model changes */
  onVibeLocalModelChange: (model: string | null) => void;
  /** Current vibe-local context window (null = default) - Issue #374 */
  vibeLocalContextWindow?: number | null;
  /** Callback when vibe-local context window changes - Issue #374 */
  onVibeLocalContextWindowChange?: (value: number | null) => void;
}

/** Ollama model info from API */
interface OllamaModelInfo {
  name: string;
  size: number;
  parameterSize: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum number of agents that can be selected */
const MAX_SELECTED_AGENTS = 2;

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
}: AgentSettingsPaneProps) {
  const t = useTranslations('schedule');

  // Local checked state allows intermediate states (0 or 1 selected)
  const [checkedIds, setCheckedIds] = useState<Set<CLIToolType>>(
    () => new Set(selectedAgents)
  );
  const [saving, setSaving] = useState(false);

  // Ollama model state
  const [ollamaModels, setOllamaModels] = useState<OllamaModelInfo[]>([]);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  // Issue #374: Context window saving state
  const [savingContextWindow, setSavingContextWindow] = useState(false);

  // Use ref to access latest checkedIds inside async callback without recreating it
  const checkedIdsRef = useRef(checkedIds);
  checkedIdsRef.current = checkedIds;

  // Keep local checkbox state in sync with server-backed selectedAgents prop.
  useEffect(() => {
    setCheckedIds(new Set(selectedAgents));
  }, [selectedAgents]);

  const isVibeLocalChecked = checkedIds.has('vibe-local');

  // Fetch Ollama models when vibe-local is checked
  useEffect(() => {
    if (!isVibeLocalChecked) {
      setOllamaModels([]);
      setOllamaError(null);
      return;
    }

    let cancelled = false;
    setLoadingModels(true);

    fetch('/api/ollama/models')
      .then((res) => res.json())
      .then((data: { models: OllamaModelInfo[]; error?: string }) => {
        if (cancelled) return;
        setOllamaModels(data.models);
        setOllamaError(data.models.length === 0 && data.error ? data.error : null);
      })
      .catch(() => {
        if (cancelled) return;
        setOllamaModels([]);
        setOllamaError('Failed to fetch models');
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });

    return () => { cancelled = true; };
  }, [isVibeLocalChecked]);

  const handleCheckboxChange = useCallback(
    async (toolId: CLIToolType, checked: boolean) => {
      const next = new Set(checkedIdsRef.current);
      if (checked) {
        next.add(toolId);
      } else {
        next.delete(toolId);
      }
      setCheckedIds(next);

      // Only persist when exactly 2 are selected
      if (next.size === MAX_SELECTED_AGENTS) {
        const pair = Array.from(next) as [CLIToolType, CLIToolType];
        setSaving(true);
        try {
          const response = await fetch(`/api/worktrees/${worktreeId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selectedAgents: pair }),
          });
          if (response.ok) {
            onSelectedAgentsChange(pair);
          } else {
            // Revert on failure
            setCheckedIds(new Set(selectedAgents));
          }
        } catch {
          // Revert on network error
          setCheckedIds(new Set(selectedAgents));
        } finally {
          setSaving(false);
        }
      }
    },
    [worktreeId, selectedAgents, onSelectedAgentsChange]
  );

  const handleModelChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      const model = value === '' ? null : value;
      setSavingModel(true);
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vibeLocalModel: model }),
        });
        if (response.ok) {
          onVibeLocalModelChange(model);
        }
      } catch {
        // Silently fail - model selection is non-critical
      } finally {
        setSavingModel(false);
      }
    },
    [worktreeId, onVibeLocalModelChange]
  );

  // Issue #374: Handle context window change
  const handleContextWindowChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      const ctxWindow = raw === '' ? null : parseInt(raw, 10);
      setSavingContextWindow(true);
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vibeLocalContextWindow: ctxWindow }),
        });
        if (response.ok) {
          onVibeLocalContextWindowChange?.(ctxWindow);
        }
      } catch {
        // Silently fail - context window selection is non-critical
      } finally {
        setSavingContextWindow(false);
      }
    },
    [worktreeId, onVibeLocalContextWindowChange]
  );

  const isMaxSelected = checkedIds.size >= MAX_SELECTED_AGENTS;

  return (
    <div className="p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-1">
        {t('agentSettings')}
      </h3>
      <p className="text-xs text-gray-500 mb-4">
        {t('selectAgents')}
      </p>

      <div className="space-y-3">
        {CLI_TOOL_IDS.map((toolId) => {
          const isChecked = checkedIds.has(toolId);
          const isDisabled = !isChecked && isMaxSelected;

          return (
            <label
              key={toolId}
              className={`flex items-center gap-3 p-2 rounded-lg border transition-colors ${
                isChecked
                  ? 'border-blue-200 bg-blue-50'
                  : isDisabled
                    ? 'border-gray-100 bg-gray-50 opacity-50'
                    : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
              }`}
            >
              <input
                type="checkbox"
                data-testid={`agent-checkbox-${toolId}`}
                aria-label={getCliToolDisplayName(toolId)}
                checked={isChecked}
                disabled={isDisabled || saving}
                onChange={(e) => handleCheckboxChange(toolId, e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-700">
                {getCliToolDisplayName(toolId)}
              </span>
            </label>
          );
        })}
      </div>

      {saving && (
        <div
          data-testid="agent-settings-loading"
          className="mt-3 flex items-center gap-2 text-xs text-gray-500"
        >
          <span className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          {t('loading')}
        </div>
      )}

      {/* Ollama model selector - shown when vibe-local is checked */}
      {isVibeLocalChecked && (
        <div className="mt-4 pt-4 border-t border-gray-200">
          <h4 className="text-sm font-semibold text-gray-700 mb-2">
            {t('vibeLocalModel')}
          </h4>

          {loadingModels ? (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              {t('loading')}
            </div>
          ) : ollamaError && ollamaModels.length === 0 ? (
            <p className="text-xs text-amber-600">
              {t('ollamaNotAvailable')}
            </p>
          ) : (
            <select
              data-testid="vibe-local-model-select"
              value={vibeLocalModel ?? ''}
              onChange={handleModelChange}
              disabled={savingModel}
              className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
            >
              <option value="">{t('vibeLocalModelDefault')}</option>
              {ollamaModels.map((model) => (
                <option key={model.name} value={model.name}>
                  {model.name}{model.parameterSize ? ` (${model.parameterSize})` : ''}
                </option>
              ))}
            </select>
          )}

          {/* Issue #374: Context window input */}
          <div className="mt-3">
            <h4 className="text-sm font-semibold text-gray-700 mb-2">
              {t('vibeLocalContextWindow')}
            </h4>
            <input
              type="number"
              data-testid="vibe-local-context-window-input"
              step="1"
              min="128"
              max="2097152"
              value={vibeLocalContextWindow ?? ''}
              onChange={handleContextWindowChange}
              placeholder={t('vibeLocalContextWindowDefault')}
              disabled={savingContextWindow}
              className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
            />
          </div>
        </div>
      )}
    </div>
  );
});

export default AgentSettingsPane;
