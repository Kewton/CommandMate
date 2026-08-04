/**
 * Tests for semantic yes/no answer resolution (Issue #1681).
 *
 * `respond <wt> yes|no` must resolve to a concrete option number on
 * multiple_choice prompts instead of degrading into text + Enter (which
 * selects the highlighted default on cursor-navigated menus).
 */

import { describe, it, expect } from 'vitest';
import {
  parseSemanticAnswer,
  resolvePromptAnswer,
  PromptAnswerResolutionError,
} from '@/lib/prompt-answer-semantic';
import type { PromptData } from '@/types/models';

/** Claude Code 3-choice permission menu (the Issue #1681 repro). */
const claudePermissionPrompt: PromptData = {
  type: 'multiple_choice',
  question: 'Do you want to make this edit?',
  options: [
    { number: 1, label: 'Yes', isDefault: true },
    { number: 2, label: 'Yes, allow all edits during this session (shift+tab)', isDefault: false },
    { number: 3, label: "No, and tell Claude what to do differently (esc)", isDefault: false },
  ],
  status: 'pending',
};

/** Antigravity 4-choice permission menu (no isDefault flags). */
const agyPermissionPrompt: PromptData = {
  type: 'multiple_choice',
  question: 'Do you want to proceed?',
  options: [
    { number: 1, label: 'Yes' },
    { number: 2, label: "Yes, and always allow in this conversation for commands that start with 'git status'" },
    { number: 3, label: "Yes, and always allow for commands that start with 'git status' (Persist to settings.json)" },
    { number: 4, label: 'No' },
  ],
  status: 'pending',
};

describe('parseSemanticAnswer', () => {
  it.each([
    ['yes', 'yes'],
    ['y', 'yes'],
    ['Yes', 'yes'],
    ['YES', 'yes'],
    [' yes ', 'yes'],
    ['no', 'no'],
    ['n', 'no'],
    ['No', 'no'],
    ['N', 'no'],
  ])('parses %j as %j', (input, expected) => {
    expect(parseSemanticAnswer(input)).toBe(expected);
  });

  it.each(['2', 'maybe', '', 'yes please', 'no way', 'none'])(
    'returns null for non-semantic input %j',
    (input) => {
      expect(parseSemanticAnswer(input)).toBeNull();
    }
  );
});

describe('resolvePromptAnswer — semantic yes/no on multiple_choice', () => {
  it('resolves "no" to the negative option on the Claude 3-choice menu (not the default "Yes")', () => {
    const result = resolvePromptAnswer({ answer: 'no', promptData: claudePermissionPrompt });
    expect(result.input).toBe('3');
    expect(result.resolved).toEqual({
      via: 'semantic',
      optionNumber: 3,
      optionLabel: "No, and tell Claude what to do differently (esc)",
    });
  });

  it('resolves "yes" to the lowest-numbered affirmative option (narrowest scope)', () => {
    const result = resolvePromptAnswer({ answer: 'yes', promptData: claudePermissionPrompt });
    expect(result.input).toBe('1');
    expect(result.resolved?.optionNumber).toBe(1);
    expect(result.resolved?.optionLabel).toBe('Yes');
  });

  it('resolves "no" to option 4 on the Antigravity menu', () => {
    const result = resolvePromptAnswer({ answer: 'no', promptData: agyPermissionPrompt });
    expect(result.input).toBe('4');
    expect(result.resolved?.optionLabel).toBe('No');
  });

  it('keeps yes/no semantics on a 2-choice menu', () => {
    const twoChoice: PromptData = {
      type: 'multiple_choice',
      question: 'Proceed?',
      options: [
        { number: 1, label: 'Yes', isDefault: true },
        { number: 2, label: 'No', isDefault: false },
      ],
      status: 'pending',
    };
    expect(resolvePromptAnswer({ answer: 'yes', promptData: twoChoice }).input).toBe('1');
    expect(resolvePromptAnswer({ answer: 'no', promptData: twoChoice }).input).toBe('2');
  });

  it('resolves "no" via the deny pattern when no label starts with "no"', () => {
    const allowDeny: PromptData = {
      type: 'multiple_choice',
      question: 'Permission?',
      options: [
        { number: 1, label: 'Allow', isDefault: true },
        { number: 2, label: 'Deny', isDefault: false },
      ],
      status: 'pending',
    };
    expect(resolvePromptAnswer({ answer: 'no', promptData: allowDeny }).input).toBe('2');
  });

  it('accepts single-letter aliases y/n', () => {
    expect(resolvePromptAnswer({ answer: 'n', promptData: claudePermissionPrompt }).input).toBe('3');
    expect(resolvePromptAnswer({ answer: 'Y', promptData: claudePermissionPrompt }).input).toBe('1');
  });

  it('throws when no option label matches the semantic answer', () => {
    const modelPicker: PromptData = {
      type: 'multiple_choice',
      question: 'Select model:',
      options: [
        { number: 1, label: 'Default (recommended)', isDefault: true },
        { number: 2, label: 'Opus', isDefault: false },
        { number: 3, label: 'Haiku', isDefault: false },
      ],
      status: 'pending',
    };
    expect(() => resolvePromptAnswer({ answer: 'yes', promptData: modelPicker }))
      .toThrow(PromptAnswerResolutionError);
  });

  it('throws for multi-select (checkbox) prompts', () => {
    const multiSelect: PromptData = {
      type: 'multiple_choice',
      question: 'Select tools:',
      options: [
        { number: 1, label: '[ ] Yes tool', isDefault: true },
        { number: 2, label: '[ ] No tool', isDefault: false },
      ],
      status: 'pending',
    };
    expect(() => resolvePromptAnswer({ answer: 'yes', promptData: multiSelect }))
      .toThrow(PromptAnswerResolutionError);
  });

  it('throws when detection failed but the client claims multiple_choice (labels unknown)', () => {
    expect(() => resolvePromptAnswer({
      answer: 'no',
      promptData: undefined,
      fallbackPromptType: 'multiple_choice',
    })).toThrow(PromptAnswerResolutionError);
  });

  it('never classifies a negative label as affirmative', () => {
    const trickPrompt: PromptData = {
      type: 'multiple_choice',
      question: 'Proceed?',
      options: [
        { number: 1, label: 'No, deny everything', isDefault: true },
        { number: 2, label: 'Yes', isDefault: false },
      ],
      status: 'pending',
    };
    expect(resolvePromptAnswer({ answer: 'yes', promptData: trickPrompt }).input).toBe('2');
    expect(resolvePromptAnswer({ answer: 'no', promptData: trickPrompt }).input).toBe('1');
  });
});

