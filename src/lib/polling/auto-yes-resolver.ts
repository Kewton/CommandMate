/**
 * Auto Yes Resolver - Determines automatic answer for prompt data
 *
 * Rules:
 * - yes/no prompt -> 'y'
 * - multiple_choice with default option -> default option number
 * - multiple_choice without default -> first option number
 * - option requiring text input -> null (skip)
 * - unknown type -> null (skip)
 */

import type { PromptData } from '@/types/models';

/**
 * Resolve the automatic answer for a given prompt
 * @returns The answer string to send, or null if auto-answer is not possible
 */
export function resolveAutoAnswer(promptData: PromptData): string | null {
  if (promptData.type === 'yes_no') {
    return 'y';
  }

  if (promptData.type === 'multiple_choice') {
    const defaultOpt = promptData.options.find(o => o.isDefault);
    const target = defaultOpt ?? promptData.options[0];

    if (!target) {
      return null;
    }

    if (target.requiresTextInput) {
      return null;
    }

    return target.number.toString();
  }

  return null;
}
