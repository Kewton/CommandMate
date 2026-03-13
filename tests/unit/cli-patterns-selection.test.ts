/**
 * Unit tests for OPENCODE_SELECTION_LIST_PATTERN
 * Issue #473: Pattern for OpenCode TUI selection list detection
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';

import {
  OPENCODE_SELECTION_LIST_PATTERN,
  OPENCODE_PROCESSING_INDICATOR,
  OPENCODE_PROMPT_PATTERN,
  OPENCODE_THINKING_PATTERN,
  OPENCODE_RESPONSE_COMPLETE,
} from '@/lib/detection/cli-patterns';

describe('OPENCODE_SELECTION_LIST_PATTERN', () => {
  it('should be a RegExp', () => {
    expect(OPENCODE_SELECTION_LIST_PATTERN).toBeInstanceOf(RegExp);
  });

  it('should match "Select model" header from actual capture-pane output', () => {
    // Actual OpenCode TUI output: "              Select model                                     esc"
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('              Select model                                     esc')).toBe(true);
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('Select model')).toBe(true);
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('  Select model  ')).toBe(true);
  });

  it('should match "Select provider" header', () => {
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('              Select provider                                  esc')).toBe(true);
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('Select provider')).toBe(true);
  });

  it('should match "Connect a provider" header from /connect command', () => {
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('              Connect a provider                               esc')).toBe(true);
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('Connect a provider')).toBe(true);
  });

  it('should match in multiline content', () => {
    const multiline = `

              Select model                                     esc

              Search

              Recent
            > GPT-5.1-Codex-mini GitHub Copilot
              GPT-5-mini GitHub Copilot`;
    expect(OPENCODE_SELECTION_LIST_PATTERN.test(multiline)).toBe(true);
  });

  it('should not match regular text output', () => {
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('Hello, how can I help you?')).toBe(false);
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('The code looks correct.')).toBe(false);
  });

  it('should not match OpenCode thinking pattern text', () => {
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('Thinking:')).toBe(false);
  });

  it('should not match OpenCode response complete pattern', () => {
    const completeText = '\u25A3 Build \u00b7 qwen3.5:27b \u00b7 5.2s';
    expect(OPENCODE_SELECTION_LIST_PATTERN.test(completeText)).toBe(false);
  });

  it('should not match Claude CLI output patterns', () => {
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('> ')).toBe(false);
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('esc to interrupt')).toBe(false);
  });

  it('should not match text containing "Select" in normal conversation', () => {
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('Please select a file to edit')).toBe(false);
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('I selected the model')).toBe(false);
  });
});
