/** @vitest-environment node */

/**
 * Issue #1699: a deny pattern must be judged against what *this* prompt is
 * asking approval for, not against whatever the pane still shows.
 *
 * What broke in production (2026-08-05): a worker asked to approve
 * `rm -rf $SP/tmp`, a human approved it, and from then on every unrelated
 * prompt — "Do you want to make this edit to X?" — was suppressed too, because
 * the deny surface included `instructionText`, a scrollback window that still
 * contained the already-approved command. Auto-Yes was effectively dead until
 * the line scrolled off the pane; one worker wrote nothing for about an hour.
 *
 * Both halves are pinned here, for both detector paths:
 *   1. a deny pattern that only appears in a previous turn does NOT suppress
 *   2. a deny pattern in the current prompt's own panel DOES suppress
 *
 * (2) is the half that must never be traded away for (1): a fix that widens the
 * hole instead of moving the wall is not a fix.
 *
 * Frames are constructed, but through the real pipeline every caller uses —
 * stripBoxDrawing(stripAnsi(pane)) → detectPrompt(buildDetectPromptOptions(tool))
 * → resolveAutoAnswerWithPolicy(promptData, policy) — the same two calls
 * auto-yes-poller.ts makes.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach } from 'vitest';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import {
  resolveAutoAnswerWithPolicy,
  type AutoYesPolicy,
} from '@/lib/polling/auto-yes-resolver';
import type { PromptData } from '@/types/models';

/** Claude's tool-use / tool-result transcript markers. */
const TOOL_USE = '⏺'; // ⏺
const TOOL_RESULT = '⎿'; // ⎿
/** Claude's default-selection cursor. */
const CURSOR = '❯'; // ❯

const DENY_RM_RF: AutoYesPolicy = {
  mode: 'allow-listed',
  allowPromptTypes: ['yes_no', 'multiple_choice'],
  denyPatterns: ['rm -rf'],
};

function detectAs(tool: 'claude' | 'codex', pane: string) {
  return detectPrompt(stripBoxDrawing(stripAnsi(pane)), buildDetectPromptOptions(tool));
}

