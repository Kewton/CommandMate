/**
 * VibeLocalSettings Component
 *
 * Shared UI for the vibe-local (Ollama) model selector and context-window
 * input. Extracted from AgentSettingsPane (Issue #869) so both the mobile
 * checkbox-based AgentSettingsPane and the PC AgentInstancesPane can render the
 * exact same controls (preserving data-testids `vibe-local-model-select` and
 * `vibe-local-context-window-input`).
 *
 * The component fetches the Ollama model list on mount; callers should only
 * mount it when a vibe-local agent is active so the fetch is deferred until
 * needed.
 */

'use client';

import React, { useState, useCallback, useEffect, memo } from 'react';
import { useTranslations } from 'next-intl';
import {
  VIBE_LOCAL_CONTEXT_WINDOW_MIN,
  VIBE_LOCAL_CONTEXT_WINDOW_MAX,
} from '@/lib/cli-tools/types';
import { Spinner } from '@/components/ui/Spinner';

// ============================================================================
// Types
// ============================================================================

/** Ollama model info from API */
interface OllamaModelInfo {
  name: string;
  size: number;
  parameterSize: string;
}

/** Props for the VibeLocalSettings component */
export interface VibeLocalSettingsProps {
  /** Worktree ID for API calls */
  worktreeId: string;
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
// Component
// ============================================================================

export const VibeLocalSettings = memo(function VibeLocalSettings({
  worktreeId,
  vibeLocalModel,
  onVibeLocalModelChange,
  vibeLocalContextWindow,
  onVibeLocalContextWindowChange,
}: VibeLocalSettingsProps) {
  const t = useTranslations('schedule');

  // Ollama model state
  const [ollamaModels, setOllamaModels] = useState<OllamaModelInfo[]>([]);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  // Context window local input state (decoupled from prop to allow free typing)
  const [contextWindowInput, setContextWindowInput] = useState<string>(
    vibeLocalContextWindow != null ? String(vibeLocalContextWindow) : ''
  );
  const [savingContextWindow, setSavingContextWindow] = useState(false);

  // Keep local context window input in sync with server-backed prop.
  useEffect(() => {
    setContextWindowInput(
      vibeLocalContextWindow != null ? String(vibeLocalContextWindow) : ''
    );
  }, [vibeLocalContextWindow]);

  // Fetch Ollama models on mount (caller mounts this only when vibe-local active)
  useEffect(() => {
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
  }, []);

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

  const handleContextWindowInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setContextWindowInput(e.target.value);
    },
    []
  );

  /** Save context window on blur (when user finishes editing) */
  const handleContextWindowBlur = useCallback(
    async () => {
      const raw = contextWindowInput.trim();
      const parsed = parseInt(raw, 10);
      const ctxWindow = raw === '' ? null : (Number.isNaN(parsed) ? null : parsed);

      // Skip API call if value hasn't changed
      const currentValue = vibeLocalContextWindow ?? null;
      if (ctxWindow === currentValue) return;

      setSavingContextWindow(true);
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vibeLocalContextWindow: ctxWindow }),
        });
        if (response.ok) {
          onVibeLocalContextWindowChange?.(ctxWindow);
        } else {
          // Revert input to previous value on server rejection
          setContextWindowInput(
            currentValue != null ? String(currentValue) : ''
          );
        }
      } catch {
        // Revert input on network error
        setContextWindowInput(
          currentValue != null ? String(currentValue) : ''
        );
      } finally {
        setSavingContextWindow(false);
      }
    },
    [contextWindowInput, vibeLocalContextWindow, worktreeId, onVibeLocalContextWindowChange]
  );

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <h4 className="text-sm font-semibold text-foreground mb-2">
        {t('vibeLocalModel')}
      </h4>

      {loadingModels ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner size="xs" variant="muted" />
          {t('loading')}
        </div>
      ) : ollamaError && ollamaModels.length === 0 ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {t('ollamaNotAvailable')}
        </p>
      ) : (
        <select
          data-testid="vibe-local-model-select"
          value={vibeLocalModel ?? ''}
          onChange={handleModelChange}
          disabled={savingModel}
          className="w-full text-sm border border-input rounded-md px-3 py-2 bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-accent-500 disabled:opacity-50"
        >
          <option value="">{t('vibeLocalModelDefault')}</option>
          {ollamaModels.map((model) => (
            <option key={model.name} value={model.name}>
              {model.name}{model.parameterSize ? ` (${model.parameterSize})` : ''}
            </option>
          ))}
        </select>
      )}

      {/* Context window input */}
      <div className="mt-3">
        <h4 className="text-sm font-semibold text-foreground mb-2">
          {t('vibeLocalContextWindow')}
        </h4>
        <input
          type="number"
          data-testid="vibe-local-context-window-input"
          step="1"
          min={VIBE_LOCAL_CONTEXT_WINDOW_MIN}
          max={VIBE_LOCAL_CONTEXT_WINDOW_MAX}
          value={contextWindowInput}
          onChange={handleContextWindowInput}
          onBlur={handleContextWindowBlur}
          placeholder={t('vibeLocalContextWindowDefault')}
          disabled={savingContextWindow}
          className="w-full text-sm border border-input rounded-md px-3 py-2 bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-accent-500 disabled:opacity-50"
        />
      </div>
    </div>
  );
});

export default VibeLocalSettings;
