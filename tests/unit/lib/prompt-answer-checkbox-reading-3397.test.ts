/**
 * One checkbox reading for every path (Issue #3397, review round 2).
 *
 * `hasCheckboxOptions` (`prompt-answer-semantic`) is what the semantic resolver,
 * the sender's Space→Next branch and Auto-Yes's Enter exclusion all read. The
 * sender used to carry a narrower copy (`[ ]` / `[x]`), so a list whose boxes
 * read `[X]` / `[✔]` only was multi-select to the resolver and single-select to
 * the sender. The `[ ]` / `[x]` cases are unchanged and stay pinned in
 * `prompt-answer-sender.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
}));

import { sendPromptAnswer } from '@/lib/prompt-answer-sender';
import { hasCheckboxOptions, isMultiSelectPrompt } from '@/lib/prompt-answer-semantic';
import { sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import type { MultipleChoicePromptData } from '@/types/models';

function list(labels: string[]): MultipleChoicePromptData {
  return {
    type: 'multiple_choice',
    question: 'Select tools:',
    options: labels.map((label, i) => ({ number: i + 1, label, isDefault: i === 0 })),
    status: 'pending',
  };
}

beforeEach(() => vi.clearAllMocks());

describe('[#3397] hasCheckboxOptions / isMultiSelectPrompt', () => {
  it.each(['[ ] A', '[x] A', '[X] A', '[✔] A'])('%s is a checkbox label', (label) => {
    expect(hasCheckboxOptions([{ label }])).toBe(true);
    expect(isMultiSelectPrompt(list([label, 'B']))).toBe(true);
  });

  it.each(['A', '[] A', '[y] A', '1. [ ] A'])('%s is not', (label) => {
    expect(hasCheckboxOptions([{ label }])).toBe(false);
  });

  it('the multiSelect flag alone counts too', () => {
    expect(isMultiSelectPrompt({ ...list(['A', 'B']), multiSelect: true })).toBe(true);
    expect(isMultiSelectPrompt(list(['A', 'B']))).toBe(false);
  });
});

describe('[#3397] the sender reads [X] / [✔] boxes as a checkbox list', () => {
  it.each([
    ['[X]', ['[X] Option A', '[X] Option B', '[X] Option C']],
    ['[✔]', ['[✔] Option A', '[✔] Option B', '[✔] Option C']],
    ['mixed [ ] / [✔]', ['[✔] Option A', '[ ] Option B', '[ ] Option C']],
  ])('%s: Space on the option, then down to Next and Enter', async (_label, labels) => {
    await sendPromptAnswer({ sessionName: 'claude-test', answer: '2', cliToolId: 'claude', promptData: list(labels) });

    expect(sendSpecialKeys).toHaveBeenCalledWith('claude-test', ['Down', 'Space', 'Down', 'Down', 'Enter']);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('control: a list without boxes is still single-select', async () => {
    await sendPromptAnswer({
      sessionName: 'claude-test',
      answer: '2',
      cliToolId: 'claude',
      promptData: list(['Option A', 'Option B', 'Option C']),
    });

    expect(sendSpecialKeys).toHaveBeenCalledWith('claude-test', ['Down', 'Enter']);
  });
});
