/**
 * Tests for cli-patterns module
 * Issue #132: Fix status detection for prompt with recommended commands
 * TDD Approach: Write tests first (Red), then implement (Green)
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { CLAUDE_PROMPT_PATTERN, CLAUDE_THINKING_PATTERN, CLAUDE_TRUST_DIALOG_PATTERN, detectThinking, getCliToolPatterns } from '../cli-patterns';

describe('cli-patterns', () => {
  describe('CLAUDE_PROMPT_PATTERN', () => {
    describe('should match empty prompt lines', () => {
      it('should match ">" only', () => {
        const output = `Some output
>
`;
        expect(CLAUDE_PROMPT_PATTERN.test(output)).toBe(true);
      });

      it('should match "> " (with trailing space)', () => {
        const output = `Some output
>
`;
        expect(CLAUDE_PROMPT_PATTERN.test(output)).toBe(true);
      });

      it('should match "❯" only', () => {
        const output = `Some output
❯
`;
        expect(CLAUDE_PROMPT_PATTERN.test(output)).toBe(true);
      });

      it('should match "❯ " (with trailing space)', () => {
        const output = `Some output
❯
`;
        expect(CLAUDE_PROMPT_PATTERN.test(output)).toBe(true);
      });
    });

    describe('Issue #132: should match prompt with recommended commands', () => {
      it('should match "> /work-plan" (recommended command)', () => {
        const output = `Some output
> /work-plan
`;
        expect(CLAUDE_PROMPT_PATTERN.test(output)).toBe(true);
      });

      it('should match "❯ /create-pr" (recommended command)', () => {
        const output = `Some output
❯ /create-pr
`;
        expect(CLAUDE_PROMPT_PATTERN.test(output)).toBe(true);
      });

      it('should match "> npm install" (recommended shell command)', () => {
        const output = `Some output
> npm install
`;
        expect(CLAUDE_PROMPT_PATTERN.test(output)).toBe(true);
      });

      it('should match "❯ git status" (recommended git command)', () => {
        const output = `Some output
❯ git status
`;
        expect(CLAUDE_PROMPT_PATTERN.test(output)).toBe(true);
      });

      it('should match multi-word recommended command', () => {
        const output = `Some output
❯ npm run test:unit
`;
        expect(CLAUDE_PROMPT_PATTERN.test(output)).toBe(true);
      });
    });

    describe('should NOT match non-prompt patterns', () => {
      it('should NOT match mid-line ">" (not at line start)', () => {
        const output = `Some output with > in the middle
Next line
`;
        expect(CLAUDE_PROMPT_PATTERN.test(output)).toBe(false);
      });

      it('should NOT match thinking indicator lines', () => {
        const output = `Some output
✻ Thinking…
`;
        // This should not match CLAUDE_PROMPT_PATTERN (it's a thinking indicator)
        expect(CLAUDE_PROMPT_PATTERN.test(output)).toBe(false);
      });
    });
  });

  describe('CLAUDE_THINKING_PATTERN', () => {
    it('should match "✻ Thinking…"', () => {
      const output = `❯ Tell me about TypeScript
✻ Thinking…`;
      expect(CLAUDE_THINKING_PATTERN.test(output)).toBe(true);
    });

    it('should match "· Contemplating…"', () => {
      const output = `· Contemplating…`;
      expect(CLAUDE_THINKING_PATTERN.test(output)).toBe(true);
    });

    it('should match "(esc to interrupt)" with parens', () => {
      const output = `(esc to interrupt)`;
      expect(CLAUDE_THINKING_PATTERN.test(output)).toBe(true);
    });

    it('should match "esc to interrupt" without parens (status bar format)', () => {
      const output = `  27 files +0 -0 · esc to interrupt · ctrl+t to hide tasks`;
      expect(CLAUDE_THINKING_PATTERN.test(output)).toBe(true);
    });

    it('should match thinking pattern with spaces in activity text', () => {
      const output = `✻ Verifying implementation (dead code detection)…`;
      expect(CLAUDE_THINKING_PATTERN.test(output)).toBe(true);
    });

    it('should NOT match empty prompt line', () => {
      const output = `❯ `;
      expect(CLAUDE_THINKING_PATTERN.test(output)).toBe(false);
    });

    it('should NOT match prompt with command', () => {
      const output = `❯ /work-plan`;
      expect(CLAUDE_THINKING_PATTERN.test(output)).toBe(false);
    });
  });

  describe('detectThinking', () => {
    it('should return true when thinking indicator is present', () => {
      const output = `✻ Processing…`;
      expect(detectThinking('claude', output)).toBe(true);
    });

    it('should return false when only prompt is present', () => {
      const output = `❯ `;
      expect(detectThinking('claude', output)).toBe(false);
    });

    it('should return false for prompt with recommended command', () => {
      const output = `❯ /work-plan`;
      expect(detectThinking('claude', output)).toBe(false);
    });
  });

  describe('CLAUDE_TRUST_DIALOG_PATTERN', () => {
    it('should match trust dialog full text', () => {
      const output = `Quick safety check: Is this a project you created or one you trust?\n\n ❯ 1. Yes, I trust this folder\n   2. No, exit`;
      expect(CLAUDE_TRUST_DIALOG_PATTERN.test(output)).toBe(true);
    });

    it('should match trust dialog with tmux padding (partial match)', () => {
      const output = `\n\n  Some tmux header content\nQuick safety check: Is this a project you created or one you trust?\n\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n\n`;
      expect(CLAUDE_TRUST_DIALOG_PATTERN.test(output)).toBe(true);
    });

    it('should NOT match "No, exit" option', () => {
      const output = `No, exit`;
      expect(CLAUDE_TRUST_DIALOG_PATTERN.test(output)).toBe(false);
    });

    it('should NOT match regular CLI output', () => {
      const output = `❯ git status\nOn branch main\nnothing to commit, working tree clean`;
      expect(CLAUDE_TRUST_DIALOG_PATTERN.test(output)).toBe(false);
    });
  });

  describe('getCliToolPatterns', () => {
    describe('claude', () => {
      it('should return promptPattern that matches empty prompt', () => {
        const patterns = getCliToolPatterns('claude');
        expect(patterns.promptPattern.test('❯ ')).toBe(true);
        expect(patterns.promptPattern.test('> ')).toBe(true);
      });

      it('should return promptPattern that matches prompt with command (Issue #132)', () => {
        const patterns = getCliToolPatterns('claude');
        expect(patterns.promptPattern.test('❯ /work-plan')).toBe(true);
        expect(patterns.promptPattern.test('> npm install')).toBe(true);
      });

      it('should return skipPatterns that still skip empty prompts only', () => {
        const patterns = getCliToolPatterns('claude');
        // skipPatterns should only match empty prompts (for text filtering)
        // NOT prompts with recommended commands
        const emptyPromptSkipPattern = patterns.skipPatterns.find(p =>
          p.source.includes('[>❯]')
        );
        expect(emptyPromptSkipPattern).toBeDefined();

        // Empty prompts should be skipped
        expect(emptyPromptSkipPattern!.test('> ')).toBe(true);
        expect(emptyPromptSkipPattern!.test('❯ ')).toBe(true);

        // Prompts with commands should NOT be skipped by skipPatterns
        // (they are valid user prompts, not UI decoration)
        expect(emptyPromptSkipPattern!.test('❯ /work-plan')).toBe(false);
      });
    });
  });
});
