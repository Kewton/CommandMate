/**
 * Prompt Response Body Builder
 *
 * Shared utility for constructing the request body sent to the
 * POST /api/worktrees/:id/prompt-response API endpoint.
 *
 * Issue #287: Both useAutoYes hook and WorktreeDetailRefactored component
 * need to include promptType and defaultOptionNumber in the request body
 * so the API can use cursor-key navigation even when server-side prompt
 * re-verification fails. This module eliminates that duplication.
 */

import type { PromptData, SubmitMode } from '@/types/models';

/**
 * Shape of the prompt-response API request body.
 */
export interface PromptResponseBody {
  answer: string;
  cliTool: string;
  /** Issue #869: agent instance id (defaults server-side to primary === cliTool). */
  instanceId?: string;
  promptType?: string;
  defaultOptionNumber?: number;
  /** Issue #616: Submit mode for multiple choice prompts */
  submitMode?: SubmitMode;
}

/**
 * Build the request body for the prompt-response API.
 *
 * Includes promptType and (for multiple_choice prompts) the default
 * option number so the API can determine whether to use cursor-key
 * navigation even when server-side prompt re-verification fails.
 *
 * @param answer - The answer string to send
 * @param cliTool - The CLI tool identifier (e.g., 'claude', 'codex')
 * @param promptData - Current prompt data from client-side detection (may be null)
 * @param instanceId - Issue #869: optional agent instance id; included only when
 *                     it differs from the primary instance (`!== cliTool`)
 * @returns The structured request body ready for JSON serialization
 */
export function buildPromptResponseBody(
  answer: string,
  cliTool: string,
  promptData: PromptData | null,
  instanceId?: string,
): PromptResponseBody {
  const body: PromptResponseBody = { answer, cliTool };

  // Issue #869: only attach instanceId for non-primary instances so primary
  // requests stay byte-for-byte identical to pre-#869 behavior.
  if (instanceId && instanceId !== cliTool) {
    body.instanceId = instanceId;
  }

  if (promptData) {
    body.promptType = promptData.type;

    if (promptData.type === 'multiple_choice') {
      const defaultOption = promptData.options.find(o => o.isDefault);
      if (defaultOption) {
        body.defaultOptionNumber = defaultOption.number;
      }
      // Issue #616: Include submitMode if present
      if (promptData.submitMode) {
        body.submitMode = promptData.submitMode;
      }
    }
  }

  return body;
}
