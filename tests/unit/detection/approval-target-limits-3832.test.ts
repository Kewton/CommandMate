/** @vitest-environment node */

/**
 * Issue #3832: the limits #3817 (PR #3831) left in the deny surface.
 *
 * Measured first (dev-reports/issue/3832/measurement.md): of the four shapes,
 * two are fixed here.
 *
 *   2. A body that happens to take the shape of an older tool-use block
 *      (a marker row at the frame's column, a frame row, deeper rows that are
 *      all result markers) cut the deny surface at those result rows. The frame
 *      row is now read as an older panel's header only when the current panel
 *      draws the same header — `Command` above `⎿ User declined` above
 *      `Command` on agy's live screen — so a command row followed by an
 *      indented `└──` tree stays in `approvalTarget`.
 *   4. `question` took the 5 rows above the question whatever they were, and
 *      on real screens they carried the previous turn (codex's `• HTTP/2 200` /
 *      `Worked for 17s` above the user's `›` echo; claude's `⏺ IMPL_COMPLETED`
 *      / `✻ Cogitated …` above its `❯` echo in the production log). It now
 *      stops at the user's echo: nothing above the message that opened the
 *      current turn belongs to the prompt.
 *
 * Shapes 1 and 3 did not appear on the measured screens and are left as the
 * comments on `findApprovalContextStart` describe.
 *
 * Frames go through the poller's pipeline:
 * stripBoxDrawing(stripAnsi(pane)) → detectPrompt(buildDetectPromptOptions(tool))
 * → resolveAutoAnswerWithPolicy(promptData, policy).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach } from 'vitest';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { findApprovalContextStart } from '@/lib/detection/prompt-detect-multiple-choice';
import { resolveAutoAnswerWithPolicy, type AutoYesPolicy } from '@/lib/polling/auto-yes-resolver';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { PromptData } from '@/types/models';

function policy(denyPatterns: string[]): AutoYesPolicy {
  return { mode: 'allow-listed', allowPromptTypes: ['yes_no', 'multiple_choice'], denyPatterns };
}

function promptOf(pane: string, tool: CLIToolType = 'claude'): PromptData {
  resetDetectPromptCache();
  const detection = detectPrompt(stripBoxDrawing(stripAnsi(pane)), buildDetectPromptOptions(tool));
  expect(detection.isPrompt).toBe(true);
  return detection.promptData!;
}

function fixture(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../fixtures/${relative}`, import.meta.url)), 'utf8');
}

describe('Issue #3832 (2): a body shaped like a tool-use block does not cut the deny surface', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  /** A 0-column command whose output is an indented `└──` tree, under a `●` row. */
  const YES_NO_TREE = [
    '● Running the cleanup',
    'rm -rf build && tree src',
    '  └── index.ts',
    '  └── lib',
    'Proceed? (y/n)',
  ].join('\n');

  it('yes/no: the command above a `└──` tree stays in approvalTarget and is denied', () => {
    const promptData = promptOf(YES_NO_TREE);
    expect(promptData.type).toBe('yes_no');
    // Fixture guard: only approvalTarget can carry the command.
    expect(promptData.question).not.toContain('rm -rf');
    expect(promptData.approvalTarget).toContain('rm -rf build && tree src');
    expect(promptData.approvalTarget).toContain('└── lib');
    expect(promptData.approvalTarget).not.toContain('Running the cleanup');

    const resolution = resolveAutoAnswerWithPolicy(promptData, policy(['rm -rf']));
    expect(resolution.answer).toBeNull();
    expect(resolution.suppressedBy).toBe('deny-pattern');
  });

  it('multiple choice: the same body under a frame at column 0 is denied', () => {
    const pane = [
      '● Bash(cleanup)',
      'rm -rf build && tree src',
      '  ├── index.ts',
      '  └── lib',
      '',
      'Remove the build directory and list',
      'what is left under src so the next',
      'step can check the layout.',
      '',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
    ].join('\n');
    const promptData = promptOf(pane);
    expect(promptData.type).toBe('multiple_choice');
    expect(promptData.question).not.toContain('rm -rf');
    expect(promptData.approvalTarget).toContain('rm -rf build && tree src');

    const resolution = resolveAutoAnswerWithPolicy(promptData, policy(['rm -rf']));
    expect(resolution.answer).toBeNull();
    expect(resolution.suppressedBy).toBe('deny-pattern');
  });

  it('a pattern that is nowhere on the prompt is still answered (negative control)', () => {
    const resolution = resolveAutoAnswerWithPolicy(promptOf(YES_NO_TREE), policy(['git push']));
    expect(resolution.suppressedBy).toBeNull();
  });

  it('an older panel with the same header as the current one is still the previous turn', () => {
    // The review's order (#3817) and the bare scan: the current `Command`
    // header repeats the older one, so the older `⎿` result ends the scan.
    const lines = ['● old', 'Command', '  ⎿ rm -rf old', 'Command', '   pwd', 'Proceed? (y/n)'];
    expect(findApprovalContextStart(lines, 5)).toBe(3);
    // A frame row the current panel does not draw is body: scanned past.
    const body = ['● old', 'rm -rf build', '  └── src', 'Command', '   pwd', 'Proceed? (y/n)'];
    expect(findApprovalContextStart(body, 5)).toBe(1);
  });

  /**
   * agy's live screen (`live-region-3183`): a declined call's `● Bash(…)` /
   * `Command` / `  ⎿ User declined the tool call` above the current
   * `Command` panel — the shape the exception exists for, on a real capture.
   */
  it('agy live screen: the declined call above the current panel stays out', () => {
    const promptData = promptOf(fixture('live-region-3183/quoted-dialog-idle-antigravity.txt'), 'antigravity');
    expect(promptData.approvalTarget).toContain('Requesting permission for:');
    expect(promptData.approvalTarget).toContain('python3 -c "import platform, sys;');
    expect(promptData.approvalTarget).not.toContain('User declined the tool call');
    expect(promptData.approvalTarget).not.toContain('● Bash(');
  });
});

