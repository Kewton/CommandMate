/**
 * Integration tests for Issue #188: thinking indicator false detection.
 *
 * Tests verify the interaction between:
 * - status-detector.ts (detectSessionStatus) -- windowed thinking detection
 * - cli-patterns.ts (detectThinking, CLAUDE_THINKING_PATTERN) -- pattern matching
 * - prompt-detector.ts (detectPrompt) -- interactive prompt detection
 *
 * These tests simulate realistic tmux output scenarios (including ANSI codes)
 * to verify that the status detection pipeline correctly handles:
 * - Thinking summaries in scrollback (should NOT trigger spinner)
 * - Active thinking indicators (should trigger spinner)
 * - Prompt priority over thinking summaries
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { detectSessionStatus } from '@/lib/status-detector';
import { CLAUDE_THINKING_PATTERN, stripAnsi } from '@/lib/cli-patterns';

// Named constants for Unicode characters used in tmux output simulation
const SPINNER = '\u2733';        // ✳ - Claude spinner character
const ELLIPSIS = '\u2026';       // ... - thinking activity suffix
const PROMPT = '\u276F';         // ❯ - Claude CLI prompt character
const SEPARATOR = '\u2500'.repeat(20); // ─ repeated - Claude response separator
const MIDDOT = '\u00b7';         // . - alternate spinner character

/** Helper: create a thinking summary/indicator line */
function thinking(text: string): string {
  return `${SPINNER} ${text}${ELLIPSIS}`;
}

