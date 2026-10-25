/**
 * Issue #3881 (the second half, review item (5a)): a deny target cut at
 * MAX_DENY_MATCH_TEXT_LENGTH is not the whole request.
 *
 * The resolver matches deny patterns over the head of each field (the bound
 * keeps a pathological pane from making every poll scan megabytes). A pattern
 * whose only occurrence is past the bound missed, and the miss passed — the
 * same error as an approval target cut at its 12-row cap (H-3), which already
 * withholds. Now a miss over a cut field withholds as `deny-pattern-unusable`
 * with no pattern named.
 *
 * Positive control (fails before): the pattern past the bound withholds.
 * Negative controls: a match inside the head is still `deny-pattern` with its
 * pattern; a field at exactly the bound is not cut; no deny pattern, nothing
 * to miss; the hook's structured call (the same function) follows.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_DENY_MATCH_TEXT_LENGTH,
  evaluatePolicyAgainstTexts,
  resolveAutoAnswerWithPolicy,
  type AutoYesPolicy,
} from '@/lib/polling/auto-yes-resolver';
import type { YesNoPromptData } from '@/types/models';

const yesNo: YesNoPromptData = { type: 'yes_no', question: 'Proceed?', options: ['yes', 'no'], status: 'pending' };

function policy(denyPatterns: string[]): AutoYesPolicy {
  return { mode: null, allowPromptTypes: [], denyPatterns };
}

describe('[#3881 (5a)] a field cut at the bound is not a pass', () => {
  it('a pattern only past the bound: deny-pattern-unusable, no pattern named', () => {
    const resolution = resolveAutoAnswerWithPolicy(
      { ...yesNo, approvalTarget: `${'x'.repeat(MAX_DENY_MATCH_TEXT_LENGTH)} rm -rf /` },
      policy(['rm -rf']),
    );
    expect(resolution).toEqual({ answer: null, suppressedBy: 'deny-pattern-unusable', pattern: undefined });
  });

  it('a cut field withholds even when the pattern is nowhere at all (the tail was never shown)', () => {
    const resolution = resolveAutoAnswerWithPolicy(
      { ...yesNo, question: `${'x'.repeat(MAX_DENY_MATCH_TEXT_LENGTH + 1)}?` },
      policy(['git push']),
    );
    expect(resolution.suppressedBy).toBe('deny-pattern-unusable');
  });

  it('the hook path reaches the same verdict on the same texts', () => {
    expect(
      evaluatePolicyAgainstTexts('multiple_choice', [`${'x'.repeat(MAX_DENY_MATCH_TEXT_LENGTH)}rm -rf`], policy(['rm -rf'])),
    ).toEqual({ reason: 'deny-pattern-unusable' });
  });
});

describe('[#3881 (5a)] what does not change (negative)', () => {
  it('a match inside the head is still deny-pattern, with its pattern', () => {
    const resolution = resolveAutoAnswerWithPolicy(
      { ...yesNo, approvalTarget: `rm -rf / ${'x'.repeat(MAX_DENY_MATCH_TEXT_LENGTH)}` },
      policy(['rm -rf']),
    );
    expect(resolution).toEqual({ answer: null, suppressedBy: 'deny-pattern', pattern: 'rm -rf' });
  });

  it('a field of exactly the bound is whole', () => {
    const resolution = resolveAutoAnswerWithPolicy(
      { ...yesNo, approvalTarget: 'x'.repeat(MAX_DENY_MATCH_TEXT_LENGTH) },
      policy(['rm -rf']),
    );
    expect(resolution).toEqual({ answer: 'y', suppressedBy: null });
  });

  it('no deny pattern: nothing to miss, answered', () => {
    const long = { ...yesNo, approvalTarget: 'x'.repeat(MAX_DENY_MATCH_TEXT_LENGTH * 2) };
    expect(resolveAutoAnswerWithPolicy(long, policy([])).answer).toBe('y');
    expect(resolveAutoAnswerWithPolicy(long).answer).toBe('y');
  });
});
