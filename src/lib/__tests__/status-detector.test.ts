/**
 * Tests for status-detector module
 * Issue #54: Session status detection improvement
 * TDD Approach: Write tests first (Red), then implement (Green)
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { detectSessionStatus } from '../status-detector';

describe('status-detector', () => {
  describe('detectSessionStatus', () => {
    describe('claude', () => {
      it('should return "ready" with high confidence when input prompt is detected', () => {
        // Claude shows "❯ " when ready for input
        const output = `
Some previous output
───
❯
`;
        const result = detectSessionStatus(output, 'claude');

        expect(result.status).toBe('ready');
        expect(result.confidence).toBe('high');
        expect(result.reason).toBe('input_prompt');
      });

      it('should return "running" with high confidence when thinking indicator is detected', () => {
        // Claude shows spinner with activity text ending with ellipsis (…) when processing
        // Note: The pattern requires the actual ellipsis character (…), not three dots (...)
        const output = `
❯ Tell me about TypeScript
✻ Thinking…
`;
        const result = detectSessionStatus(output, 'claude');

        expect(result.status).toBe('running');
        expect(result.confidence).toBe('high');
        expect(result.reason).toBe('thinking_indicator');
      });

      it('should return "waiting" with high confidence when interactive prompt is detected', () => {
        // Claude shows yes/no prompt when waiting for user decision
        const output = `
Do you want to proceed? (y/n)
`;
        const result = detectSessionStatus(output, 'claude');

        expect(result.status).toBe('waiting');
        expect(result.confidence).toBe('high');
        expect(result.reason).toBe('prompt_detected');
      });

      it('should return "ready" with low confidence when no recent output', () => {
        // If no output change for 5+ seconds, assume ready
        const output = `
Some old output
`;
        const fiveSecondsAgo = new Date(Date.now() - 6000);
        const result = detectSessionStatus(output, 'claude', fiveSecondsAgo);

        expect(result.status).toBe('ready');
        expect(result.confidence).toBe('low');
        expect(result.reason).toBe('no_recent_output');
      });

      it('should return "running" with low confidence as default when no patterns match', () => {
        // Fallback when we cannot determine the state
        const output = `
Some intermediate output that doesn't match any pattern
`;
        const result = detectSessionStatus(output, 'claude');

        expect(result.status).toBe('running');
        expect(result.confidence).toBe('low');
        expect(result.reason).toBe('default');
      });

      it('should handle "to interrupt)" in output as running', () => {
        // Claude shows "(esc to interrupt)" when processing
        const output = `
❯ Generate code
(esc to interrupt)
`;
        const result = detectSessionStatus(output, 'claude');

        expect(result.status).toBe('running');
        expect(result.confidence).toBe('high');
        expect(result.reason).toBe('thinking_indicator');
      });

      it('should detect multiple choice prompt as waiting', () => {
        const output = `
Which option would you prefer?
❯ 1. Option A
  2. Option B
  3. Option C
`;
        const result = detectSessionStatus(output, 'claude');

        expect(result.status).toBe('waiting');
        expect(result.confidence).toBe('high');
        expect(result.reason).toBe('prompt_detected');
      });

      // Issue #132: Prompt with recommended commands should be "ready"
      describe('Issue #132: prompt with recommended commands', () => {
        it('should return "ready" when prompt shows recommended command "/work-plan"', () => {
          const output = `
Previous response here
───────────────────────────────────────────────────────────────────────────
❯ /work-plan
`;
          const result = detectSessionStatus(output, 'claude');

          expect(result.status).toBe('ready');
          expect(result.confidence).toBe('high');
          expect(result.reason).toBe('input_prompt');
        });

        it('should return "ready" when prompt shows recommended command "> npm install"', () => {
          const output = `
Previous response here
───────────────────────────────────────────────────────────────────────────
> npm install
`;
          const result = detectSessionStatus(output, 'claude');

          expect(result.status).toBe('ready');
          expect(result.confidence).toBe('high');
          expect(result.reason).toBe('input_prompt');
        });

        it('should return "ready" when prompt shows recommended git command', () => {
          const output = `
Previous response here
───────────────────────────────────────────────────────────────────────────
❯ git status
`;
          const result = detectSessionStatus(output, 'claude');

          expect(result.status).toBe('ready');
          expect(result.confidence).toBe('high');
          expect(result.reason).toBe('input_prompt');
        });

        it('should return "running" when thinking indicator present (not just prompt)', () => {
          // Even if prompt-like pattern exists, thinking indicator takes priority
          const output = `
❯ Some input
✻ Processing…
`;
          const result = detectSessionStatus(output, 'claude');

          expect(result.status).toBe('running');
          expect(result.confidence).toBe('high');
          expect(result.reason).toBe('thinking_indicator');
        });
      });
    });

    describe('codex', () => {
      it('should return "ready" with high confidence when codex prompt is detected', () => {
        const output = `
Previous response
› Type your request
`;
        const result = detectSessionStatus(output, 'codex');

        expect(result.status).toBe('ready');
        expect(result.confidence).toBe('high');
        expect(result.reason).toBe('input_prompt');
      });

      it('should return "running" when codex is processing', () => {
        const output = `
› Fix the bug
• Planning...
`;
        const result = detectSessionStatus(output, 'codex');

        expect(result.status).toBe('running');
        expect(result.confidence).toBe('high');
        expect(result.reason).toBe('thinking_indicator');
      });
    });

    describe('gemini', () => {
      it('should return "ready" with high confidence when shell prompt is detected', () => {
        const output = `
Gemini response here
maenokota@host %
`;
        const result = detectSessionStatus(output, 'gemini');

        expect(result.status).toBe('ready');
        expect(result.confidence).toBe('high');
        expect(result.reason).toBe('input_prompt');
      });
    });

    describe('edge cases', () => {
      it('should handle empty output', () => {
        const result = detectSessionStatus('', 'claude');

        // Empty output defaults to running with low confidence
        expect(result.status).toBe('running');
        expect(result.confidence).toBe('low');
      });

      it('should handle output with ANSI codes', () => {
        const output = `
\x1b[1m\x1b[32m❯\x1b[0m
`;
        const result = detectSessionStatus(output, 'claude');

        // Should strip ANSI codes and detect the prompt
        expect(result.status).toBe('ready');
        expect(result.confidence).toBe('high');
      });

      it('should check only last 15 lines', () => {
        // Build output with prompt buried in old content
        const oldLines = Array.from({ length: 50 }, (_, i) => `Old line ${i}`).join('\n');
        const output = `${oldLines}
Some recent content without prompt
`;
        const result = detectSessionStatus(output, 'claude');

        // Should not find the prompt in old lines
        expect(result.status).toBe('running');
        expect(result.confidence).toBe('low');
      });
    });
  });
});
