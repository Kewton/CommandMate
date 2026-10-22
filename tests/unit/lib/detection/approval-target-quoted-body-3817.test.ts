/** @vitest-environment node */

/**
 * Issue #3817 (事象 1): a `> ` row in the body of the command a permission
 * dialog asks about is not the previous turn's boundary.
 *
 * `findApprovalContextStart` stops the upward scan at the nearest transcript
 * marker, and the user's own echo `> msg` is one of them. A here-document's
 * quoted rows (`> quoted`) start with the same glyph, so the scan used to stop
 * inside the command: every row above them — the `cat <<'EOF'` line, an
 * `rm -rf` chained before it — fell out of `approvalTarget`, and with it out of
 * the deny surface (`collectDenyMatchTexts`).
 *
 * The dialog's own frame is what tells them apart: its question and option
 * rows sit at the panel's left edge, and the command it shows is indented
 * deeper than that. A marker row indented deeper than the frame is the panel's
 * body; the previous turn's markers (`⏺`, `> msg`, `❯ msg`, the rule above the
 * panel) are drawn at or left of it.
 *
 * Pinned here:
 *   (a) the command rows above the body's `> ` rows are in `approvalTarget`
 *   (b) a deny pattern on those rows suppresses the answer
 *   (c) the previous turn (the user's `> msg` echo included) stays out (#1699)
 * Issue #1699's own tests (deny-pattern-scope-1699.test.ts) are unchanged.
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
import type { PromptData } from '@/types/models';

const TOOL_USE = '⏺';
const TOOL_RESULT = '⎿';
const CURSOR = '❯';
const RULE = '─'.repeat(60);

function policy(denyPatterns: string[]): AutoYesPolicy {
  return { mode: 'allow-listed', allowPromptTypes: ['yes_no', 'multiple_choice'], denyPatterns };
}

function promptOf(pane: string): PromptData {
  const detection = detectPrompt(stripBoxDrawing(stripAnsi(pane)), buildDetectPromptOptions('claude'));
  expect(detection.isPrompt).toBe(true);
  expect(detection.promptData?.type).toBe('multiple_choice');
  return detection.promptData!;
}

/** The command a here-document permission asks about, as claude indents it in the panel. */
const HEREDOC_COMMAND = [
  "   rm -rf $SP/notes && cat <<'EOF' > notes.md",
  '   > quoted line one',
  '   > quoted line two',
  '   EOF',
];

/** claude's Bash permission panel (2.1.278 shape: frame at column 1, command at 3). */
function bashPanel(command: readonly string[]): string[] {
  return [
    ' Bash command',
    '',
    ...command,
    '   Write the notes file',
    '',
    ' Do you want to proceed?',
    ` ${CURSOR} 1. Yes`,
    "   2. Yes, and don't ask again for cat commands in /repo",
    '   3. No',
    '',
    ' Esc to cancel · Tab to amend',
  ];
}

const HEREDOC_PERMISSION = [
  `${CURSOR} Write the notes file`,
  '',
  `${TOOL_USE} I will write the notes.`,
  '',
  RULE,
  ...bashPanel(HEREDOC_COMMAND),
].join('\n');

/** A previous turn with an `rm -rf` (its `> msg` echo included) above an unrelated here-document. */
const HEREDOC_AFTER_RM_RF = [
  '> clean the scratch dir with rm -rf first',
  '',
  `${TOOL_USE} Bash(rm -rf $SP/old)`,
  `  ${TOOL_RESULT}  (No content)`,
  '',
  RULE,
  ...bashPanel(["   cat <<'EOF' > notes.md", '   > quoted line one', '   EOF']),
].join('\n');

/** The user's `> msg` echo directly above the panel, with no other marker in between. */
const ECHO_DIRECTLY_ABOVE = [
  '> please rm -rf the scratch dir later',
  ...bashPanel(["   cat <<'EOF' > notes.md", '   > quoted line one', '   EOF']),
].join('\n');

