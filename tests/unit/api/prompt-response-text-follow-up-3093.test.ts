/**
 * Which chosen options hand their text on to `send` (Issue #3093).
 */

import { describe, it, expect } from 'vitest';
import { findTextFollowUp } from '@/app/api/worktrees/[id]/prompt-response/text-follow-up';
import type { PromptData } from '@/types/models';

function menu(labels: string[], requiresTextInput: (label: string) => boolean = () => false): PromptData {
  return {
    type: 'multiple_choice',
    question: 'Do you want to proceed?',
    status: 'pending',
    options: labels.map((label, index) => ({
      number: index + 1,
      label,
      isDefault: index === 0,
      requiresTextInput: requiresTextInput(label),
    })),
  } as PromptData;
}

const COMMAND_CODE_PERMISSION = menu(
  ['Yes', "Yes, and don't ask again for 'npm run custom'", 'No, tell Command Code what to do differently'],
  (label) => /custom|differently/i.test(label),
);

describe('findTextFollowUp (Issue #3093)', () => {
  it('flags Command Code’s "No, tell … what to do differently" row', () => {
    const followUp = findTextFollowUp(COMMAND_CODE_PERMISSION, '3');
    expect(followUp).toMatchObject({
      optionNumber: 3,
      optionLabel: 'No, tell Command Code what to do differently',
    });
    expect(followUp?.message).toContain('commandmate send');
  });

  it('flags claude’s "No, and tell Claude what to do differently (esc)" row', () => {
    const prompt = menu(['Yes', 'No, and tell Claude what to do differently (esc)']);
    expect(findTextFollowUp(prompt, '2')?.optionNumber).toBe(2);
  });

  it('does not flag a row that only quotes a command containing "custom"', () => {
    expect(findTextFollowUp(COMMAND_CODE_PERMISSION, '2')).toBeNull();
    expect(findTextFollowUp(COMMAND_CODE_PERMISSION, '1')).toBeNull();
  });

  it('does not flag a real text field, a non-number, a missing option or a yes/no prompt', () => {
    const question = menu(['Red', 'Type something... tell me what to do differently'], (l) => /Type something/.test(l));
    expect(findTextFollowUp(question, '2')).toBeNull();
    expect(findTextFollowUp(COMMAND_CODE_PERMISSION, 'no')).toBeNull();
    expect(findTextFollowUp(COMMAND_CODE_PERMISSION, '9')).toBeNull();
    expect(findTextFollowUp(undefined, '3')).toBeNull();
    expect(
      findTextFollowUp({ type: 'yes_no', question: 'ok?', options: ['yes', 'no'], status: 'pending' } as PromptData, '1'),
    ).toBeNull();
  });
});
