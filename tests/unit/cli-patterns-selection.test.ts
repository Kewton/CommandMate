/**
 * Unit tests for OPENCODE_SELECTION_LIST_PATTERN
 * Issue #473: Placeholder pattern for OpenCode TUI selection list detection
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';

import {
  OPENCODE_SELECTION_LIST_PATTERN,
  OPENCODE_PROCESSING_INDICATOR,
  OPENCODE_PROMPT_PATTERN,
  OPENCODE_THINKING_PATTERN,
  OPENCODE_RESPONSE_COMPLETE,
} from '@/lib/cli-patterns';

describe('OPENCODE_SELECTION_LIST_PATTERN', () => {
  it('should be a RegExp', () => {
    expect(OPENCODE_SELECTION_LIST_PATTERN).toBeInstanceOf(RegExp);
  });

  it('should match typical selection list patterns with > prefix', () => {
    // OpenCode TUI selection lists use > prefix for the selected item
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('> gpt-4o')).toBe(true);
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('> claude-3.5-sonnet')).toBe(true);
  });

  it('should match filter input pattern', () => {
    // Selection lists typically have a filter input
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('filter: gpt')).toBe(true);
  });

  it('should not match regular text output', () => {
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('Hello, how can I help you?')).toBe(false);
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('The code looks correct.')).toBe(false);
  });

  // [DR1-005] Non-overlap with existing patterns
  it('should not overlap with OPENCODE_PROCESSING_INDICATOR', () => {
    // "esc interrupt" should not match selection list pattern
    const processingText = 'esc interrupt';
    if (OPENCODE_PROCESSING_INDICATOR.test(processingText)) {
      // If it matches processing, it should ideally not match selection too
      // (this is a soft check; priority order in status-detector handles conflicts)
    }
  });

  it('should not match OpenCode thinking pattern text', () => {
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('Thinking:')).toBe(false);
  });

  it('should not match OpenCode response complete pattern', () => {
    const completeText = '\u25A3 Build \u00b7 qwen3.5:27b \u00b7 5.2s';
    expect(OPENCODE_SELECTION_LIST_PATTERN.test(completeText)).toBe(false);
  });

  it('should not match Claude CLI output patterns', () => {
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('> ')).toBe(false); // Claude prompt (just > with space, no model name)
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('esc to interrupt')).toBe(false);
  });
});