/** Detect, assert the frame really is a prompt, and hand back the prompt data. */
function promptOf(tool: 'claude' | 'codex', pane: string): PromptData {
  const detection = detectAs(tool, pane);
  expect(detection.isPrompt).toBe(true);
  expect(detection.promptData).toBeDefined();
  return detection.promptData!;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * The exact production shape: an edit permission prompt rendered one turn after
 * an `rm -rf` was approved, so the destructive command is still on the pane.
 *
 * Box borders are gone by the time detectPrompt sees the frame (stripBoxDrawing
 * flattens `╭──╮` and `│ x │` alike), which is why the panel's upper edge has to
 * be found from the transcript markers instead.
 */
const CLAUDE_EDIT_AFTER_RM_RF = [
  `${TOOL_USE} Bash(rm -rf $SP/tmp)`,
  `  ${TOOL_RESULT}  (No content)`,
  '',
  `${TOOL_USE} Now let me update the resolver.`,
  '',
  'Edit file',
  '',
  '  src/lib/polling/auto-yes-resolver.ts',
  '',
  'Do you want to make this edit to auto-yes-resolver.ts?',
  `${CURSOR} 1. Yes`,
  '  2. Yes, allow all edits during this session (shift+tab)',
  '  3. No, and tell Claude what to do differently (esc)',
  '',
  'Esc to cancel · Tab to amend',
].join('\n');

/** The prompt the deny pattern exists for: `rm -rf` inside the current panel. */
const CLAUDE_RM_RF_PERMISSION = [
  `${TOOL_USE} I will clear the scratch directory first.`,
  '',
  'Bash command',
  '',
  '  rm -rf $SP/tmp',
  '  Remove the scratch directory',
  '',
  'Do you want to proceed?',
  `${CURSOR} 1. Yes`,
  "  2. Yes, and don't ask again for rm commands in $SP",
  '  3. No, and tell Claude what to do differently (esc)',
  '',
  'Esc to cancel · Tab to amend',
].join('\n');

/**
 * The same permission prompt with a longer explanation under the command.
 *
 * `extractQuestionText` reaches 5 lines above the question, so in the compact
 * frame above the command lands in `question` too and the prompt would still be
 * suppressed even with the approval target ignored entirely. Here it sits
 * outside that window, which makes `approvalTarget` the only thing standing
 * between `rm -rf` and an automatic "1".
 */
const CLAUDE_RM_RF_WITH_LONG_DESCRIPTION = [
  `${TOOL_USE} I will clear the scratch directory first.`,
  '',
  'Bash command',
  '',
  '  rm -rf $SP/tmp',
  '',
  '  This removes the scratch directory and everything under it.',
  '  The build outputs there are regenerated on the next run.',
  '  It cannot be undone.',
  '',
  'Do you want to proceed?',
  `${CURSOR} 1. Yes`,
  "  2. Yes, and don't ask again for rm commands in $SP",
  '  3. No, and tell Claude what to do differently (esc)',
  '',
  'Esc to cancel · Tab to amend',
].join('\n');

/** yes/no equivalent: the destructive command belongs to a finished turn. */
const YES_NO_AFTER_RM_RF = [
  `${TOOL_USE} Bash(rm -rf /tmp/build)`,
  `  ${TOOL_RESULT}  removed '/tmp/build'`,
  '',
  `${TOOL_USE} The build directory is clean.`,
  '',
  'Overwrite the existing config file? (y/n)',
].join('\n');

/** yes/no equivalent of the real thing: the command is this prompt's own. */
const YES_NO_RM_RF = [
  `${TOOL_USE} Cleaning up before the release.`,
  '',
  '$ rm -rf /tmp/build',
  'Proceed? (y/n)',
].join('\n');

// ---------------------------------------------------------------------------

describe('Issue #1699: deny patterns match the current prompt, not the scrollback', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  describe('multiple_choice path (prompt-detect-multiple-choice.ts)', () => {
    it('keeps a previous turn out of approvalTarget', () => {
      const promptData = promptOf('claude', CLAUDE_EDIT_AFTER_RM_RF);

      expect(promptData.type).toBe('multiple_choice');
      // Guard the fixture: the pane really does still show the approved command.
      expect(promptData.instructionText).toContain('rm -rf $SP/tmp');
      expect(promptData.approvalTarget).toBeDefined();
      expect(promptData.approvalTarget).not.toContain('rm -rf');
      // ...and the panel's own content survived the narrowing.
      expect(promptData.approvalTarget).toContain('src/lib/polling/auto-yes-resolver.ts');
    });

    it('answers the unrelated edit prompt instead of suppressing it', () => {
      const resolution = resolveAutoAnswerWithPolicy(
        promptOf('claude', CLAUDE_EDIT_AFTER_RM_RF),
        DENY_RM_RF,
      );

      expect(resolution.suppressedBy).toBeNull();
      expect(resolution.answer).toBe('1');
    });

    it('still suppresses when rm -rf is what the prompt is asking for', () => {
      const promptData = promptOf('claude', CLAUDE_RM_RF_PERMISSION);
      expect(promptData.approvalTarget).toContain('rm -rf $SP/tmp');

      const resolution = resolveAutoAnswerWithPolicy(promptData, DENY_RM_RF);
      expect(resolution.answer).toBeNull();
      expect(resolution.suppressedBy).toBe('deny-pattern');
      expect(resolution.pattern).toBe('rm -rf');
    });

    it('still suppresses when only approvalTarget carries the command', () => {
      const promptData = promptOf('claude', CLAUDE_RM_RF_WITH_LONG_DESCRIPTION);
      // The command is out of reach of the question window, so nothing but
      // approvalTarget can catch it — stopping the escalation here would be the
      // "disable the guard" non-fix.
      expect(promptData.question).not.toContain('rm -rf');
      expect(promptData.options.map(o => (o as { label: string }).label).join(' ')).not.toContain(
        'rm -rf',
      );
      expect(promptData.approvalTarget).toContain('rm -rf $SP/tmp');

      const resolution = resolveAutoAnswerWithPolicy(promptData, DENY_RM_RF);
      expect(resolution.answer).toBeNull();
      expect(resolution.suppressedBy).toBe('deny-pattern');
    });
  });

  describe('yes_no path (prompt-detector.ts)', () => {
    it('keeps a previous turn out of approvalTarget', () => {
      const promptData = promptOf('claude', YES_NO_AFTER_RM_RF);

      expect(promptData.type).toBe('yes_no');
      // instructionText was the whole 20-line tail — that is the bug's fuel.
      expect(promptData.instructionText).toContain('rm -rf /tmp/build');
      expect(promptData.approvalTarget).toBe('Overwrite the existing config file? (y/n)');
    });

    it('answers the unrelated yes/no prompt instead of suppressing it', () => {
      const resolution = resolveAutoAnswerWithPolicy(
        promptOf('claude', YES_NO_AFTER_RM_RF),
        DENY_RM_RF,
      );

      expect(resolution.suppressedBy).toBeNull();
      expect(resolution.answer).toBe('y');
    });

    it('still suppresses when rm -rf sits directly above the question', () => {
      const promptData = promptOf('claude', YES_NO_RM_RF);
      expect(promptData.approvalTarget).toContain('rm -rf /tmp/build');

      const resolution = resolveAutoAnswerWithPolicy(promptData, DENY_RM_RF);
      expect(resolution.answer).toBeNull();
      expect(resolution.suppressedBy).toBe('deny-pattern');
      expect(resolution.pattern).toBe('rm -rf');
    });
  });

  /**
   * The constructed frames above pin the shape; this one pins reality. Every
   * byte of `approval-run-command.txt` came off a live codex-cli 0.146.0 pane
   * (see codex-approval-live-capture-1628.test.ts), and it happens to contain
   * exactly the pattern that caused the outage: two commands approved in
   * earlier turns, still printed above an unrelated approval request.
   */
  describe('a real Codex capture with earlier approvals still on the pane', () => {
    const pane = readFileSync(
      fileURLToPath(new URL('./fixtures/codex-live-1628/approval-run-command.txt', import.meta.url)),
      'utf8',
    );
    const policy = (denyPatterns: string[]): AutoYesPolicy => ({
      mode: 'allow-listed',
      allowPromptTypes: ['multiple_choice'],
      denyPatterns,
    });

    it('drops the earlier turns from approvalTarget and keeps the current command', () => {
      const promptData = promptOf('codex', pane);

      // Fixture guard: the pane really does still show both earlier approvals.
      expect(promptData.instructionText).toContain('You approved codex to run mkdir -p scripts');
      expect(promptData.instructionText).toContain('Ran ls -ld scripts');

      expect(promptData.approvalTarget).not.toContain('You approved codex');
      expect(promptData.approvalTarget).not.toContain('mkdir -p scripts');
      expect(promptData.approvalTarget).toContain('$ git add scripts/greet.sh');
    });

    it('is not suppressed by a pattern that only matches a finished turn', () => {
      const resolution = resolveAutoAnswerWithPolicy(promptOf('codex', pane), policy(['mkdir -p']));

      expect(resolution.suppressedBy).toBeNull();
      expect(resolution.answer).toBe('1');
    });

    it('is still suppressed by a pattern matching the command it asks about', () => {
      const resolution = resolveAutoAnswerWithPolicy(promptOf('codex', pane), policy(['git add']));

      expect(resolution.answer).toBeNull();
      expect(resolution.suppressedBy).toBe('deny-pattern');
    });
  });

  describe('display context is untouched (requirement 3)', () => {
    it('leaves instructionText as the wide window PromptPanel renders', () => {
      // PromptPanel / MobilePromptSheet read instructionText for context; the
      // fix must narrow the *judgement* surface only.
      for (const pane of [CLAUDE_EDIT_AFTER_RM_RF, CLAUDE_RM_RF_PERMISSION, YES_NO_AFTER_RM_RF]) {
        const { instructionText, approvalTarget } = promptOf('claude', pane);
        expect(instructionText).toBeDefined();
        expect(instructionText!.length).toBeGreaterThanOrEqual(approvalTarget!.length);
      }
    });
  });
});
