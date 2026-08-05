import { describe, it, expect } from 'vitest';
import {
  MAX_DENY_MATCH_TEXT_LENGTH,
  MAX_DENY_PATTERN_LENGTH,
  resolveAutoAnswer,
  resolveAutoAnswerWithPolicy,
  type AutoYesPolicy,
} from '@/lib/polling/auto-yes-resolver';
import { MAX_PATTERN_LENGTH } from '@/lib/tasks/contract-parser';
import type { PromptData, YesNoPromptData, MultipleChoicePromptData } from '@/types/models';

describe('auto-yes-resolver', () => {
  describe('yes_no prompts', () => {
    it('should return "y" for yes/no prompts', () => {
      const promptData: YesNoPromptData = {
        type: 'yes_no',
        question: 'Do you want to proceed?',
        options: ['yes', 'no'],
        status: 'pending',
      };

      expect(resolveAutoAnswer(promptData)).toBe('y');
    });

    it('should return "y" regardless of default option', () => {
      const promptData: YesNoPromptData = {
        type: 'yes_no',
        question: 'Continue?',
        options: ['yes', 'no'],
        status: 'pending',
        defaultOption: 'no',
      };

      expect(resolveAutoAnswer(promptData)).toBe('y');
    });
  });

  describe('multiple_choice prompts', () => {
    it('should return default option number when available', () => {
      const promptData: MultipleChoicePromptData = {
        type: 'multiple_choice',
        question: 'Select an option:',
        options: [
          { number: 1, label: 'Option A', isDefault: false },
          { number: 2, label: 'Option B', isDefault: true },
          { number: 3, label: 'Option C', isDefault: false },
        ],
        status: 'pending',
      };

      expect(resolveAutoAnswer(promptData)).toBe('2');
    });

    it('should return first option number when no default', () => {
      const promptData: MultipleChoicePromptData = {
        type: 'multiple_choice',
        question: 'Select:',
        options: [
          { number: 1, label: 'Option A', isDefault: false },
          { number: 2, label: 'Option B', isDefault: false },
        ],
        status: 'pending',
      };

      expect(resolveAutoAnswer(promptData)).toBe('1');
    });

    it('should return null when default option requires text input', () => {
      const promptData: MultipleChoicePromptData = {
        type: 'multiple_choice',
        question: 'Select:',
        options: [
          { number: 1, label: 'Type here to explain', isDefault: true, requiresTextInput: true },
          { number: 2, label: 'Cancel', isDefault: false },
        ],
        status: 'pending',
      };

      expect(resolveAutoAnswer(promptData)).toBeNull();
    });

    it('should return null when first option requires text input and no default', () => {
      const promptData: MultipleChoicePromptData = {
        type: 'multiple_choice',
        question: 'Select:',
        options: [
          { number: 1, label: 'Enter custom value', isDefault: false, requiresTextInput: true },
          { number: 2, label: 'Cancel', isDefault: false },
        ],
        status: 'pending',
      };

      expect(resolveAutoAnswer(promptData)).toBeNull();
    });

    it('should return null when options array is empty', () => {
      const promptData: MultipleChoicePromptData = {
        type: 'multiple_choice',
        question: 'Select:',
        options: [],
        status: 'pending',
      };

      expect(resolveAutoAnswer(promptData)).toBeNull();
    });
  });

  describe('unknown prompt types', () => {
    it('should return null for unknown prompt types', () => {
      const promptData = {
        type: 'input',
        question: 'Enter a value:',
        status: 'pending',
      } as unknown as PromptData;

      expect(resolveAutoAnswer(promptData)).toBeNull();
    });
  });

  // =========================================================================
  // Issue #704: Claude v2.1.142 Use skill approval prompt
  //
  // Once prompt-detector returns the correct multiple_choice payload (1=Yes,
  // 2=Yes-and-dont-ask-again, 3=No, default=Yes), resolveAutoAnswer must
  // surface "1" so that Auto-Yes fires the Yes response.
  // =========================================================================
  describe('Issue #704: Use skill approval prompt', () => {
    it('should resolve to "1" (Yes) for the Use skill Yes/Yes2nd/No multiple_choice prompt', () => {
      const promptData: MultipleChoicePromptData = {
        type: 'multiple_choice',
        question: 'Use skill "multi-stage-issue-review"? Do you want to proceed?',
        options: [
          { number: 1, label: 'Yes', isDefault: true },
          { number: 2, label: 'Yes, and don\'t ask again for multi-stage-issue-review in <path>', isDefault: false },
          { number: 3, label: 'No', isDefault: false },
        ],
        status: 'pending',
      };

      expect(resolveAutoAnswer(promptData)).toBe('1');
    });
  });

  // =========================================================================
  // Issue #1547: execution-contract autoYes policy
  //
  // The policy can only ever withhold an answer the base rules produced. The
  // suppressing directions (off / safe / allow-listed / denyPatterns) are the
  // dangerous ones to get wrong in the *permissive* direction, so each has a
  // case asserting the answer is null, and the parity block below pins the
  // contract-less behaviour so existing users cannot be affected at all.
  // =========================================================================
  describe('Issue #1547: autoYes policy', () => {
    const yesNo: YesNoPromptData = {
      type: 'yes_no',
      question: 'Do you want to proceed?',
      options: ['yes', 'no'],
      status: 'pending',
    };

    const multipleChoice: MultipleChoicePromptData = {
      type: 'multiple_choice',
      question: 'Do you want to make this edit to useVirtualKeyboard.ts?',
      options: [
        { number: 1, label: 'Yes', isDefault: true },
        { number: 2, label: 'Yes, allow all edits during this session', isDefault: false },
        { number: 3, label: 'No', isDefault: false },
      ],
      status: 'pending',
    };

    const textInputOnly: MultipleChoicePromptData = {
      type: 'multiple_choice',
      question: 'Tell Claude what to do differently',
      options: [{ number: 1, label: 'Type here', isDefault: true, requiresTextInput: true }],
      status: 'pending',
    };

    const emptyOptions: MultipleChoicePromptData = {
      type: 'multiple_choice',
      question: 'Select:',
      options: [],
      status: 'pending',
    };

    function policy(overrides: Partial<AutoYesPolicy> = {}): AutoYesPolicy {
      return { mode: null, allowPromptTypes: [], denyPatterns: [], ...overrides };
    }

    describe('contract-less parity (regression: existing users are untouched)', () => {
      const fixtures: Array<{ name: string; prompt: PromptData; expected: string | null }> = [
        { name: 'yes_no', prompt: yesNo, expected: 'y' },
        { name: 'multiple_choice with default', prompt: multipleChoice, expected: '1' },
        {
          name: 'multiple_choice without default',
          prompt: {
            ...multipleChoice,
            options: multipleChoice.options.map(o => ({ ...o, isDefault: false })),
          },
          expected: '1',
        },
        { name: 'multiple_choice requiring text input', prompt: textInputOnly, expected: null },
        { name: 'multiple_choice with no options', prompt: emptyOptions, expected: null },
      ];

      it('the fixture table exercises both answered and skipped prompts', () => {
        // Guards the parity assertions below from passing vacuously on a table
        // that happens to resolve to null everywhere.
        expect(fixtures.filter(f => f.expected !== null).length).toBeGreaterThan(0);
        expect(fixtures.filter(f => f.expected === null).length).toBeGreaterThan(0);
      });

      it.each(fixtures)(
        'no policy argument, null, undefined and a policy-less contract all agree ($name)',
        ({ prompt, expected }) => {
          expect(resolveAutoAnswer(prompt)).toBe(expected);
          expect(resolveAutoAnswer(prompt, undefined)).toBe(expected);
          expect(resolveAutoAnswer(prompt, null)).toBe(expected);
          // What parseTaskContract() produces for a contract with no autoYes block.
          expect(resolveAutoAnswer(prompt, policy())).toBe(expected);
        }
      );

      it('reports no suppression when no policy constrains the prompt', () => {
        expect(resolveAutoAnswerWithPolicy(multipleChoice)).toEqual({
          answer: '1',
          suppressedBy: null,
        });
        expect(resolveAutoAnswerWithPolicy(multipleChoice, policy())).toEqual({
          answer: '1',
          suppressedBy: null,
        });
      });
    });

    describe("mode: 'off'", () => {
      it('withholds the answer for yes_no', () => {
        const resolution = resolveAutoAnswerWithPolicy(yesNo, policy({ mode: 'off' }));
        expect(resolution.answer).toBeNull();
        expect(resolution.suppressedBy).toBe('mode-off');
      });

      it('withholds the answer for multiple_choice', () => {
        const resolution = resolveAutoAnswerWithPolicy(multipleChoice, policy({ mode: 'off' }));
        expect(resolution.answer).toBeNull();
        expect(resolution.suppressedBy).toBe('mode-off');
      });

      it('does not report suppression for a prompt the base rules would skip anyway', () => {
        // The log must mean "an answer was withheld", not "a policy existed".
        expect(resolveAutoAnswerWithPolicy(textInputOnly, policy({ mode: 'off' }))).toEqual({
          answer: null,
          suppressedBy: null,
        });
      });
    });

    describe("mode: 'safe'", () => {
      it('still answers yes_no', () => {
        expect(resolveAutoAnswer(yesNo, policy({ mode: 'safe' }))).toBe('y');
      });

      it('withholds multiple_choice — the #1495 /model overlay class of prompt', () => {
        const resolution = resolveAutoAnswerWithPolicy(multipleChoice, policy({ mode: 'safe' }));
        expect(resolution.answer).toBeNull();
        expect(resolution.suppressedBy).toBe('type-not-allowed');
      });
    });

    describe("mode: 'allow-listed'", () => {
      it('answers a listed prompt type', () => {
        expect(
          resolveAutoAnswer(
            multipleChoice,
            policy({ mode: 'allow-listed', allowPromptTypes: ['multiple_choice'] })
          )
        ).toBe('1');
      });

      it('withholds an unlisted prompt type', () => {
        const resolution = resolveAutoAnswerWithPolicy(
          yesNo,
          policy({ mode: 'allow-listed', allowPromptTypes: ['multiple_choice'] })
        );
        expect(resolution.answer).toBeNull();
        expect(resolution.suppressedBy).toBe('type-not-allowed');
      });

      it('withholds everything when the allow list is empty', () => {
        expect(resolveAutoAnswer(yesNo, policy({ mode: 'allow-listed' }))).toBeNull();
        expect(resolveAutoAnswer(multipleChoice, policy({ mode: 'allow-listed' }))).toBeNull();
      });
    });

    describe('denyPatterns', () => {
      it('withholds when the question matches', () => {
        const resolution = resolveAutoAnswerWithPolicy(
          multipleChoice,
          policy({ denyPatterns: ['useVirtualKeyboard'] })
        );
        expect(resolution.answer).toBeNull();
        expect(resolution.suppressedBy).toBe('deny-pattern');
        expect(resolution.pattern).toBe('useVirtualKeyboard');
      });

      it('withholds when an option label matches', () => {
        expect(
          resolveAutoAnswer(multipleChoice, policy({ denyPatterns: ['allow all edits'] }))
        ).toBeNull();
      });

      it('withholds when the approval target above the question matches', () => {
        // Claude puts the command being approved above the question, not in it.
        // Issue #1699 moved this surface from instructionText to approvalTarget;
        // the behaviour being pinned — "the command above the question still
        // escalates" — is unchanged, and must stay that way.
        expect(
          resolveAutoAnswer(
            { ...yesNo, approvalTarget: 'Bash command: rm -rf /tmp/build' },
            policy({ denyPatterns: ['rm -rf'] })
          )
        ).toBeNull();
      });

      it('answers when only the scrollback — not the approval target — matches (#1699)', () => {
        // instructionText is a pane window: it keeps showing an `rm -rf` that
        // was approved turns ago. Matching against it suppressed every later
        // prompt until the line scrolled off, which is how two workers stalled.
        expect(
          resolveAutoAnswer(
            {
              ...yesNo,
              instructionText: 'Ran: rm -rf /tmp/build\n\nOverwrite config file?',
              approvalTarget: 'Overwrite config file?',
            },
            policy({ denyPatterns: ['rm -rf'] })
          )
        ).toBe('y');
      });

      it('answers when no pattern matches', () => {
        expect(
          resolveAutoAnswer(multipleChoice, policy({ denyPatterns: ['^never-matches$'] }))
        ).toBe('1');
      });

      it('applies even when the contract states no mode', () => {
        // A listed pattern that quietly did nothing is the worst failure a
        // contract can have, so denyPatterns do not wait for a mode.
        expect(resolveAutoAnswer(yesNo, policy({ denyPatterns: ['proceed'] }))).toBeNull();
      });

      it("overrides mode: 'safe' permitting yes_no", () => {
        const resolution = resolveAutoAnswerWithPolicy(
          yesNo,
          policy({ mode: 'safe', denyPatterns: ['proceed'] })
        );
        expect(resolution.answer).toBeNull();
        expect(resolution.suppressedBy).toBe('deny-pattern');
      });

      it('matches with regex semantics, not substring semantics', () => {
        expect(
          resolveAutoAnswer(multipleChoice, policy({ denyPatterns: ['edit to \\S+\\.ts\\?'] }))
        ).toBeNull();
      });
    });

    describe('denyPatterns that cannot be evaluated (fail closed, never hang)', () => {
      it('withholds on unparseable regex syntax instead of throwing', () => {
        const resolution = resolveAutoAnswerWithPolicy(yesNo, policy({ denyPatterns: ['('] }));
        expect(resolution.answer).toBeNull();
        expect(resolution.suppressedBy).toBe('deny-pattern-unusable');
      });

      it('withholds on a catastrophic-backtracking pattern without executing it', () => {
        // safe-regex2 rejects star height > 1, so the exponential pattern is
        // never run against the input at all — the verdict is decided by
        // screening, not by how long a match takes.
        const resolution = resolveAutoAnswerWithPolicy(
          { ...yesNo, question: `${'a'.repeat(40)}b` },
          policy({ denyPatterns: ['(a+)+$'] })
        );
        expect(resolution.answer).toBeNull();
        expect(resolution.suppressedBy).toBe('deny-pattern-unusable');
      });

      it('withholds on an over-long pattern', () => {
        const resolution = resolveAutoAnswerWithPolicy(
          yesNo,
          policy({ denyPatterns: ['a'.repeat(MAX_DENY_PATTERN_LENGTH + 1)] })
        );
        expect(resolution.suppressedBy).toBe('deny-pattern-unusable');
      });

      it('accepts a pattern exactly at the length bound', () => {
        // Pins the boundary as inclusive, so the check cannot drift to `>=`.
        expect(
          resolveAutoAnswer(yesNo, policy({ denyPatterns: ['a'.repeat(MAX_DENY_PATTERN_LENGTH)] }))
        ).toBe('y');
      });

      it('shares the contract loader length bound', () => {
        expect(MAX_DENY_PATTERN_LENGTH).toBe(MAX_PATTERN_LENGTH);
      });
    });

    describe('long prompt text is matched over a bounded head (deterministic, not timed)', () => {
      it('matches a pattern that occurs inside the bound', () => {
        expect(
          resolveAutoAnswer(
            { ...yesNo, question: `DANGER${'x'.repeat(1_000_000)}` },
            policy({ denyPatterns: ['DANGER'] })
          )
        ).toBeNull();
      });

      it('does not scan past the bound', () => {
        // Asserting the *value* rather than elapsed wall-clock time is what makes
        // this a real guard: it fails if the truncation is removed.
        expect(
          resolveAutoAnswer(
            { ...yesNo, question: `${'x'.repeat(MAX_DENY_MATCH_TEXT_LENGTH)}DANGER` },
            policy({ denyPatterns: ['DANGER'] })
          )
        ).toBe('y');
      });
    });

    describe('a policy never creates an answer', () => {
      it.each([
        ['off' as const],
        ['safe' as const],
        ['allow-listed' as const],
      ])('leaves an unanswerable prompt unanswered under mode %s', mode => {
        expect(
          resolveAutoAnswer(
            emptyOptions,
            policy({ mode, allowPromptTypes: ['multiple_choice', 'yes_no'] })
          )
        ).toBeNull();
        expect(
          resolveAutoAnswer(
            textInputOnly,
            policy({ mode, allowPromptTypes: ['multiple_choice', 'yes_no'] })
          )
        ).toBeNull();
      });
    });
  });
});
