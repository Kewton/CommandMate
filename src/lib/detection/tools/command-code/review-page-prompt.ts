/**
 * The Review page prompt's identity and the answers it takes (Issue #4313 (b)
 * and 再指示 1), with no reader attached.
 *
 * Kept apart from `./dialog` on purpose: `prompt-answer-semantic` (which the
 * browser's `useAutoYes` imports) needs the predicate, and `./dialog` reaches
 * the logger through its imports (`use-auto-yes-client-imports-3748`). This
 * module imports types only.
 *
 * @module lib/detection/tools/command-code/review-page-prompt
 */

import type { MultipleChoicePromptData, PromptData } from '@/types/models';

/** The question the Review page prompt is published with (fixed text, no frame content). */
export const COMMAND_CODE_REVIEW_PAGE_QUESTION = 'Submit your answers?';

/**
 * The answers the Review page takes: `1` (Submit) and `2` (Cancel), nothing
 * else (Issue #4313 再指示 1). A third digit is not a row on the page, and
 * typed at it (`answer_only`) it is an unmeasured key at a page whose `Enter`
 * sends the answers — so every other answer is refused before any key.
 */
export const COMMAND_CODE_REVIEW_PAGE_ANSWERS: readonly string[] = ['1', '2'];

/**
 * Is this the payload `readCommandCodeReviewPagePrompt` (`./dialog`) publishes
 * (Issue #4313 (b))? Judged on the payload's own fixed question and its two
 * labels, so no other prompt of any tool is taken for it. Shared by the
 * sender's Review arm and the answer resolution that refuses anything but
 * {@link COMMAND_CODE_REVIEW_PAGE_ANSWERS} there.
 */
export function isCommandCodeReviewPagePrompt(
  promptData: PromptData | null | undefined,
): promptData is MultipleChoicePromptData {
  return promptData?.type === 'multiple_choice'
    && promptData.question === COMMAND_CODE_REVIEW_PAGE_QUESTION
    && promptData.options.length === 2
    && promptData.options[0].label === 'Submit'
    && promptData.options[1].label === 'Cancel';
}
