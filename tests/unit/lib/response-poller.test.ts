/**
 * Unit tests for response-poller
 * Issue #212: Ensure [Pasted text #N +XX lines] is filtered from responses
 * Issue #235: rawContent DB save fallback logic
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { cleanClaudeResponse, normalizePromptForDedup } from '@/lib/polling/response-poller';
import { isDuplicatePrompt, clearPromptHashCache } from '@/lib/polling/prompt-dedup';
import type { PromptDetectionResult } from '@/lib/detection/prompt-detector';

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

// ==========================================================================
// Issue #571: normalizePromptForDedup tests
// Copilot-specific cursor position normalization for prompt deduplication
// ==========================================================================
describe('normalizePromptForDedup (Issue #571)', () => {
  it('should normalize Copilot prompts by replacing cursor markers with spaces', () => {
    const prompt1 = 'Allow access to directory?\n❯ Yes\n  No';
    const prompt2 = 'Allow access to directory?\n  Yes\n❯ No';
    const normalized1 = normalizePromptForDedup(prompt1, 'copilot');
    const normalized2 = normalizePromptForDedup(prompt2, 'copilot');
    expect(normalized1).toBe(normalized2);
  });

  it('should normalize > cursor markers for Copilot', () => {
    const prompt1 = 'Choose option:\n> Option A\n  Option B';
    const prompt2 = 'Choose option:\n  Option A\n> Option B';
    const normalized1 = normalizePromptForDedup(prompt1, 'copilot');
    const normalized2 = normalizePromptForDedup(prompt2, 'copilot');
    expect(normalized1).toBe(normalized2);
  });

  it('should NOT normalize prompts for claude', () => {
    const prompt = 'Some prompt with ❯ marker';
    expect(normalizePromptForDedup(prompt, 'claude')).toBe(prompt);
  });

  it('should NOT normalize prompts for codex', () => {
    const prompt = 'Some prompt with ❯ marker';
    expect(normalizePromptForDedup(prompt, 'codex')).toBe(prompt);
  });

  it('should NOT normalize prompts for gemini', () => {
    const prompt = 'Some prompt with ❯ marker';
    expect(normalizePromptForDedup(prompt, 'gemini')).toBe(prompt);
  });

  it('should deduplicate Copilot prompts with different cursor positions via isDuplicatePrompt', () => {
    const pollerKey = 'test-wt:copilot';
    clearPromptHashCache(pollerKey);

    const prompt1 = 'Allow access?\n❯ Yes\n  No';
    const prompt2 = 'Allow access?\n  Yes\n❯ No';

    const normalized1 = normalizePromptForDedup(prompt1, 'copilot');
    const normalized2 = normalizePromptForDedup(prompt2, 'copilot');

    // First call: not a duplicate
    expect(isDuplicatePrompt(pollerKey, normalized1)).toBe(false);
    // Second call with different cursor position: should be detected as duplicate
    expect(isDuplicatePrompt(pollerKey, normalized2)).toBe(true);

    clearPromptHashCache(pollerKey);
  });
});
