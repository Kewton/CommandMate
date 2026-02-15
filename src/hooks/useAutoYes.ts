/**
 * useAutoYes - Custom hook for auto-yes mode
 *
 * Handles automatic prompt response when auto-yes is enabled.
 * Uses a ref-based duplicate prevention mechanism to avoid
 * sending the same response multiple times during polling intervals.
 *
 * Issue #138: Added server-side duplicate prevention using lastServerResponseTimestamp.
 * If the server has responded within the last 3 seconds, the client skips responding.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { resolveAutoAnswer } from '@/lib/auto-yes-resolver';
import type { PromptData } from '@/types/models';

/** Duplicate prevention window in milliseconds (3 seconds) */
const DUPLICATE_PREVENTION_WINDOW_MS = 3000;

/** Parameters for useAutoYes hook */
export interface UseAutoYesParams {
  /** Worktree ID */
  worktreeId: string;
  /** CLI tool identifier */
  cliTool: string;
  /** Whether a prompt is currently waiting */
  isPromptWaiting: boolean;
  /** Current prompt data */
  promptData: PromptData | null;
  /** Whether auto-yes mode is enabled */
  autoYesEnabled: boolean;
  /** Last server-side response timestamp (Issue #138) */
  lastServerResponseTimestamp?: number | null;
}

/** Return value of useAutoYes hook */
export interface UseAutoYesReturn {
  /** Most recent auto-response answer (for notification display) */
  lastAutoResponse: string | null;
}

/**
 * Hook that automatically responds to prompts when auto-yes is enabled
 */
export function useAutoYes({
  worktreeId,
  cliTool,
  isPromptWaiting,
  promptData,
  autoYesEnabled,
  lastServerResponseTimestamp,
}: UseAutoYesParams): UseAutoYesReturn {
  const lastAutoRespondedRef = useRef<string | null>(null);
  const [lastAutoResponse, setLastAutoResponse] = useState<string | null>(null);

  useEffect(() => {
    // Reset when prompt clears
    if (!isPromptWaiting) {
      lastAutoRespondedRef.current = null;
      return;
    }

    if (!promptData || !autoYesEnabled) return;

    // Issue #138: Skip if server has responded recently (duplicate prevention)
    if (lastServerResponseTimestamp) {
      const timeSinceServerResponse = Date.now() - lastServerResponseTimestamp;
      if (timeSinceServerResponse < DUPLICATE_PREVENTION_WINDOW_MS) {
        // Server responded within the last 3 seconds, skip client-side response
        return;
      }
    }

    // Generate composite key for duplicate prevention
    const promptKey = `${promptData.type}:${promptData.question}`;
    if (lastAutoRespondedRef.current === promptKey) return;

    const answer = resolveAutoAnswer(promptData);
    if (answer === null) return;

    lastAutoRespondedRef.current = promptKey;
    setLastAutoResponse(answer);

    // Issue #287: Include promptType and defaultOptionNumber in the request body
    // so the API can use cursor-key navigation even when promptCheck re-verification fails.
    const requestBody: Record<string, unknown> = { answer, cliTool, promptType: promptData.type };
    if (promptData.type === 'multiple_choice') {
      const defaultOption = promptData.options.find(o => o.isDefault);
      if (defaultOption) {
        requestBody.defaultOptionNumber = defaultOption.number;
      }
    }

    // Send auto-response via existing prompt-response API
    fetch(`/api/worktrees/${worktreeId}/prompt-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    }).catch((err) => {
      console.error('[useAutoYes] Failed to send auto-response:', err);
    });
  }, [isPromptWaiting, promptData, autoYesEnabled, worktreeId, cliTool, lastServerResponseTimestamp]);

  return { lastAutoResponse };
}
