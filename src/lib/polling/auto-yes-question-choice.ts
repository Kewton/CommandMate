/**
 * Which option Auto-Yes answers a question with under the `recommended`
 * answer mode (Issue #3863).
 *
 * Only the choice among a question's options. Whether the screen is a
 * question at all (`classifyAutoYesQuestion`), whether the mode lets Auto-Yes
 * answer it, and what the contract allows are decided elsewhere; a permission
 * dialog keeps #3822's rule (the one "allow this call once" row) and never
 * reaches this.
 *
 * The rule (the user's decision of 2026-10-24):
 *
 * - exactly one option's title ends in a recommendation marker → that option,
 *   wherever it is in the list and wherever the cursor is;
 * - no option is recommended (every reading `false`) → the default: the
 *   cursor's option, else option 1;
 * - otherwise nothing is chosen: an option whose title could not be told from
 *   its description (`'unknown'`, or no reading at all), two or more
 *   recommended options, a chosen option that takes typed text, or a
 *   multi-select question.
 *
 * Client-safe: no server-only imports (the resolver that calls it is walked by
 * the client-import guard).
 *
 * @module lib/polling/auto-yes-question-choice
 */

import type { MultipleChoiceOption } from '@/types/models';
import type { OptionRecommendation } from '@/lib/detection/option-recommendation';

/** The outcome of {@link chooseRecommendedOption}. */
export type RecommendedOptionChoice =
  | { kind: 'chosen'; option: MultipleChoiceOption; basis: 'recommended' | 'default' }
  | { kind: 'unidentified'; cause: 'unknown-title' | 'several-recommended' | 'typed-text' | 'multi-select' | 'no-options' };

/**
 * Choose a question's answer under the `recommended` mode.
 *
 * @param options - The question's options, as the reader read them
 * @param recommendations - Per option, what its title says (`PromptDetectionResult.optionRecommendations`);
 *   absent or of another length reads as `'unknown'` for every option
 * @param multiSelect - Whether the question takes several answers
 */
export function chooseRecommendedOption(
  options: readonly MultipleChoiceOption[],
  recommendations: readonly OptionRecommendation[] | undefined,
  multiSelect: boolean,
): RecommendedOptionChoice {
  if (multiSelect) return { kind: 'unidentified', cause: 'multi-select' };
  if (options.length === 0) return { kind: 'unidentified', cause: 'no-options' };
  if (recommendations === undefined || recommendations.length !== options.length) {
    return { kind: 'unidentified', cause: 'unknown-title' };
  }
  if (recommendations.some((value) => value === 'unknown')) return { kind: 'unidentified', cause: 'unknown-title' };

  const recommended = options.filter((_, index) => recommendations[index] === true);
  if (recommended.length > 1) return { kind: 'unidentified', cause: 'several-recommended' };

  const [option, basis] =
    recommended.length === 1
      ? [recommended[0], 'recommended' as const]
      : [options.find((candidate) => candidate.isDefault) ?? options[0], 'default' as const];
  if (option.requiresTextInput) return { kind: 'unidentified', cause: 'typed-text' };
  return { kind: 'chosen', option, basis };
}
