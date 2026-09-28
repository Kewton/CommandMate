/**
 * The approval verdicts in the words of the tool that asked (Issue #2951).
 *
 * `structuredDecisionOptionsFor` is what `capture --json` publishes and what
 * `respond` matches a label against. OpenCode V2 draws `Always allow`; v1 and
 * every other tool keep the shared list — same object, same labels.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  STRUCTURED_DECISION_OPTIONS,
  structuredDecisionOptionsFor,
} from '@/lib/session/structured-prompt';
import { resolveStructuredDecisionOption } from '@/lib/hooks/structured-decision-response';
import {
  isQuestionFreeTextNumeric,
  QUESTION_FREE_TEXT_MAX_LENGTH,
  readQuestionFreeText,
} from '@/components/worktree/prompt-decision-id';

describe('structuredDecisionOptionsFor', () => {
  it('OpenCode V2: `Allow once / Always allow / Reject`, numbers and replies unchanged', () => {
    expect(structuredDecisionOptionsFor('opencode-v2')).toEqual([
      { number: 1, label: 'Allow once', reply: 'once' },
      { number: 2, label: 'Always allow', reply: 'always' },
      { number: 3, label: 'Reject', reply: 'reject' },
    ]);
  });

  it.each(['opencode', 'claude', 'codex'] as const)('%s: the shared list itself', (tool) => {
    expect(structuredDecisionOptionsFor(tool)).toBe(STRUCTURED_DECISION_OPTIONS);
  });
});

describe('resolveStructuredDecisionOption with a tool', () => {
  it.each(['Always allow', 'ALWAYS ALLOW', 'Allow always', 'always', '2'])(
    'OpenCode V2 resolves `%s` to 2, labelled `Always allow`',
    (answer) => {
      expect(resolveStructuredDecisionOption(answer, 'opencode-v2')).toEqual({
        number: 2,
        label: 'Always allow',
        reply: 'always',
      });
    }
  );

  it('v1 resolves `Allow always` exactly as before', () => {
    expect(resolveStructuredDecisionOption('Allow always', 'opencode')).toEqual(
      STRUCTURED_DECISION_OPTIONS[1]
    );
    expect(resolveStructuredDecisionOption('Allow always')).toEqual(STRUCTURED_DECISION_OPTIONS[1]);
  });

  it("v1 does not learn v2's spelling", () => {
    expect(resolveStructuredDecisionOption('Always allow', 'opencode')).toBeNull();
    expect(resolveStructuredDecisionOption('Always allow')).toBeNull();
  });

  it('OpenCode V2 still refuses what is no verdict', () => {
    expect(resolveStructuredDecisionOption('maybe', 'opencode-v2')).toBeNull();
    expect(resolveStructuredDecisionOption('4', 'opencode-v2')).toBeNull();
  });
});

describe('readQuestionFreeText', () => {
  it('answers the trimmed text', () => {
    expect(readQuestionFreeText('  purple ')).toBe('purple');
  });

  it('refuses empty, over-long and digits-only text', () => {
    expect(readQuestionFreeText('   ')).toBeNull();
    expect(readQuestionFreeText('x'.repeat(QUESTION_FREE_TEXT_MAX_LENGTH + 1))).toBeNull();
    expect(readQuestionFreeText('2')).toBeNull();
    expect(readQuestionFreeText('1, 3')).toBeNull();
    expect(isQuestionFreeTextNumeric(' 1,3 ')).toBe(true);
  });

  it('allows text that merely contains digits', () => {
    expect(readQuestionFreeText('2 apples')).toBe('2 apples');
    expect(isQuestionFreeTextNumeric('2 apples')).toBe(false);
  });
});
