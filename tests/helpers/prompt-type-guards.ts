/**
 * Shared type guards for prompt detection test files.
 * Centralizes PromptData type narrowing used across prompt-detector
 * unit tests, integration tests, and acceptance tests.
 */

import { isAnswerablePromptData } from '@/types/models';
import type {
  PromptData,
  StoredPromptData,
  YesNoPromptData,
  MultipleChoicePromptData,
} from '@/types/models';

/**
 * The prompt on a stored row, when the row is an answerable one.
 *
 * Issue #1738: `ChatMessage.promptData` is {@link StoredPromptData} — the
 * `chat_messages.prompt_data` column also carries the degraded audit records of
 * #1708 and #1725, which have no `options` and no `answer`. Tests that mean
 * "this row is a real prompt, read its answer" say so through this helper; the
 * `undefined` it returns for a degraded row is the same `undefined` the old
 * `promptData?.answer` produced for a missing row, so assertions keep their
 * meaning.
 */
export function answerablePromptOf(
  data: StoredPromptData | null | undefined,
): PromptData | undefined {
  return isAnswerablePromptData(data) ? data : undefined;
}

/**
 * Type guard for MultipleChoicePromptData.
 * Narrows PromptData to MultipleChoicePromptData for type-safe access
 * to options array and other multiple_choice-specific fields.
 */
export function isMultipleChoicePrompt(data: PromptData | undefined): data is MultipleChoicePromptData {
  return data?.type === 'multiple_choice';
}

/**
 * Type guard for YesNoPromptData.
 * Narrows PromptData to YesNoPromptData for type-safe access
 * to defaultOption and other yes_no-specific fields.
 */
export function isYesNoPrompt(data: PromptData | undefined): data is YesNoPromptData {
  return data?.type === 'yes_no';
}
