/**
 * Pure helpers shared by the answer surfaces (`PromptPanel`, `MobilePromptSheet`).
 */

import type { useTranslations } from 'next-intl';
import type { LivePromptData } from '@/types/models';
import { isMultiSelectPrompt as isMultiSelectPromptData } from '@/lib/prompt-answer-semantic';
import { derivePromptView, promptHeadingMessage, type PromptViewHeading } from '@/lib/session/prompt-view';
import { isAutoYesAnswering, type AutoYesDecisionPublished } from '@/types/auto-yes-decision';

/**
 * Which question the panel is currently showing (Issue #2755).
 *
 * One `AskUserQuestion` call carries several questions and the picker walks
 * them **in the same card**: answering question 1 repaints the pane with
 * question 2 and the poller hands the new payload to a component that was never
 * unmounted. Both surfaces initialised their selection in a `useState`
 * initialiser, which runs once, so question 2 opened with question 1's ticks
 * already on it — and on a checkbox screen those ticks are an answer.
 *
 * So the state is reset when the QUESTION changes and left alone otherwise. The
 * key is what identifies a question and nothing else: its text, its position in
 * the call, and its option numbers and labels. Deliberately NOT `checked` or
 * `isDefault` — those move on every poll as the operator ticks boxes and walks
 * the cursor in the terminal, and keying on them would throw away a selection
 * being made right now, which is the other half of what this Issue asks for.
 */
export function promptQuestionKey(promptData: LivePromptData): string {
  const parts: string[] = [promptData.question];
  if (promptData.type === 'multiple_choice') {
    parts.push(String(promptData.askUserQuestion?.questionIndex ?? ''));
    for (const option of promptData.options) parts.push(`${option.number}:${option.label}`);
  }
  return parts.join('\u0000');
}

/** The single-select cursor row, which is the panel's initial radio selection. */
export function initialSelectedOption(promptData: LivePromptData): number | null {
  if (promptData.type !== 'multiple_choice') return null;
  // A checkbox question has no single selection to pre-fill: its initial state
  // is the set of boxes the pane already shows as ticked.
  if (promptData.multiSelect === true) return null;
  return promptData.options.find((opt) => opt.isDefault)?.number ?? null;
}

/**
 * The boxes the terminal already shows as ticked (Issue #2755).
 *
 * The panel opens on the screen's own state rather than on nothing, because the
 * answer it sends is the FINAL set and the sender reaches it by toggling the
 * difference. Opening empty would offer the operator a "select nothing" they
 * did not ask for, and sending it would untick what they had ticked at the pane.
 */
export function initialCheckedNumbers(promptData: LivePromptData): number[] {
  if (promptData.type !== 'multiple_choice' || promptData.multiSelect !== true) return [];
  return promptData.options.filter((opt) => opt.checked === true).map((opt) => opt.number);
}

/**
 * The heading above the prompt (Issue #3181, #3184): the view's heading in the
 * user's locale. With addressable choices underneath it must not say the
 * options could not be read — the view only says `unreadable` when there are
 * none.
 */
export function promptHeadingText(
  t: ReturnType<typeof useTranslations>,
  heading: PromptViewHeading
): string {
  const message = promptHeadingMessage(heading);
  if ('text' in message) return message.text;
  return 'values' in message ? t(message.key, message.values) : t(message.key);
}

/**
 * Is this a CHECKBOX question? (Issue #2755)
 *
 * The same predicate `TerminalSplitPaneContent` applies to its own Auto-Yes
 * gate, restated here for the phone sheet. It is the one prompt shape Auto-Yes
 * never answers — `resolveBaseAnswer` returns null, because a digit ticks a box
 * and the confirm is a separate row — so hiding its sheet under Auto-Yes left a
 * live question answerable by nobody.
 */
export function isMultiSelectPrompt(promptData: LivePromptData | null | undefined): boolean {
  // Issue #3397: the reading Auto-Yes refuses on (`resolveBaseAnswer`), so the
  // panel is shown for exactly the lists it will not answer — the flag, or
  // labels that wear a checkbox.
  return promptData?.type === 'multiple_choice' && isMultiSelectPromptData(promptData);
}

/**
 * Is this a question the agent asked over its API (OpenCode / V2's structured
 * `question`)? Issue #3821: Auto-Yes answers permissions, never the operator's
 * questions, so its window is drawn whatever Auto-Yes is doing.
 */
export function isApiQuestionPrompt(promptData: LivePromptData | null | undefined): boolean {
  const view = derivePromptView(promptData);
  return view?.kind === 'api-choices' && view.heading.kind === 'agent-question';
}

/**
 * Whether the prompt window is drawn while Auto-Yes is on.
 *
 * Issue #3821: for every prompt Auto-Yes is not answering right now — the
 * window stays hidden only while the server's decision about this prompt
 * (`autoYesDecision`) says `answering`. `withheld` (the contract, a screen it
 * cannot read, no poller for the instance, …), `none` (not judged yet) and no
 * decision at all (a server older than the field) draw it, so a confirmation
 * Auto-Yes leaves alone is never left with no way to answer it.
 *
 * Drawn whatever the decision says: a checkbox question (Issue #2755 — the
 * base rules never answer one), a screen CommandMate cannot read
 * (`answerable === false`, the status API's `promptAnswerable`, #3397) and a
 * question asked over the agent's API.
 */
export function showsPromptUnderAutoYes(
  promptData: LivePromptData | null | undefined,
  answerable: boolean | undefined,
  decision: Pick<AutoYesDecisionPublished, 'state'> | null | undefined,
): boolean {
  return (
    isMultiSelectPrompt(promptData) ||
    answerable === false ||
    isApiQuestionPrompt(promptData) ||
    !isAutoYesAnswering(decision)
  );
}
