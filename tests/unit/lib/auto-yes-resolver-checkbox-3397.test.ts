/**
 * Plain Auto-Yes leaves every checkbox list alone (Issue #3397, review round 3).
 *
 * The sender answers a list whose labels wear boxes with Space→Next→Enter
 * (`hasCheckboxOptions`, `prompt-answer-semantic`), so a default number from
 * the resolver would tick that option and SUBMIT the list. The resolver used to
 * refuse only `multiSelect === true`; it now refuses through the same
 * `isMultiSelectPrompt` the sender and the Enter exclusion read. The panels'
 * Auto-Yes gate (`components/worktree/prompt-answer`) shows exactly those
 * lists, so a list Auto-Yes refuses is never hidden from the human.
 */

import { describe, it, expect } from 'vitest';
import { resolveAutoAnswer, resolveAutoAnswerWithPolicy } from '@/lib/polling/auto-yes-resolver';
import { isMultiSelectPrompt, showsPromptUnderAutoYes } from '@/components/worktree/prompt-answer';
import type { MultipleChoicePromptData } from '@/types/models';

function list(labels: string[], extra: Partial<MultipleChoicePromptData> = {}): MultipleChoicePromptData {
  return {
    type: 'multiple_choice',
    question: 'Select tools:',
    options: labels.map((label, i) => ({ number: i + 1, label, isDefault: i === 0 })),
    status: 'pending',
    ...extra,
  };
}

const BOXES = ['[ ]', '[x]', '[X]', '[✔]'];

describe('[#3397] resolveAutoAnswer and checkbox labels', () => {
  it.each(BOXES)('labels boxed %s, no multiSelect flag: no answer', (box) => {
    const prompt = list([`${box} Option A`, `${box} Option B`]);
    expect(resolveAutoAnswer(prompt)).toBeNull();
    // Not a policy verdict: nothing is recorded as withheld.
    expect(resolveAutoAnswerWithPolicy(prompt)).toEqual({ answer: null, suppressedBy: null });
  });

  it('the multiSelect flag alone: no answer, as before (#2755)', () => {
    expect(resolveAutoAnswer(list(['Option A', 'Option B'], { multiSelect: true }))).toBeNull();
  });

  it('control: a list without boxes is answered with its default, as before', () => {
    expect(resolveAutoAnswer(list(['Option A', 'Option B']))).toBe('1');
  });

  it('control: a box later in the label is not a checkbox', () => {
    expect(resolveAutoAnswer(list(['Use [x] notation', 'Other']))).toBe('1');
  });
});

describe('[#3397] the panels show what Auto-Yes refuses', () => {
  it.each(BOXES)('%s labels: shown under Auto-Yes', (box) => {
    const prompt = list([`${box} Option A`, `${box} Option B`]);
    expect(isMultiSelectPrompt(prompt)).toBe(true);
    expect(showsPromptUnderAutoYes(prompt, undefined)).toBe(true);
  });

  it('an unreadable screen: shown under Auto-Yes', () => {
    expect(showsPromptUnderAutoYes(list(['Option A', 'Option B']), false)).toBe(true);
  });

  it.each([[true], [undefined]])('a readable single choice (answerable %s): hidden under Auto-Yes', (answerable) => {
    expect(showsPromptUnderAutoYes(list(['Option A', 'Option B']), answerable)).toBe(false);
  });
});
