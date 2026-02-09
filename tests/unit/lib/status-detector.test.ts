/**
 * Unit tests for status-detector.ts
 * Issue #188: Thinking indicator false detection fix
 *
 * Tests verify:
 * - Prompt takes priority over thinking (correct priority order)
 * - Thinking detection uses separate 5-line window (STATUS_THINKING_LINE_COUNT=5)
 * - Completed thinking summaries outside 5-line window are not falsely detected
 * - Boundary conditions for STATUS_THINKING_LINE_COUNT (5th vs 6th line from end)
 * - Empty line handling in window-based detection
 * - Existing behavior preservation (time-based heuristic, Codex support)
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { detectSessionStatus } from '@/lib/status-detector';

// Named constants for Unicode characters used in tmux output simulation.
// These match the actual characters produced by Claude CLI and detected by cli-patterns.ts.
const SPINNER = '\u2733';        // ✳ - Claude spinner character
const ELLIPSIS = '\u2026';       // ... - thinking activity suffix
const PROMPT = '\u276F';         // ❯ - Claude CLI prompt character
const SEPARATOR = '\u2500'.repeat(15); // ─ repeated - Claude response separator
const BULLET = '\u2022';         // - - Codex thinking indicator prefix

/**
 * Helper: create a thinking summary line (e.g., "✳ Churned for 41s...")
 */
function thinkingSummary(text: string): string {
  return `${SPINNER} ${text}${ELLIPSIS}`;
}

/**
 * Helper: create an active thinking indicator line (e.g., "✳ Planning...")
 */
function activeThinking(activity: string): string {
  return `${SPINNER} ${activity}${ELLIPSIS}`;
}

