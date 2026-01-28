/**
 * useAutoYes - Custom hook for auto-yes mode
 *
 * Handles automatic prompt response when auto-yes is enabled.
 * Uses a ref-based duplicate prevention mechanism to avoid
 * sending the same response multiple times during polling intervals.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { resolveAutoAnswer } from '@/lib/auto-yes-resolver';
import type { PromptData } from '@/types/models';

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

    // Generate composite key for duplicate prevention
    const promptKey = `${promptData.type}:${promptData.question}`;
    if (lastAutoRespondedRef.current === promptKey) return;

    const answer = resolveAutoAnswer(promptData);
    if (answer === null) return;

    lastAutoRespondedRef.current = promptKey;
    setLastAutoResponse(answer);

    // Send auto-response via existing prompt-response API
    fetch(`/api/worktrees/${worktreeId}/prompt-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer, cliTool }),
    }).catch((err) => {
      console.error('[useAutoYes] Failed to send auto-response:', err);
    });
  }, [isPromptWaiting, promptData, autoYesEnabled, worktreeId, cliTool]);

  return { lastAutoResponse };
}