describe('Issue #188: current-output thinking integration', () => {
  describe('spinner resolution after response completion', () => {
    it('should resolve spinner when prompt appears after completed thinking summary', () => {
      // Realistic scenario: Claude completed a response. Thinking summary is in
      // scrollback (outside 5-line window), separator and prompt at the end.
      const tmuxOutput = [
        `${PROMPT} Tell me about TypeScript`,
        '',
        thinking('Churned for 41s'),
        '',
        'TypeScript is a statically typed superset of JavaScript.',
        'It adds optional type annotations and class-based object-oriented programming.',
        '',
        'Key features include static typing, interfaces, and generics.',
        '',
        SEPARATOR,
        `${PROMPT} `,
      ].join('\n');

      const result = detectSessionStatus(tmuxOutput, 'claude');

      expect(result.status).not.toBe('running');
      expect(result.status).toBe('ready');
      expect(result.reason).toBe('input_prompt');
      expect(result.hasActivePrompt).toBe(false);
    });

    it('should derive thinking=false when thinking summary is outside 5-line window', () => {
      const tmuxOutput = [
        `${PROMPT} Explain generics`,
        thinking('Analyzing code'),
        '',
        'Generics allow you to create reusable components.',
        'They work with any data type.',
        '',
        'Example:',
        'function identity<T>(arg: T): T { return arg; }',
        '',
        SEPARATOR,
        `${PROMPT} `,
      ].join('\n');

      const result = detectSessionStatus(tmuxOutput, 'claude');

      // SF-001 (S3): thinking should be false (summary is outside 5-line window)
      const isThinking = result.status === 'running' && result.reason === 'thinking_indicator';
      expect(isThinking).toBe(false);
    });
  });

  describe('spinner display during active thinking', () => {
    it('should show spinner when thinking indicator is active in last 5 lines', () => {
      const tmuxOutput = [
        `${PROMPT} Refactor the authentication module`,
        '',
        thinking('Planning'),
      ].join('\n');

      const result = detectSessionStatus(tmuxOutput, 'claude');

      expect(result.status).toBe('running');
      expect(result.confidence).toBe('high');
      expect(result.reason).toBe('thinking_indicator');

      // SF-001 (S3): thinking field derivation from StatusDetectionResult
      const isThinking = result.status === 'running' && result.reason === 'thinking_indicator';
      expect(isThinking).toBe(true);
    });

    it('should show spinner when (esc to interrupt) is in output', () => {
      const tmuxOutput = [
        `${PROMPT} Write comprehensive tests`,
        '',
        thinking('Analyzing codebase'),
        '(esc to interrupt)',
      ].join('\n');

      const result = detectSessionStatus(tmuxOutput, 'claude');

      expect(result.status).toBe('running');
      expect(result.reason).toBe('thinking_indicator');
    });
  });

  describe('Issue #161 regression: thinking takes priority when active', () => {
    it('should detect active thinking even when numbered list exists in output', () => {
      // Active thinking indicator in last 5 lines should be detected.
      // Note: detectSessionStatus checks prompt BEFORE thinking (priority order),
      // but this test output does not contain a valid multiple_choice pattern
      // (no question line + consecutive options). The thinking indicator wins.
      const tmuxOutput = [
        `${PROMPT} List the steps for deployment`,
        '',
        'Here are the steps:',
        thinking('Thinking'),  // active thinking within 5-line window
      ].join('\n');

      const result = detectSessionStatus(tmuxOutput, 'claude');

      expect(result.status).toBe('running');
      expect(result.reason).toBe('thinking_indicator');
    });
  });

  describe('SF-001 (S3): thinking field transition verification', () => {
    it('should derive thinking=true when active thinking indicator is in last 5 lines', () => {
      const output = [
        'Previous response content',
        thinking('Processing request'),
      ].join('\n');

      const result = detectSessionStatus(output, 'claude');
      const isThinking = result.status === 'running' && result.reason === 'thinking_indicator';
      expect(isThinking).toBe(true);
    });

    it('should derive thinking=false when thinking summary is outside 5-line window with prompt', () => {
      const output = [
        thinking('Churned for 41s'),  // at top, outside 5-line window
        'Response line 1',
        'Response line 2',
        'Response line 3',
        'Response line 4',
        'Response line 5',
        SEPARATOR,
        `${PROMPT} `,
      ].join('\n');

      const result = detectSessionStatus(output, 'claude');
      const isThinking = result.status === 'running' && result.reason === 'thinking_indicator';
      expect(isThinking).toBe(false);
      expect(result.status).toBe('ready');
    });

    it('should derive thinking=false when thinking summary is outside 5-line window without prompt', () => {
      const output = [
        thinking('Churned for 41s'),  // at top, outside 5-line window
        'Response line 1',
        'Response line 2',
        'Response line 3',
        'Response line 4',
        'Response line 5',
        'Response line 6 (no prompt)',
      ].join('\n');

      const result = detectSessionStatus(output, 'claude');
      const isThinking = result.status === 'running' && result.reason === 'thinking_indicator';
      expect(isThinking).toBe(false);
      expect(result.status).toBe('running');
      expect(result.confidence).toBe('low');
    });
  });

  describe('SF-004 (S3): isPromptWaiting source of truth', () => {
    it('should use 15-line window for prompt detection (statusResult.hasActivePrompt)', () => {
      // y/n prompt at top, pushed outside the 15-line STATUS_CHECK_LINE_COUNT window
      // by 16 response lines. Even though detectPrompt's internal 50-line window
      // would find it, detectSessionStatus's 15-line window does not.
      const lines: string[] = [];
      lines.push('Do you want to proceed? (y/n)');
      for (let i = 0; i < 16; i++) {
        lines.push(`Response content line ${i + 1}`);
      }

      const output = lines.join('\n');
      const result = detectSessionStatus(output, 'claude');

      expect(result.hasActivePrompt).toBe(false);
    });
  });

  describe('ANSI code handling', () => {
    it('should strip ANSI codes before thinking/prompt detection', () => {
      // Realistic tmux output with ANSI SGR color codes wrapping every element
      const tmuxOutput = [
        `\x1b[32m${PROMPT} Tell me about TypeScript\x1b[0m`,
        '',
        `\x1b[33m${thinking('Churned for 41s')}\x1b[0m`,
        '',
        'TypeScript is great.',
        '',
        `\x1b[34m${SEPARATOR}\x1b[0m`,
        `\x1b[32m${PROMPT} \x1b[0m`,
      ].join('\n');

      const result = detectSessionStatus(tmuxOutput, 'claude');

      expect(result.status).toBe('ready');
      expect(result.reason).toBe('input_prompt');
    });
  });

  describe('thinking pattern verification', () => {
    it('should match all forms of thinking indicators', () => {
      // Pattern itself matches both active thinking and completed summaries.
      // Windowing (STATUS_THINKING_LINE_COUNT) is what prevents false detection.
      expect(CLAUDE_THINKING_PATTERN.test(thinking('Churned for 41s'))).toBe(true);
      expect(CLAUDE_THINKING_PATTERN.test(`${MIDDOT} Simmering${ELLIPSIS} (4m 16s)`)).toBe(true);
      expect(CLAUDE_THINKING_PATTERN.test(thinking('Planning'))).toBe(true);
      expect(CLAUDE_THINKING_PATTERN.test('(esc to interrupt)')).toBe(true);
    });

    it('should NOT match non-thinking text', () => {
      expect(CLAUDE_THINKING_PATTERN.test(`${PROMPT} `)).toBe(false);
      expect(CLAUDE_THINKING_PATTERN.test('Normal response text')).toBe(false);
      expect(CLAUDE_THINKING_PATTERN.test(SEPARATOR)).toBe(false);
    });
  });
});