describe('resolvePromptAnswer — passthrough cases', () => {
  it('passes numeric answers through unchanged', () => {
    const result = resolvePromptAnswer({ answer: '2', promptData: claudePermissionPrompt });
    expect(result).toEqual({ input: '2' });
  });

  it('passes free text through unchanged on multiple_choice', () => {
    const result = resolvePromptAnswer({ answer: 'use tabs instead', promptData: claudePermissionPrompt });
    expect(result).toEqual({ input: 'use tabs instead' });
  });

  it('passes yes/no through unchanged on yes_no prompts (text input works there)', () => {
    const yesNo: PromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };
    expect(resolvePromptAnswer({ answer: 'yes', promptData: yesNo })).toEqual({ input: 'yes' });
    expect(resolvePromptAnswer({ answer: 'no', promptData: yesNo })).toEqual({ input: 'no' });
  });

  it('passes yes/no through unchanged when nothing indicates multiple_choice', () => {
    expect(resolvePromptAnswer({ answer: 'yes', promptData: undefined })).toEqual({ input: 'yes' });
  });

  it('trusts fresh yes_no detection over a stale multiple_choice fallback claim', () => {
    const yesNo: PromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };
    expect(resolvePromptAnswer({
      answer: 'yes',
      promptData: yesNo,
      fallbackPromptType: 'multiple_choice',
    })).toEqual({ input: 'yes' });
  });
});

describe('resolvePromptAnswer — useDefault (--default)', () => {
  it('selects the isDefault option on multiple_choice', () => {
    const prompt: PromptData = {
      type: 'multiple_choice',
      question: 'Choose:',
      options: [
        { number: 1, label: 'A', isDefault: false },
        { number: 2, label: 'B', isDefault: true },
      ],
      status: 'pending',
    };
    const result = resolvePromptAnswer({ useDefault: true, promptData: prompt });
    expect(result.input).toBe('2');
    expect(result.resolved).toEqual({ via: 'default', optionNumber: 2, optionLabel: 'B' });
  });

  it('falls back to option 1 when no option carries isDefault (cursor rests on 1)', () => {
    const result = resolvePromptAnswer({ useDefault: true, promptData: agyPermissionPrompt });
    expect(result.input).toBe('1');
    expect(result.resolved?.optionLabel).toBe('Yes');
  });

  it('uses defaultOption for yes_no prompts', () => {
    const yesNo: PromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      defaultOption: 'no',
      status: 'pending',
    };
    const result = resolvePromptAnswer({ useDefault: true, promptData: yesNo });
    expect(result.input).toBe('no');
    expect(result.resolved).toEqual({ via: 'default', optionLabel: 'no' });
  });

  it('throws for yes_no prompts without a declared default', () => {
    const yesNo: PromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };
    expect(() => resolvePromptAnswer({ useDefault: true, promptData: yesNo }))
      .toThrow(PromptAnswerResolutionError);
  });

  it('throws when no prompt was detected', () => {
    expect(() => resolvePromptAnswer({ useDefault: true, promptData: undefined }))
      .toThrow(PromptAnswerResolutionError);
  });
});
