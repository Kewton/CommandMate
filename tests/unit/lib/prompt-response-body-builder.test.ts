/**
 * Tests for prompt-response-body-builder utility
 *
 * Issue #287: Shared utility for building the prompt-response API request body.
 * Ensures promptType and defaultOptionNumber are correctly included for
 * cursor-key navigation fallback.
 */

import { describe, it, expect } from 'vitest';
import { buildPromptResponseBody } from '@/lib/prompt-response-body-builder';
import type { PromptData } from '@/types/models';

describe('buildPromptResponseBody', () => {
  it('should include answer and cliTool when promptData is null', () => {
    const body = buildPromptResponseBody('y', 'claude', null);

    expect(body).toEqual({
      answer: 'y',
      cliTool: 'claude',
    });
    expect(body.promptType).toBeUndefined();
    expect(body.defaultOptionNumber).toBeUndefined();
  });

  it('should include promptType for yes_no prompts', () => {
    const promptData: PromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };

    const body = buildPromptResponseBody('y', 'claude', promptData);

    expect(body.answer).toBe('y');
    expect(body.cliTool).toBe('claude');
    expect(body.promptType).toBe('yes_no');
    expect(body.defaultOptionNumber).toBeUndefined();
  });

  it('should include promptType and defaultOptionNumber for multiple_choice with default', () => {
    const promptData: PromptData = {
      type: 'multiple_choice',
      question: 'Choose:',
      options: [
        { number: 1, label: 'First', isDefault: false },
        { number: 2, label: 'Second', isDefault: true },
        { number: 3, label: 'Third', isDefault: false },
      ],
      status: 'pending',
    };

    const body = buildPromptResponseBody('2', 'claude', promptData);

    expect(body.answer).toBe('2');
    expect(body.promptType).toBe('multiple_choice');
    expect(body.defaultOptionNumber).toBe(2);
  });

  it('should not include defaultOptionNumber for multiple_choice without default', () => {
    const promptData: PromptData = {
      type: 'multiple_choice',
      question: 'Choose:',
      options: [
        { number: 1, label: 'First', isDefault: false },
        { number: 2, label: 'Second', isDefault: false },
      ],
      status: 'pending',
    };

    const body = buildPromptResponseBody('1', 'codex', promptData);

    expect(body.promptType).toBe('multiple_choice');
    expect(body.defaultOptionNumber).toBeUndefined();
  });

  it('should use the correct cliTool for codex', () => {
    const body = buildPromptResponseBody('y', 'codex', null);

    expect(body.cliTool).toBe('codex');
  });
});
