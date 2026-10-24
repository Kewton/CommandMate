/**
 * Which prompt a screen shows, as one string (Issue #3706, moved here by #3798).
 *
 * Written for the Auto-Yes poller's stopped answers (`partialAnswerScreenKey`,
 * which `polling/auto-yes-poller-state` still re-exports under that name). The
 * waiting episodes (Issue #3798) need the same question — "is this frame the
 * confirmation that wait closed on, or another one?" — from the session layer,
 * which must not reach into `polling/`, so the reading lives in the detection
 * layer both can import.
 *
 * @module lib/detection/prompt-screen-key
 */

import type { PromptData } from '@/types/models';
import { generatePromptKey } from './prompt-key';
import { approvalTargetWithOptionRowsAligned } from '../prompt-observation/appearance';

/**
 * Which prompt a stopped answer is about (Issue #3706): the type, the question,
 * the option labels and `approvalTarget` — what `promptFrameKey` (auto-yes-poller-state) tells
 * apart — but NOT where the cursor is. The keys that were sent may have moved
 * the cursor themselves (a `Down` whose Enter was withheld), and that must not
 * make the same list read as a new one; a different list or a different command
 * under the same question is a new prompt and is answered.
 */
export function promptScreenKey(promptData: PromptData): string {
  const options =
    promptData.type === 'multiple_choice'
      ? promptData.options.map((o) => `${o.number}.${o.label}`).join('\n')
      : promptData.options.join('\n');
  return [generatePromptKey(promptData), options, withoutCursorMarks(promptData)].join('\u0000');
}

/**
 * `approvalTarget` with the cursor taken out: the generic parser copies the
 * option panel into it, `❯` row included, so a moved cursor would otherwise
 * read as another prompt.
 *
 * [Issue #3817] Only the rows the block reader adopted as the options are
 * aligned (`approvalTargetWithOptionRowsAligned`, the reading #3812 gives the
 * strict respond), so two commands whose bodies differ by an indent or a `>`
 * are two screens. A label the block reader read may run longer than the
 * prompt's — it folds wrapped rows and the footer in — so it only has to start
 * with it. A yes/no prompt has no cursor and is read as it is. A list whose
 * rows cannot be told that way keeps the old reading below: two bodies then
 * read as one screen, which holds the prompt for a human rather than typing
 * the answer twice.
 */
function withoutCursorMarks(promptData: PromptData): string {
  const target = promptData.approvalTarget ?? '';
  if (promptData.type !== 'multiple_choice') return target;
  const aligned = approvalTargetWithOptionRowsAligned(
    target,
    promptData.options.map((o) => o.label),
    (read, named) => read.startsWith(named),
  );
  return aligned ?? withoutLeadingMarks(target);
}

/** Every row's leading marks and indentation taken out (the reading before #3817). */
function withoutLeadingMarks(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^[\s❯›>▶►●○◉→]+/u, ''))
    .join('\n');
}
