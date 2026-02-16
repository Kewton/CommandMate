/**
 * Shared prompt answer sender for cursor-key and text-based tmux input.
 *
 * Issue #287 Bug2: Extracted from route.ts and auto-yes-manager.ts to
 * eliminate code duplication and ensure consistent behavior (including
 * the promptType/defaultOptionNumber fallback introduced in Bug1).
 */

import { sendKeys, sendSpecialKeys } from './tmux';
import type { CLIToolType } from './cli-tools/types';
import type { PromptData, PromptType } from '@/types/models';

/** Regex pattern to detect checkbox-style multi-select options */
const CHECKBOX_OPTION_PATTERN = /^\[[ x]\] /;

/**
 * Build navigation key array for cursor movement.
 * @param offset - positive = Down, negative = Up
 */
function buildNavigationKeys(offset: number): string[] {
  if (offset === 0) return [];
  const direction = offset > 0 ? 'Down' : 'Up';
  return Array.from({ length: Math.abs(offset) }, () => direction);
}

export interface SendPromptAnswerParams {
  sessionName: string;
  answer: string;
  cliToolId: CLIToolType;
  promptData?: PromptData;
  /** Fallback prompt type from client (only available in route.ts path) */
  fallbackPromptType?: PromptType;
  /** Fallback default option number from client (only available in route.ts path) */
  fallbackDefaultOptionNumber?: number;
}

/**
 * Send an answer to a tmux session, using cursor-key navigation for
 * Claude Code multiple-choice prompts and text input for everything else.
 *
 * This function unifies the logic previously duplicated in:
 * - src/app/api/worktrees/[id]/prompt-response/route.ts (L114-187)
 * - src/lib/auto-yes-manager.ts (L340-399)
 */
export async function sendPromptAnswer(params: SendPromptAnswerParams): Promise<void> {
  const { sessionName, answer, cliToolId, promptData, fallbackPromptType, fallbackDefaultOptionNumber } = params;

  // Determine if this is a Claude Code multiple-choice prompt requiring cursor navigation
  const isClaudeMultiChoice = cliToolId === 'claude'
    && (promptData?.type === 'multiple_choice' || fallbackPromptType === 'multiple_choice')
    && /^\d+$/.test(answer);

  if (isClaudeMultiChoice) {
    const targetNum = parseInt(answer, 10);

    let defaultNum: number;
    let mcOptions: Array<{ number: number; label: string; isDefault?: boolean }> | null = null;

    if (promptData?.type === 'multiple_choice') {
      // Primary path: use fresh promptData
      mcOptions = promptData.options;
      const defaultOption = mcOptions.find(o => o.isDefault);
      defaultNum = defaultOption?.number ?? 1;
    } else {
      // Fallback path (Issue #287): promptData is undefined or type mismatch, use fallback fields
      defaultNum = fallbackDefaultOptionNumber ?? 1;
    }

    const offset = targetNum - defaultNum;

    // Detect multi-select (checkbox) prompts by checking for [ ] in option labels.
    // Multi-select prompts require: Space to toggle checkbox -> navigate to "Next" -> Enter.
    // Single-select prompts require: navigate to option -> Enter.
    // Note: multi-select detection is only possible when promptData succeeded (mcOptions available).
    const isMultiSelect = mcOptions !== null && mcOptions.some(o => CHECKBOX_OPTION_PATTERN.test(o.label));

    if (isMultiSelect && mcOptions !== null) {
      // Multi-select: toggle checkbox, then navigate to "Next" and submit
      const checkboxCount = mcOptions.filter(o => CHECKBOX_OPTION_PATTERN.test(o.label)).length;
      const keys: string[] = [
        ...buildNavigationKeys(offset),  // 1. Navigate to target option
        'Space',                          // 2. Toggle checkbox
      ];
      // 3. Navigate to "Next" button (positioned right after all checkbox options)
      const downToNext = checkboxCount - targetNum + 1;
      keys.push(...buildNavigationKeys(downToNext));
      // 4. Enter to submit
      keys.push('Enter');
      await sendSpecialKeys(sessionName, keys);
    } else {
      // Single-select: navigate and Enter to select
      const keys: string[] = [
        ...buildNavigationKeys(offset),
        'Enter',
      ];
      await sendSpecialKeys(sessionName, keys);
    }
  } else {
    // Standard CLI prompt: send text + Enter (y/n, Approve?, etc.)
    await sendKeys(sessionName, answer, false);

    // Wait a moment for the input to be processed
    await new Promise(resolve => setTimeout(resolve, 100));

    // Send Enter
    await sendKeys(sessionName, '', true);
  }
}
