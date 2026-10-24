/**
 * Issue #3863: which option the `recommended` answer mode answers a question
 * with (`chooseRecommendedOption`), and the resolver that uses it.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { chooseRecommendedOption } from '@/lib/polling/auto-yes-question-choice';
import { resolveAutoAnswerWithPolicy } from '@/lib/polling/auto-yes-resolver';
import { isRecommendationMarker, isRecommendedTitle } from '@/lib/detection/option-recommendation';
import { findNumberedOptionBlock } from '@/lib/detection/tools/dialog-block';
import type { MultipleChoiceOption, MultipleChoicePromptData } from '@/types/models';

const options = (cursor = 1, freeText = 0): MultipleChoiceOption[] =>
  [1, 2, 3].map((number) => ({
    number,
    label: `Option ${number}`,
    isDefault: number === cursor,
    ...(number === freeText ? { requiresTextInput: true } : {}),
  }));

const question = (over: Partial<MultipleChoicePromptData> = {}): MultipleChoicePromptData => ({
  type: 'multiple_choice',
  question: 'Which approach?',
  status: 'pending',
  options: options(),
  isAskUserQuestion: true,
  ...over,
});

describe('[#3863] chooseRecommendedOption', () => {
  it('exactly one recommended: that one, wherever the cursor is', () => {
    expect(chooseRecommendedOption(options(1), [false, false, true], false)).toMatchObject({
      kind: 'chosen',
      option: { number: 3 },
      basis: 'recommended',
    });
  });

  it('none recommended: the cursor, else option 1', () => {
    expect(chooseRecommendedOption(options(2), [false, false, false], false)).toMatchObject({
      kind: 'chosen',
      option: { number: 2 },
      basis: 'default',
    });
    const noCursor = options().map((option) => ({ ...option, isDefault: false }));
    expect(chooseRecommendedOption(noCursor, [false, false, false], false)).toMatchObject({ option: { number: 1 } });
  });

  it.each([
    ['two recommended', options(), [true, true, false], false, 'several-recommended'],
    ['an unknown title', options(), [true, 'unknown', false], false, 'unknown-title'],
    ['no reading at all', options(), undefined, false, 'unknown-title'],
    ['a reading of another length', options(), [true, false], false, 'unknown-title'],
    ['the recommended option takes typed text', options(1, 2), [false, true, false], false, 'typed-text'],
    ['the default takes typed text', options(3, 3), [false, false, false], false, 'typed-text'],
    ['a multi-select question', options(), [true, false, false], true, 'multi-select'],
  ] as const)('%s: nothing is chosen (%s)', (_name, opts, recs, multiSelect, cause) => {
    expect(chooseRecommendedOption(opts, recs, multiSelect)).toEqual({ kind: 'unidentified', cause });
  });
});

describe('[#3863] the resolver answers a question under the recommended mode', () => {
  it('the recommended option, past the contract (no contract)', () => {
    expect(
      resolveAutoAnswerWithPolicy(question(), null, 'claude', { optionRecommendations: [false, true, false] }),
    ).toEqual({ answer: '2', suppressedBy: null });
  });

  it('withheld when it cannot be told', () => {
    expect(
      resolveAutoAnswerWithPolicy(question(), null, 'claude', { optionRecommendations: [true, true, false] }),
    ).toEqual({ answer: null, suppressedBy: 'recommended-option-unidentified' });
  });

  it('the contract still withholds what it withholds (deny pattern on an option label)', () => {
    expect(
      resolveAutoAnswerWithPolicy(
        question(),
        { mode: null, allowPromptTypes: [], denyPatterns: ['Option 3'] },
        'claude',
        { optionRecommendations: [false, true, false] },
      ),
    ).toMatchObject({ answer: null, suppressedBy: 'deny-pattern' });
  });

  it('negative: a question whose rows read as a permission keeps the allow-once rule', () => {
    const permission = question({
      options: [
        { number: 1, label: 'Yes, and always allow access to this folder (Recommended)', isDefault: true },
        { number: 2, label: 'Yes', isDefault: false },
        { number: 3, label: 'No', isDefault: false },
      ],
    });
    expect(
      resolveAutoAnswerWithPolicy(permission, null, 'claude', { optionRecommendations: [true, false, false] }).answer,
    ).not.toBe('1');
  });

  it('negative: without the question argument, the default as before', () => {
    expect(resolveAutoAnswerWithPolicy(question({ options: options(2) }), null, 'claude')).toEqual({
      answer: '2',
      suppressedBy: null,
    });
  });
});

describe('[#3863] the marker', () => {
  it.each([
    ['Prepare worktrees + dispatch (Recommended)', true],
    ['worktree を作って dispatch する（推奨）', true],
    ['プランで進める(推奨)', true],
    ['(Recommended)', true],
    ['Recommended', false],
    ['Not(Recommended)', false],
    ['(Recommended) first, then the rest', false],
    ['Use the (recommended) path', false],
  ] as const)('%j → %s', (title, expected) => {
    expect(isRecommendedTitle(title)).toBe(expected);
  });

  it('a row holding only a marker', () => {
    expect(isRecommendationMarker('    (Recommended)  ')).toBe(true);
    expect(isRecommendationMarker('    the plan (Recommended)')).toBe(false);
  });
});

describe('[#3863] the shared block reader', () => {
  it('reads a one-row option off its label, and an option with rows folded into it as unknown', () => {
    const block = findNumberedOptionBlock(
      ['Pick one', '❯ 1. Fast (Recommended)', '  2. Thorough', '     takes longer (Recommended)', '  3. None'],
      5,
    );
    expect(block?.options).toEqual(['Fast (Recommended)', 'Thorough takes longer (Recommended)', 'None']);
    expect(block?.optionRecommendations).toEqual([true, 'unknown', false]);
  });
});
