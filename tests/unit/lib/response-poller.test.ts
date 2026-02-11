/**
 * Unit tests for response-poller
 * Issue #212: Ensure [Pasted text #N +XX lines] is filtered from responses
 * Issue #235: rawContent DB save fallback logic
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { cleanClaudeResponse } from '@/lib/response-poller';
import type { PromptDetectionResult } from '@/lib/prompt-detector';

describe('cleanClaudeResponse() - Pasted text filtering (Issue #212)', () => {
  it('should filter out lines containing Pasted text pattern', () => {
    const input = 'Some response\n[Pasted text #1 +46 lines]\nMore response';
    const result = cleanClaudeResponse(input);
    expect(result).not.toContain('[Pasted text #1');
    expect(result).toContain('Some response');
    expect(result).toContain('More response');
  });

  it('should filter multiple Pasted text lines', () => {
    const input = 'Response start\n[Pasted text #1 +10 lines]\n[Pasted text #2 +20 lines]\nResponse end';
    const result = cleanClaudeResponse(input);
    expect(result).not.toContain('[Pasted text');
    expect(result).toContain('Response start');
    expect(result).toContain('Response end');
  });

  it('should preserve normal response lines without Pasted text', () => {
    const input = 'Normal response line\nAnother normal line';
    const result = cleanClaudeResponse(input);
    expect(result).toContain('Normal response line');
    expect(result).toContain('Another normal line');
  });
});

// ==========================================================================
// Issue #235: rawContent DB save fallback logic
// Tests the content selection logic: rawContent || cleanContent
// Since checkForResponse() is an internal function with many dependencies,
// we test the content selection pattern directly using PromptDetectionResult.
// ==========================================================================
describe('Issue #235: rawContent DB save fallback logic', () => {
  /**
   * Simulates the content selection logic from response-poller.ts L618:
   *   content: promptDetection.rawContent || promptDetection.cleanContent
   */
  function selectContentForDb(promptDetection: PromptDetectionResult): string {
    return promptDetection.rawContent || promptDetection.cleanContent;
  }

  it('should use rawContent for DB save when rawContent is set', () => {
    const promptDetection: PromptDetectionResult = {
      isPrompt: true,
      cleanContent: 'Do you want to proceed?',
      rawContent: 'Here is some instruction text.\nDo you want to proceed?',
      promptData: {
        type: 'yes_no',
        question: 'Do you want to proceed?',
        options: ['yes', 'no'],
        status: 'pending',
      },
    };

    const content = selectContentForDb(promptDetection);
    expect(content).toBe('Here is some instruction text.\nDo you want to proceed?');
  });

  it('should fallback to cleanContent for DB save when rawContent is undefined', () => {
    const promptDetection: PromptDetectionResult = {
      isPrompt: true,
      cleanContent: 'Do you want to proceed?',
      // rawContent is undefined (e.g., non-prompt case or legacy behavior)
      promptData: {
        type: 'yes_no',
        question: 'Do you want to proceed?',
        options: ['yes', 'no'],
        status: 'pending',
      },
    };

    const content = selectContentForDb(promptDetection);
    expect(content).toBe('Do you want to proceed?');
  });
});
