/**
 * Options whose answer continues as typed text (Issue #3093).
 *
 * "No, tell Command Code what to do differently" — and claude's / codex's
 * "No, and tell … what to do differently" — is a MENU row: it is chosen by its
 * number (#2573), and choosing it closes the dialog and leaves the agent waiting
 * for the reason in its ordinary input box. There is no dialog left for a second
 * `respond` to answer, so the reason sent that way came back
 * `prompt_no_longer_active` while `send` delivered it fine.
 *
 * Of the two ways out — send the choice and the text in one call, or say after
 * the choice that the text goes through `send` — this module is the second: the
 * screen after the choice differs per tool and is not something the route can
 * verify before typing, whereas `send` already handles that screen (it is the
 * composer). So a successful answer that picked such a row carries a
 * `textFollowUp` naming the row and the next step.
 *
 * @module app/api/worktrees/[id]/prompt-response/text-follow-up
 */

import type { PromptData } from '@/types/models';
import { isTypedTextFieldOption } from '@/lib/detection/prompt-detect-multiple-choice';

/**
 * The measured wording of a "decline and explain" row. Narrower than the
 * detector's `requiresTextInput` patterns on purpose: those also match `custom`
 * or `enter …` inside the command an approval row quotes, and a hint attached to
 * "Yes, don't ask again for 'npm run custom'" would be wrong.
 */
const TELL_DIFFERENTLY_PATTERN = /\btell\b[^\n]*\bwhat to do differently\b/i;

/** What the route adds to a successful answer that picked such a row. */
export interface TextFollowUp {
  optionNumber: number;
  optionLabel: string;
  message: string;
}

/**
 * The follow-up for `input` against `promptData`, or null when the chosen
 * option does not continue as text (or no single option was chosen).
 *
 * @param promptData - The prompt the answer was verified against
 * @param input - What was sent: an option number for a menu answer
 */
export function findTextFollowUp(
  promptData: PromptData | null | undefined,
  input: string,
): TextFollowUp | null {
  if (!promptData || promptData.type !== 'multiple_choice') return null;
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const option = promptData.options.find((candidate) => candidate.number === Number(trimmed));
  if (!option) return null;
  // A real text field (Command Code's `Type something...`) took the text as the
  // answer already; only a menu row hands the text on to the composer.
  if (isTypedTextFieldOption(option)) return null;
  if (!TELL_DIFFERENTLY_PATTERN.test(option.label)) return null;
  return {
    optionNumber: option.number,
    optionLabel: option.label,
    message:
      `Option ${option.number} asks for your text next. The dialog is closed now, so \`respond\` ` +
      'cannot deliver it (it would report prompt_no_longer_active) — send the text with ' +
      '`commandmate send <worktree-id> "<text>"`.',
  };
}