describe('Issue #3832 (4): question does not reach above the user\'s echo', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  /** claude, compact: the previous turn's `rm -rf` sits inside question's 5-row window. */
  const CLAUDE_EDIT_AFTER_ECHO = [
    '⏺ Bash(rm -rf $SP/old)',
    '  ⎿  (No content)',
    '✻ Baked for 3s',
    '❯ now update the resolver',
    ' Edit file',
    ' Do you want to make this edit to auto-yes-resolver.ts?',
    ' ❯ 1. Yes',
    '   2. No',
  ].join('\n');

  it('claude: the previous turn above the `❯` echo is not in question and is not denied', () => {
    const promptData = promptOf(CLAUDE_EDIT_AFTER_ECHO);
    expect(promptData.type).toBe('multiple_choice');
    expect(promptData.question).not.toContain('rm -rf');
    expect(promptData.question).not.toContain('Baked for');
    expect(promptData.question).toContain('Do you want to make this edit');
    expect(promptData.approvalTarget).not.toContain('rm -rf');

    const resolution = resolveAutoAnswerWithPolicy(promptData, policy(['rm -rf']));
    expect(resolution.suppressedBy).toBeNull();
    expect(resolution.answer).toBe('1');
  });

  it('claude: the command between the echo and the question stays in question (negative control)', () => {
    const pane = [
      '✻ Baked for 3s',
      '❯ clean the scratch dir',
      ' Bash command',
      '   rm -rf $SP/tmp',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
    ].join('\n');
    const promptData = promptOf(pane);
    expect(promptData.question).toContain('rm -rf $SP/tmp');
    expect(promptData.question).not.toContain('Baked for');

    const resolution = resolveAutoAnswerWithPolicy(promptData, policy(['rm -rf']));
    expect(resolution.answer).toBeNull();
    expect(resolution.suppressedBy).toBe('deny-pattern');
  });

  /**
   * codex's live screen (`codex-multiline-composer-3205/tc104`): the finished
   * curl turn's `• HTTP/2 200` / `Worked for 17s` sit within 5 rows of the
   * approval's question, above the user's `›` echo.
   */
  it('codex live screen: the finished turn above the `›` echo is not in question', () => {
    const live = fixture('codex-multiline-composer-3205/tc104-raw-pane.txt');
    const promptData = promptOf(live, 'codex');
    expect(promptData.type).toBe('multiple_choice');
    expect(promptData.question).toContain('Would you like to run the following command?');
    expect(promptData.question).not.toContain('HTTP/2 200');
    expect(promptData.question).not.toContain('Worked for');

    const resolution = resolveAutoAnswerWithPolicy(promptData, policy(['HTTP/2']));
    expect(resolution.suppressedBy).toBeNull();
  });

  /**
   * Review (P3): a body row that starts with the echo's glyph is not the echo.
   * `approvalTarget` already cuts at it, so `question`'s window is what keeps
   * the command above it in the deny surface.
   */
  it('a `❯ ` / `› ` body row under the command does not cut question (claude and codex shapes)', () => {
    const panes: Array<[CLIToolType, string[]]> = [
      // claude: frame at column 1, the body row left of it.
      ['claude', [' Bash command', '   rm -rf x', '❯ quoted', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No']],
      // claude: frame at column 0, the body row at the frame's column.
      ['claude', ['Bash command', '  rm -rf x', '❯ quoted', 'Do you want to proceed?', '❯ 1. Yes', '  2. No']],
      // codex: the `› 1.` cursor at column 0.
      ['codex', [
        'Would you like to run the following command?', '  $ rm -rf x', '› quoted', 'Run it?',
        '› 1. Yes, proceed (y)', '  2. No (esc)',
      ]],
    ];
    for (const [tool, lines] of panes) {
      const promptData = promptOf(lines.join('\n'), tool);
      expect(promptData.type).toBe('multiple_choice');
      expect(promptData.question).toContain('rm -rf x');

      const resolution = resolveAutoAnswerWithPolicy(promptData, policy(['rm -rf']));
      expect(resolution.answer).toBeNull();
      expect(resolution.suppressedBy).toBe('deny-pattern');
    }
  });

  /**
   * `>` is not an echo it can trust (#3817's shape 3): codex's trust dialog
   * opens with `> You are in <dir>`. That row is cut from approvalTarget, and
   * question is what keeps it in the deny surface.
   */
  it('codex trust dialog: the `> You are in` row stays in question', () => {
    const promptData = promptOf(fixture('codex-dialogs-0155/dialog-trust-directory.txt'), 'codex');
    expect(promptData.question).toContain('You are in /private/var/folders');
    const resolution = resolveAutoAnswerWithPolicy(promptData, policy(['codex0155-probe']));
    expect(resolution.suppressedBy).toBe('deny-pattern');
  });
});