describe('Issue #3817: `> ` rows in the command body do not cut approvalTarget', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it('(a) keeps the rows above the body\'s `> ` rows in approvalTarget', () => {
    const promptData = promptOf(HEREDOC_PERMISSION);

    expect(promptData.approvalTarget).toContain("rm -rf $SP/notes && cat <<'EOF' > notes.md");
    expect(promptData.approvalTarget).toContain('> quoted line one');
    expect(promptData.approvalTarget).toContain('Bash command');
    // The previous turn stays out.
    expect(promptData.approvalTarget).not.toContain('I will write the notes.');
    expect(promptData.approvalTarget).not.toContain(RULE);
  });

  it('(b) a deny pattern on a row above the `> ` rows suppresses the answer', () => {
    const promptData = promptOf(HEREDOC_PERMISSION);
    // Fixture guard: only approvalTarget carries the command row.
    expect(promptData.question).not.toContain('rm -rf');

    const resolution = resolveAutoAnswerWithPolicy(promptData, policy(['rm -rf']));
    expect(resolution.answer).toBeNull();
    expect(resolution.suppressedBy).toBe('deny-pattern');
    expect(resolution.pattern).toBe('rm -rf');
  });

  it('(b) a pattern that is nowhere on the panel is not suppressed (negative control)', () => {
    const resolution = resolveAutoAnswerWithPolicy(promptOf(HEREDOC_PERMISSION), policy(['git push']));
    expect(resolution.suppressedBy).toBeNull();
    expect(resolution.answer).toBe('1');
  });

  it('(c) the previous turn, its `> msg` echo included, stays out', () => {
    for (const pane of [HEREDOC_AFTER_RM_RF, ECHO_DIRECTLY_ABOVE]) {
      const promptData = promptOf(pane);
      // Fixture guard: the pane does show the earlier `rm -rf`.
      expect(promptData.instructionText).toContain('rm -rf');

      expect(promptData.approvalTarget).toContain("cat <<'EOF' > notes.md");
      expect(promptData.approvalTarget).toContain('> quoted line one');
      expect(promptData.approvalTarget).not.toContain('rm -rf');

      const resolution = resolveAutoAnswerWithPolicy(promptData, policy(['rm -rf']));
      expect(resolution.suppressedBy).toBeNull();
      expect(resolution.answer).toBe('1');
    }
  });

  /**
   * Review P2 (Codex): the previous turn's own panel header above its `  ⎿`
   * result must not be read as this panel's frame. The deeper `⎿` sits above
   * the current panel's header, so it ends the scan.
   */
  it('(c) a deeper marker above the panel\'s header is the previous turn, even under an older header', () => {
    const panel = (description: readonly string[]): string =>
      [
        '● old',
        'Command',
        '  ⎿ rm -rf old',
        'Command',
        '   pwd',
        ...description,
        'Do you want to proceed?',
        `${CURSOR} 1. Yes`,
        '  2. No',
      ].join('\n');

    // The order as the review gave it.
    const exact = promptOf(panel([]));
    expect(exact.approvalTarget).toContain('pwd');
    expect(exact.approvalTarget).not.toContain('rm -rf old');

    // `question` reaches 5 rows above the question (a #1699 residual this Issue
    // leaves alone), so the deny half is judged with the old turn outside it.
    const described = promptOf(panel(['   Print the working directory', '   before the build', '   starts', '']));
    expect(described.question).not.toContain('rm -rf');
    expect(described.approvalTarget).toContain('pwd');
    expect(described.approvalTarget).not.toContain('rm -rf old');

    const resolution = resolveAutoAnswerWithPolicy(described, policy(['rm -rf']));
    expect(resolution.suppressedBy).toBeNull();
    expect(resolution.answer).toBe('1');
  });

  /**
   * Re-review P2 (Codex): a body row drawn at the frame's column (`EOF` of a
   * shell here-document under a yes/no prompt) cannot be told from a panel
   * header, so the deny surface is taken wide: the `> note` row above it is not
   * read as the previous turn, and `rm -rf work` stays in.
   */
  it('(b) a body row at the frame column is not read as a header (yes/no, 0-column EOF)', () => {
    const pane = ['Command', '  rm -rf work && cat <<EOF', '  > note', 'EOF', 'Proceed? (y/n)'].join('\n');
    resetDetectPromptCache();
    const detection = detectPrompt(stripBoxDrawing(stripAnsi(pane)), buildDetectPromptOptions('claude'));
    expect(detection.isPrompt).toBe(true);
    const promptData = detection.promptData!;
    expect(promptData.type).toBe('yes_no');
    expect(promptData.approvalTarget).toContain('rm -rf work && cat <<EOF');
    expect(promptData.approvalTarget).toContain('> note');

    const resolution = resolveAutoAnswerWithPolicy(promptData, policy(['rm -rf']));
    expect(resolution.answer).toBeNull();
    expect(resolution.suppressedBy).toBe('deny-pattern');
  });

  it('(c) a deeper marker above an unmarked transcript row at the frame column is the previous turn', () => {
    expect(findApprovalContextStart(['⏺ x', '  ⎿ rm -rf old', 'some output', 'Proceed? (y/n)'], 3)).toBe(2);
  });

  it('a marker row at the frame\'s own column is still the boundary', () => {
    const lines = ['> earlier', 'Bash command', '  > body', 'Proceed?'];
    expect(findApprovalContextStart(lines, 3)).toBe(1);
    // Without a deeper frame below, the frame is the question row itself.
    expect(findApprovalContextStart(['x', ' > body', ' Proceed?'], 2)).toBe(2);
    // A deeper marker row with no frame row above it is the previous turn
    // (claude's `  ⎿` result between its `⏺` and the panel's header).
    expect(findApprovalContextStart(['⏺ x', '  ⎿ out', '', ' Bash command', '   cmd', ' Proceed?'], 5)).toBe(2);
    // The panel's rows down to `panelEnd` set the frame: options at column 0.
    expect(findApprovalContextStart(['x', ' > body', ' Proceed?', '> 1. Yes', '  2. No'], 2, 5)).toBe(0);
  });

  /**
   * A live claude 2.1.278 Bash permission (`tui-frame-footer-2776`), its
   * one-row command replaced by a here-document: every other byte — the rule,
   * the transcript, the SGR, the footer — is what claude drew.
   */
  it('a live claude Bash permission with a here-document: the whole command is in approvalTarget', () => {
    const live = readFileSync(
      fileURLToPath(new URL('../../../fixtures/tui-frame-footer-2776/claude-2.1.278-bash-approval.txt', import.meta.url)),
      'utf8',
    );
    const commandRow = '   touch probe-marker.txt && echo done';
    expect(live.split('\n')).toContain(commandRow);
    const pane = live.replace(
      commandRow,
      [
        "   rm -rf build && cat <<'EOF' > probe-marker.txt",
        '   > first quoted row',
        '   > second quoted row',
        '   EOF',
      ].join('\n'),
    );

    const promptData = promptOf(pane);
    expect(promptData.approvalTarget).toContain("rm -rf build && cat <<'EOF' > probe-marker.txt");
    expect(promptData.approvalTarget).toContain('> first quoted row');
    expect(promptData.approvalTarget).toContain('> second quoted row');
    expect(promptData.approvalTarget).toContain('EOF');
    // The user's `❯` echo and claude's `⏺` / `⎿` rows above the rule stay out.
    expect(promptData.approvalTarget).not.toContain('Use the Bash tool');
    expect(promptData.approvalTarget).not.toContain('$ touch probe-marker.txt');

    expect(resolveAutoAnswerWithPolicy(promptData, policy(['rm -rf'])).suppressedBy).toBe('deny-pattern');
    // Negative control: the unmodified live frame has nothing to deny.
    resetDetectPromptCache();
    expect(resolveAutoAnswerWithPolicy(promptOf(live), policy(['rm -rf'])).suppressedBy).toBeNull();
  });
});