describe('status-detector', () => {
  describe('Issue #188: thinking + prompt coexistence', () => {
    it('should prioritize input prompt over completed thinking summary in scrollback', () => {
      // Thinking summary "Churned for 41s" is more than 5 lines from end,
      // so it falls outside STATUS_THINKING_LINE_COUNT window.
      // The input prompt at end should be detected instead.
      const output = [
        'Some response content line 1',
        'Some response content line 2',
        thinkingSummary('Churned for 41s'),  // far from end (outside 5-line window)
        'More response content',
        'More response content',
        'More response content',
        'More response content',
        'More response content',
        SEPARATOR,
        `${PROMPT} `,                        // input prompt at end
      ].join('\n');

      const result = detectSessionStatus(output, 'claude');
      expect(result.status).toBe('ready');
      expect(result.reason).toBe('input_prompt');
      expect(result.hasActivePrompt).toBe(false);
    });

    it('should prioritize interactive prompt (waiting) over thinking summary', () => {
      // y/n prompt at end with old thinking summary in scrollback
      const output = [
        'Some response content',
        thinkingSummary('Churned for 41s'),  // far from end
        'More content',
        'More content',
        'More content',
        'More content',
        'More content',
        'Do you want to proceed? (y/n)',
      ].join('\n');

      const result = detectSessionStatus(output, 'claude');
      expect(result.status).toBe('waiting');
      expect(result.hasActivePrompt).toBe(true);
      expect(result.reason).toBe('prompt_detected');
    });
  });

  describe('Issue #188: active thinking detection (within 5-line window)', () => {
    it('should detect active thinking indicator in last 5 lines', () => {
      const output = [
        'Some previous output',
        'More previous output',
        'Content line',
        activeThinking('Planning'),  // within 5-line window
      ].join('\n');

      const result = detectSessionStatus(output, 'claude');
      expect(result.status).toBe('running');
      expect(result.confidence).toBe('high');
      expect(result.reason).toBe('thinking_indicator');
      expect(result.hasActivePrompt).toBe(false);
    });

    it('should detect (esc to interrupt) in last 5 lines', () => {
      const output = [
        'Some previous output',
        'More content',
        '(esc to interrupt)',
      ].join('\n');

      const result = detectSessionStatus(output, 'claude');
      expect(result.status).toBe('running');
      expect(result.confidence).toBe('high');
      expect(result.reason).toBe('thinking_indicator');
    });
  });

  describe('Issue #188: thinking summary outside 5-line window (false detection prevention)', () => {
    it('should not detect thinking summary at line 6+ from end when prompt exists', () => {
      // Thinking summary is outside the 5-line window; input prompt should win.
      const output = [
        thinkingSummary('Churned for 41s'),  // line 1 (far from end, outside window)
        'Response content line 2',
        'Response content line 3',
        'Response content line 4',
        'Response content line 5',
        'Response content line 6',
        SEPARATOR,
        `${PROMPT} `,
      ].join('\n');

      const result = detectSessionStatus(output, 'claude');
      expect(result.status).toBe('ready');
      expect(result.reason).toBe('input_prompt');
    });

    it('should not detect thinking summary at line 6+ when no prompt exists', () => {
      // Thinking summary far from end, no prompt -> falls through to default
      const output = [
        thinkingSummary('Churned for 41s'),
        'Response line 2',
        'Response line 3',
        'Response line 4',
        'Response line 5',
        'Response line 6',
        'Response line 7',
        'Response line 8',
      ].join('\n');

      const result = detectSessionStatus(output, 'claude');
      expect(result.status).toBe('running');
      expect(result.confidence).toBe('low');
      expect(result.reason).toBe('default');
    });
  });

  describe('Issue #188: STATUS_THINKING_LINE_COUNT boundary tests', () => {
    it('should detect thinking at exactly the 5th line from end (inside window boundary)', () => {
      // lines.slice(-5) includes index -5 through -1
      const output = [
        'Line far above',
        'Line far above 2',
        activeThinking('Processing'),  // exactly 5th from end (index -5) -- inside window
        'Line 4 from end',
        'Line 3 from end',
        'Line 2 from end',
        'Line 1 from end (last)',
      ].join('\n');

      const result = detectSessionStatus(output, 'claude');
      expect(result.status).toBe('running');
      expect(result.confidence).toBe('high');
      expect(result.reason).toBe('thinking_indicator');
    });

    it('should NOT detect thinking at 6th line from end (outside window boundary)', () => {
      // lines.slice(-5) does NOT include index -6
      const output = [
        'Line far above',
        activeThinking('Processing'),  // 6th from end (index -6) -- outside window
        'Line 5 from end',
        'Line 4 from end',
        'Line 3 from end',
        'Line 2 from end',
        'Line 1 from end (last)',
      ].join('\n');

      const result = detectSessionStatus(output, 'claude');
      expect(result.reason).not.toBe('thinking_indicator');
    });
  });

  describe('Issue #188 C-002: empty lines in output', () => {
    it('should detect thinking indicator even when empty lines consume window slots', () => {
      // Empty lines count toward the 5-line window. Thinking indicator at index -2
      // is still inside the window.
      const output = [
        'Previous output',
        '',
        '',
        activeThinking('Analyzing'),  // within last 5 lines (index -2)
        '',
      ].join('\n');

      const result = detectSessionStatus(output, 'claude');
      expect(result.status).toBe('running');
      expect(result.reason).toBe('thinking_indicator');
    });

    it('should detect interactive prompt with many empty lines in 15-line window', () => {
      const output = [
        'Previous output',
        '',
        '',
        '',
        '',
        '',
        'Do you want to continue? (y/n)',
        '',
        '',
        `${PROMPT} Yes`,
      ].join('\n');

      const result = detectSessionStatus(output, 'claude');
      expect(result.status).toBe('waiting');
      expect(result.hasActivePrompt).toBe(true);
    });

    it('should detect input prompt with empty line padding in 15-line window', () => {
      const output = [
        'Content',
        '', '', '', '', '', '', '', '', '',  // 9 empty lines
        SEPARATOR,
        `${PROMPT} `,
        '',
        '',
      ].join('\n');

      const result = detectSessionStatus(output, 'claude');
      expect(result.status).toBe('ready');
      expect(result.reason).toBe('input_prompt');
    });
  });

  describe('Issue #188 SF-002 (S3): prompt outside 15-line STATUS_CHECK_LINE_COUNT window', () => {
    it('should detect input prompt even when followed by trailing empty lines (tmux padding)', () => {
      // Trailing empty lines (tmux terminal padding) are stripped before windowing,
      // so the input prompt remains within the detection window.
      // Note: ❯ alone is an input prompt (ready), not an interactive prompt (waiting).
      const lines: string[] = [];
      lines.push('Content');
      lines.push(`${PROMPT} `);  // input prompt followed by empty padding
      for (let i = 0; i < 16; i++) {
        lines.push('');          // 16 empty lines (tmux terminal padding)
      }

      const output = lines.join('\n');
      const result = detectSessionStatus(output, 'claude');

      expect(result.hasActivePrompt).toBe(false);
      expect(result.status).toBe('ready');
      expect(result.reason).toBe('input_prompt');
    });

    it('should not detect prompt when it is beyond 15 non-empty lines from end', () => {
      // When actual content (not empty padding) pushes the prompt outside the
      // STATUS_CHECK_LINE_COUNT window, it should not be detected.
      const lines: string[] = [];
      lines.push('Content');
      lines.push(`${PROMPT} `);  // prompt at position 2
      for (let i = 0; i < 16; i++) {
        lines.push(`Output line ${i}`);  // 16 non-empty lines push prompt outside window
      }

      const output = lines.join('\n');
      const result = detectSessionStatus(output, 'claude');

      expect(result.hasActivePrompt).toBe(false);
      expect(result.status).toBe('running');
      expect(result.confidence).toBe('low');
    });
  });

  describe('Bug fix: trailing empty lines and indented prompts', () => {
    it('should detect multiple choice prompt with trailing tmux padding empty lines', () => {
      // Real-world scenario: Claude Bash tool prompt followed by tmux terminal padding.
      // Trailing empty lines are stripped before windowing so the prompt is detected.
      const lines: string[] = [];
      lines.push('Bash command output');
      lines.push(' Do you want to proceed?');
      lines.push(' \u276F 1. Yes');
      lines.push('   2. No');
      lines.push('   3. Cancel');
      lines.push('');
      lines.push(' Esc to cancel \u00B7 Tab to amend');
      // Add 30+ trailing empty lines (tmux padding)
      for (let i = 0; i < 33; i++) {
        lines.push('');
      }
      const output = lines.join('\n');
      const result = detectSessionStatus(output, 'claude');
      expect(result.status).toBe('waiting');
      expect(result.hasActivePrompt).toBe(true);
      expect(result.reason).toBe('prompt_detected');
    });

    it('should detect waiting status for 2-space indented question with numbered choices in 15-line window', () => {
      // Claude Bash tool format: question and options are 2-space indented
      // detectSessionStatus uses buildDetectPromptOptions('claude') which sets
      // requireDefaultIndicator: false, allowing detection without cursor indicator.
      const output = [
        'Bash tool output line 1',
        'Bash tool output line 2',
        '  Do you want to proceed?',
        '  1. Yes',
        '  2. No',
      ].join('\n');

      const result = detectSessionStatus(output, 'claude');
      expect(result.status).toBe('waiting');
      expect(result.hasActivePrompt).toBe(true);
      expect(result.reason).toBe('prompt_detected');
    });
  });

  describe('existing behavior preservation', () => {
    it('should return ready with time-based heuristic when no patterns match', () => {
      const output = 'Some generic output without patterns';
      const oldTimestamp = new Date(Date.now() - 10000); // 10 seconds ago

      const result = detectSessionStatus(output, 'claude', oldTimestamp);
      expect(result.status).toBe('ready');
      expect(result.confidence).toBe('low');
      expect(result.reason).toBe('no_recent_output');
    });

    it('should return running (low confidence) as default when no patterns match', () => {
      const output = 'Some generic output without any detectable patterns';

      const result = detectSessionStatus(output, 'claude');
      expect(result.status).toBe('running');
      expect(result.confidence).toBe('low');
      expect(result.reason).toBe('default');
    });

    it('should detect codex thinking indicator', () => {
      const output = `${BULLET} Planning something`;

      const result = detectSessionStatus(output, 'codex');
      expect(result.status).toBe('running');
      expect(result.reason).toBe('thinking_indicator');
    });
  });
});
