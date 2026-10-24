/**
 * The one place a prompt's screen is read as a kind of dialog for storage
 * (Issue #3881).
 *
 * The response poller saves a `prompt` row from a frame it has in hand; every
 * later reader — the chat transcript above all — has only the row's cut-down
 * `question` and `options`. Deciding "question, permission or confirmation
 * page?" from those again is what drew Claude's 16-column confirm page as a
 * tool approval: its option 1 wraps (`Submit` / `answers`), so the stored
 * option is `Submit`, and the review list is above the five rows the stored
 * question keeps. So the kind is read here, from the frame, with the same
 * predicates the Auto-Yes poller acts on, and stored as `promptData.reading`.
 *
 * What is evidence, in order:
 *
 *  1. the tool's confirm-page reader (`isAutoYesDeclinedConfirmFrame`, the
 *     predicate behind the poller's `question-confirm-page`) — `confirmation`;
 *  2. a question reader's picker chrome (`isAskUserQuestion`) — `question`;
 *  3. rows that read as a permission dialog's effects
 *     (`selectAllowOnceOption`, the resolver's own reading) — `permission`;
 *  4. a yes/no confirmation pattern — `permission`;
 *  5. nothing — `unknown`, which is not "not a question".
 *
 * Server-only: the confirm-page reader reaches `logger` → `env` → `fs`. The
 * client reads what this wrote through `lib/detection/prompt-reading`.
 *
 * Which tools' screens carry more evidence (agy's receipt-backed lists,
 * copilot's and codex's questions) is the second half of #3881; this module is
 * where it goes, and `tests/unit/guards/prompt-reading-sites-3881.test.ts`
 * keeps it the only place.
 *
 * @module lib/polling/prompt-screen-reading
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type { PromptDetectionResult } from '@/lib/detection/types';
import type { PromptData } from '@/types/models';
import {
  PROMPT_READING_VERSION,
  type PromptReading,
  type PromptReadingEvidence,
} from '@/types/prompt-reading';
import { isAutoYesDeclinedConfirmFrame } from './auto-yes-confirm-page';
import { selectAllowOnceOption } from './auto-yes-option-effect';

/**
 * Read the prompt's screen as a kind of dialog.
 *
 * @param cliToolId - The tool that drew the frame
 * @param frame - The capture the prompt was detected on (ANSI and box drawing
 *   as captured), or null when the caller has none — then no confirm page can
 *   be read off it
 * @param detection - The detection of that frame
 * @returns The reading, or null when the detection carries no prompt
 */
export function readPromptScreen(
  cliToolId: CLIToolType,
  frame: string | null,
  detection: PromptDetectionResult,
): PromptReading | null {
  const promptData = detection.promptData;
  if (!promptData) return null;

  const context = detection.approvalContext;
  const base = {
    version: PROMPT_READING_VERSION,
    ...(context ? { liveRange: { startRow: context.startRow, endRow: context.endRow } } : {}),
    approvalTarget: context?.completeness ?? ('not-measured' as const),
  };

  if (isAutoYesDeclinedConfirmFrame(cliToolId, frame)) {
    return { ...base, kind: 'confirmation', phase: 'confirmation', evidence: ['confirm-page-reader'] };
  }

  if (promptData.type === 'multiple_choice' && promptData.isAskUserQuestion === true) {
    const evidence: PromptReadingEvidence[] = ['question-picker-chrome'];
    if (promptData.askUserQuestion !== undefined) evidence.push('ask-user-question-payload');
    return { ...base, kind: 'question', phase: 'question', evidence };
  }

  if (promptData.type === 'multiple_choice') {
    return selectAllowOnceOption(promptData.options, cliToolId).kind === 'not-a-permission-dialog'
      ? { ...base, kind: 'unknown', evidence: [] }
      : { ...base, kind: 'permission', evidence: ['permission-option-effect'] };
  }

  return { ...base, kind: 'permission', evidence: ['yes-no-pattern'] };
}

/**
 * The `promptData` a `prompt` row is saved with: the detection's, with what
 * {@link readPromptScreen} read stored beside it. Undefined when the detection
 * carries none, exactly as before.
 */
export function promptDataForStorage(
  cliToolId: CLIToolType,
  frame: string | null,
  detection: PromptDetectionResult,
): PromptData | undefined {
  const reading = readPromptScreen(cliToolId, frame, detection);
  if (!detection.promptData || reading === null) return detection.promptData;
  return { ...detection.promptData, reading };
}
