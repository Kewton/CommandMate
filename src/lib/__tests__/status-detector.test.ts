/**
 * Tests for status-detector module
 * Issue #54: Session status detection improvement
 * TDD Approach: Write tests first (Red), then implement (Green)
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { detectSessionStatus } from '@/lib/detection/status-detector';

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

      it('should detect running during Task execution with status bar "esc to interrupt"', () => {
        // When Claude Code runs a Task (subagent), the terminal shows:
        // - Task progress with ✽ spinner (outside 5-line window)
        // - Phase list (pushes spinner out of window)
        // - ❯ prompt (user can type to interrupt)
        // - Status bar with "esc to interrupt"
        // The status bar in the last 5 lines should be detected as running.
        const output = `
✽ マルチステージ設計レビュー実行中… (4m 56s · ↓ 4.5k tokens)
  ⎿  ◼ Phase 3: マルチステージ設計レビュー
     ◻ Phase 4: 作業計画立案
     ◻ Phase 5: TDD自動開発
     ◻ Phase 6: 完了報告
     ✔ Phase 1: マルチステージIssueレビュー
     ✔ Phase 2: 設計方針書確認・作成

───────────────────────────────────────────────────
❯
───────────────────────────────────────────────────
  27 files +0 -0 · esc to interrupt · ctrl+t to hide tasks
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

      // Issue #193: Multiple choice prompt without cursor indicator
      describe('Issue #193: multiple choice without cursor indicator', () => {
        it('should detect Claude multiple choice without cursor as waiting', () => {
          const output = [
            'Some previous output',
            'Do you want to proceed?',
            '  1. Yes',
            '  2. No',
            '  3. Cancel',
          ].join('\n');
          const result = detectSessionStatus(output, 'claude');

          expect(result.status).toBe('waiting');
          expect(result.confidence).toBe('high');
          expect(result.reason).toBe('prompt_detected');
          expect(result.hasActivePrompt).toBe(true);
        });

        it('should NOT detect Codex multiple choice without cursor as waiting', () => {
          // Codex should use default behavior (requireDefaultIndicator: true)
          const output = [
            'Some previous output',
            'Do you want to proceed?',
            '  1. Yes',
            '  2. No',
          ].join('\n');
          const result = detectSessionStatus(output, 'codex');

          // Without cursor indicator and default requireDefaultIndicator: true,
          // this should NOT be detected as a prompt
          expect(result.hasActivePrompt).toBe(false);
        });
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

      it('should return "waiting" for Codex approval prompts with collapsed preview lines', () => {
        const output = [
          'Would you like to run the following command?',
          '',
          '  $ git add README.md docs/runtime-overview.md docs/runtime-permissions.md',
          '  schemas/session-state.schema.json src/agents/mod.rs src/agents/tester.rs',
          '  src/cli/commands.rs src/cli/output.rs src/runtime/engine.rs',
          '  src/runtime/loop_state.rs src/state/session.rs tests/cli.rs',
          '  tests/pm_and_models.rs tests/state_roundtrip.rs',
          '  [… 12 lines] ctrl + a view all',
          '',
          '› 1. Yes, proceed (y)',
          '  2. Yes, and don\'t ask again for commands that start with `git add README.md',
          '     docs/runtime-overview.md docs/runtime-permissions.md schemas/session-',
          '     state.schema.json src/agents/mod.rs src/agents/tester.rs src/cli/',
          '     commands.rs src/cli/output.rs src/runtime/engine.rs src/runtime/',
          '     loop_state.rs src/state/session.rs tests/cli.rs tests/pm_and_models.rs',
          '     tests/state_roundtrip.rs workspace/anvil-implementation-plan.md` (p)',
          '  3. No, and tell Codex what to do differently (esc)',
          '',
          '  Press enter to confirm or esc to cancel',
        ].join('\n');

        const result = detectSessionStatus(output, 'codex');

        expect(result.status).toBe('waiting');
        expect(result.confidence).toBe('high');
        expect(result.reason).toBe('prompt_detected');
        expect(result.hasActivePrompt).toBe(true);
      });

      it('should return "waiting" for Codex approval prompts with long wrapped option labels', () => {
        const output = [
          'Would you like to run the following command?',
          '',
          '  Reason: Do you want me to create the requested git commit for the',
          '  local-first planning and evidence changes?',
          '',
          '  $ git add schemas/handoff-file.schema.json schemas/session-state.schema.json',
          '  src/agents/editor.rs src/agents/mod.rs src/agents/pm.rs src/agents/reader.rs',
          '  [… 14 lines] ctrl + a view all',
          '',
          '› 1. Yes, proceed (y)',
          '  2. Yes, and don\'t ask again for commands that start with `git add schemas/',
          '     handoff-file.schema.json schemas/session-state.schema.json src/agents/',
          '     editor.rs src/agents/mod.rs src/agents/pm.rs src/agents/reader.rs src/',
          '     agents/reviewer.rs src/agents/tester.rs src/cli/commands.rs src/cli/',
          '     output.rs src/models/mod.rs src/runtime/engine.rs src/runtime/',
          '     loop_state.rs src/state/handoff.rs src/state/session.rs tests/cli.rs',
          '     tests/pm_and_models.rs tests/state_roundtrip.rs workspace/anvil-',
          '     implementation-plan.md src/agents/executor.rs src/agents/planning.rs src/',
          '     models/profile.rs` (p)',
          '  3. No, and tell Codex what to do differently (esc)',
          '',
          '  Press enter to confirm or esc to cancel',
        ].join('\n');

        const result = detectSessionStatus(output, 'codex');

        expect(result.status).toBe('waiting');
        expect(result.confidence).toBe('high');
        expect(result.reason).toBe('prompt_detected');
        expect(result.hasActivePrompt).toBe(true);
      });

      it('should return "waiting" for Codex approval prompts when the default cursor line is missing', () => {
        const output = [
          'Would you like to run the following command?',
          '',
          '  $ npm test',
          '',
          '  1. Yes, proceed (y)',
          '  2. Yes, and don\'t ask again for commands that start with `npm test` (p)',
          '  3. No, and tell Codex what to do differently (esc)',
          '',
          '  Press enter to confirm or esc to cancel',
        ].join('\n');

        const result = detectSessionStatus(output, 'codex');

        expect(result.status).toBe('waiting');
        expect(result.confidence).toBe('high');
        expect(result.reason).toBe('prompt_detected');
        expect(result.hasActivePrompt).toBe(true);
      });

      it('should ignore decimal-looking command preview lines above Codex options', () => {
        const output = [
          'mode: plan | hint: /memory show | tokens: 2400/200000',
          'anvil>',
          '  workspace/implementation-plan-phases.md && git commit -m "Implement Phase',
          '  3.2 local model stabilization"',
          '',
          '› 1. Yes, proceed (y)',
          '  2. Yes, and don\'t ask again for commands that start with `git add foo` (p)',
          '  3. No, and tell Codex what to do differently (esc)',
          '',
          '  Press enter to confirm or esc to cancel',
        ].join('\n');

        const result = detectSessionStatus(output, 'codex');

        expect(result.status).toBe('waiting');
        expect(result.reason).toBe('prompt_detected');
        expect(result.hasActivePrompt).toBe(true);
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

    // Issue #180: Status display inconsistency fix tests
    describe('Issue #180: past prompts should not affect current status', () => {
      it('should return "ready" when past y/n prompt is >15 lines ago and tail has input prompt', () => {
        // Past y/n prompt buried in scrollback, current state is ready (❯ prompt at tail)
        const pastPrompt = 'Do you want to proceed? (y/n)';
        const filler = Array.from({ length: 20 }, (_, i) => `Processing line ${i}`).join('\n');
        const output = `${pastPrompt}\n${filler}\n---\n❯\n`;
        const result = detectSessionStatus(output, 'claude');

        expect(result.status).toBe('ready');
        expect(result.confidence).toBe('high');
        expect(result.reason).toBe('input_prompt');
        expect(result.hasActivePrompt).toBe(false);
      });

      it('should return "ready" when past multiple choice is >15 lines ago and tail has input prompt', () => {
        // Past multiple choice prompt buried in scrollback
        const pastMultipleChoice = [
          'Which option would you prefer?',
          '❯ 1. Option A',
          '  2. Option B',
          '  3. Option C',
        ].join('\n');
        const filler = Array.from({ length: 20 }, (_, i) => `Response line ${i}`).join('\n');
        const output = `${pastMultipleChoice}\n${filler}\n───\n❯\n`;
        const result = detectSessionStatus(output, 'claude');

        expect(result.status).toBe('ready');
        expect(result.confidence).toBe('high');
        expect(result.reason).toBe('input_prompt');
        expect(result.hasActivePrompt).toBe(false);
      });

      it('should return "waiting" when y/n prompt is in the tail (last 15 lines)', () => {
        // Active y/n prompt at the tail of output
        const output = [
          'Some previous output',
          'More output',
          'Do you want to continue? (y/n)',
        ].join('\n');
        const result = detectSessionStatus(output, 'claude');

        expect(result.status).toBe('waiting');
        expect(result.confidence).toBe('high');
        expect(result.reason).toBe('prompt_detected');
        expect(result.hasActivePrompt).toBe(true);
      });

      it('should return "waiting" when multiple choice prompt is in the tail (last 15 lines)', () => {
        // Active multiple choice prompt at the tail of output
        const output = [
          'Some previous output',
          'Which option would you prefer?',
          '❯ 1. Option A',
          '  2. Option B',
          '  3. Option C',
        ].join('\n');
        const result = detectSessionStatus(output, 'claude');

        expect(result.status).toBe('waiting');
        expect(result.confidence).toBe('high');
        expect(result.reason).toBe('prompt_detected');
        expect(result.hasActivePrompt).toBe(true);
      });

      it('should correctly map StatusDetectionResult to isWaitingForResponse/isProcessing flags', () => {
        // Test the mapping contract that route.ts uses:
        // isWaitingForResponse = status === 'waiting'
        // isProcessing = status === 'running'

        // Case 1: waiting -> isWaitingForResponse=true, isProcessing=false
        const waitingResult = detectSessionStatus('Do you want to proceed? (y/n)', 'claude');
        expect(waitingResult.status === 'waiting').toBe(true);
        expect(waitingResult.status === 'running').toBe(false);

        // Case 2: running -> isWaitingForResponse=false, isProcessing=true
        const runningResult = detectSessionStatus('❯ Tell me about TypeScript\n✻ Thinking\u2026', 'claude');
        expect(runningResult.status === 'waiting').toBe(false);
        expect(runningResult.status === 'running').toBe(true);

        // Case 3: ready -> isWaitingForResponse=false, isProcessing=false
        const readyResult = detectSessionStatus('───\n❯\n', 'claude');
        expect(readyResult.status === 'waiting').toBe(false);
        expect(readyResult.status === 'running').toBe(false);
      });

      it('should set hasActivePrompt: true when prompt detected, false otherwise', () => {
        // hasActivePrompt should be true only when an interactive prompt is detected
        const withPrompt = detectSessionStatus('Do you want to proceed? (y/n)', 'claude');
        expect(withPrompt.hasActivePrompt).toBe(true);
        expect(withPrompt.status).toBe('waiting');

        // No prompt -> hasActivePrompt: false
        const withInputPrompt = detectSessionStatus('───\n❯\n', 'claude');
        expect(withInputPrompt.hasActivePrompt).toBe(false);
        expect(withInputPrompt.status).toBe('ready');

        const withThinking = detectSessionStatus('❯ Tell me\n✻ Thinking\u2026', 'claude');
        expect(withThinking.hasActivePrompt).toBe(false);
        expect(withThinking.status).toBe('running');

        const defaultCase = detectSessionStatus('Some intermediate output', 'claude');
        expect(defaultCase.hasActivePrompt).toBe(false);
      });

      it('should handle empty line padding correctly', () => {
        // Sub-scenario (a): 5 empty lines + prompt -> ready (prompt within 15-line window)
        const promptWith5EmptyLines = '───\n❯\n' + '\n'.repeat(5);
        const resultA = detectSessionStatus(promptWith5EmptyLines, 'claude');
        expect(resultA.status).toBe('ready');
        expect(resultA.confidence).toBe('high');
        expect(resultA.reason).toBe('input_prompt');

        // Sub-scenario (b): 20+ empty lines after prompt
        // After trailing empty line stripping, the ❯ line IS the last content line
        // and falls within the 15-line window, so 'ready' is the correct result.
        // (Originally expected 'running' before trailing empty line stripping was added)
        const promptWith20EmptyLines = '❯\n' + '\n'.repeat(20);
        const resultB = detectSessionStatus(promptWith20EmptyLines, 'claude');
        expect(resultB.status).toBe('ready');
        expect(resultB.confidence).toBe('high');
        expect(resultB.reason).toBe('input_prompt');

        // Sub-scenario (c): 10 empty lines + y/n prompt -> waiting (prompt within 15-line window)
        const ynPromptWith10EmptyLines = '\n'.repeat(10) + 'Do you want to continue? (y/n)\n';
        const resultC = detectSessionStatus(ynPromptWith10EmptyLines, 'claude');
        expect(resultC.status).toBe('waiting');
        expect(resultC.confidence).toBe('high');
        expect(resultC.reason).toBe('prompt_detected');
        expect(resultC.hasActivePrompt).toBe(true);
      });

      it('should correctly handle raw ANSI output (DR-001)', () => {
        // Raw output with ANSI escape codes should be correctly stripped and detected
        // Simulates raw tmux output containing ANSI color codes around the prompt
        const rawOutput = '\x1b[1m\x1b[34mSome colored output\x1b[0m\n\x1b[32m❯\x1b[0m\n';
        const result = detectSessionStatus(rawOutput, 'claude');

        expect(result.status).toBe('ready');
        expect(result.confidence).toBe('high');
        expect(result.reason).toBe('input_prompt');
        expect(result.hasActivePrompt).toBe(false);

        // Raw ANSI with y/n prompt
        const rawYnOutput = '\x1b[33mDo you want to proceed? (y/n)\x1b[0m\n';
        const ynResult = detectSessionStatus(rawYnOutput, 'claude');

        expect(ynResult.status).toBe('waiting');
        expect(ynResult.confidence).toBe('high');
        expect(ynResult.hasActivePrompt).toBe(true);
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
