/** @vitest-environment node */

/**
 * Issue #3881, the first review of the second half (review-3881-b2 (2)).
 *
 * N1 — `Approve?` was a fallback tried only when none of the four yes/no
 * spellings matched, so an older `Old? (y/n)` beat the live `Approve?` under
 * it (and its old rows were the deny surface), and `Approve?`s in one block
 * were never compared. The five spellings are now one candidate set.
 *
 * N2 — a yes/no scan whose start was set by a deeper `> ` row (a
 * here-document indented under its command, below a `●` boundary) cut the
 * command with it, but only the `●` row was checked, so the target read as
 * complete and a deny miss passed. Every cut row is checked now.
 *
 * Positive controls fail on the implementation before this change; negative
 * controls hold on both.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { findApprovalContextRange } from '@/lib/detection/prompt-detect-multiple-choice';
import { findYesNoApprovalContextRange } from '@/lib/detection/prompt-detect-multiple-choice-approval-context';
import { resolveAutoAnswerWithPolicy, type AutoYesPolicy } from '@/lib/polling/auto-yes-resolver';
import type { YesNoPromptData } from '@/types/models';

function policy(denyPatterns: string[]): AutoYesPolicy {
  return { mode: 'allow-listed', allowPromptTypes: ['yes_no', 'multiple_choice'], denyPatterns };
}

function yesNoOf(pane: string): YesNoPromptData {
  resetDetectPromptCache();
  const detection = detectPrompt(stripBoxDrawing(stripAnsi(pane)), buildDetectPromptOptions('gemini'));
  expect(detection.isPrompt).toBe(true);
  expect(detection.promptData?.type).toBe('yes_no');
  return detection.promptData as YesNoPromptData;
}

beforeEach(() => {
  resetDetectPromptCache();
});

describe('[#3881 review N1] Approve? is one of the five candidates', () => {
  it('an older (y/n), then a live Approve?: the Approve? and its own rows', () => {
    const promptData = yesNoOf(['● old', 'Old? (y/n)', '● now', 'rm -rf build', 'Approve?'].join('\n'));
    expect(promptData.question).toBe('Approve?');
    expect(promptData.approvalTarget).toContain('rm -rf build');
    expect(promptData.approvalTarget).not.toContain('Old?');
    expect(promptData.approvalTargetCompleteness).toBeUndefined();
    expect(resolveAutoAnswerWithPolicy(promptData, policy(['rm -rf']))).toMatchObject({
      answer: null,
      suppressedBy: 'deny-pattern',
    });
  });

  it('the reverse: an older Approve?, then a live [y/N] (its default)', () => {
    const promptData = yesNoOf(['● old', 'Old step Approve?', '● now', 'git push', 'Push? [y/N]'].join('\n'));
    expect(promptData.question).toBe('Push?');
    expect(promptData.defaultOption).toBe('no');
    expect(promptData.approvalTarget).not.toContain('Old step');
  });

  it('two Approve? in one block: contested, so the target is not the whole request', () => {
    const promptData = yesNoOf(['● Running', 'First step Approve?', 'rm -rf build', 'Second step Approve?'].join('\n'));
    expect(promptData.question).toBe('Second step Approve?');
    expect(promptData.approvalTargetCompleteness).toBe('truncated');
    expect(resolveAutoAnswerWithPolicy(promptData, policy(['git push']))).toMatchObject({
      answer: null,
      suppressedBy: 'deny-pattern-unusable',
    });
  });

  it('a (y/n) and an Approve? in one block are contested the same way', () => {
    const promptData = yesNoOf(['● Running', 'Overwrite? (y/n)', 'cp a b', 'Copy Approve?'].join('\n'));
    expect(promptData.question).toBe('Copy Approve?');
    expect(promptData.approvalTargetCompleteness).toBe('truncated');
  });

  it('陰性対照: a single Approve? is read as before and answered', () => {
    const promptData = yesNoOf(['● Running', 'rm -rf build', 'Approve?'].join('\n'));
    expect(promptData.question).toBe('Approve?');
    expect(promptData.approvalTargetCompleteness).toBeUndefined();
    expect(resolveAutoAnswerWithPolicy(promptData, policy(['git push'])).answer).toBe('y');
  });
});

describe('[#3881 review N2] every cut row is checked, not only the boundary', () => {
  /** A here-document indented two columns under its command, under a `●` boundary. */
  const DEEP_HEREDOC = [
    '● task',
    '  cat <<EOF >> ~/.ssh/authorized_keys',
    '  > ssh-ed25519 AAAAC3Nza attacker@example',
    '  > EOF',
    'Proceed? (y/n)',
  ].join('\n');

  it('a deeper `> ` set the start: truncated, and a deny miss withholds', () => {
    const lines = DEEP_HEREDOC.split('\n');
    // The start is below the deepest `>` (the boundary is not moved) …
    expect(findApprovalContextRange(lines, 4)).toEqual({ start: 4, completeness: 'complete' });
    // … and the yes/no reading says what was cut.
    expect(findYesNoApprovalContextRange(lines, 4, 5)).toEqual({ start: 4, completeness: 'truncated' });
    const promptData = yesNoOf(DEEP_HEREDOC);
    expect(promptData.approvalTarget).toBe('Proceed? (y/n)');
    expect(promptData.approvalTargetCompleteness).toBe('truncated');
    expect(resolveAutoAnswerWithPolicy(promptData, policy(['authorized_keys']))).toMatchObject({
      answer: null,
      suppressedBy: 'deny-pattern-unusable',
    });
  });

  it('陰性対照: a `> ` at the frame\'s column (the first fix) stays truncated', () => {
    const pane = ['● task', 'cat <<EOF >> ~/.ssh/authorized_keys', '> key', '> EOF', 'Proceed? (y/n)'].join('\n');
    expect(yesNoOf(pane).approvalTargetCompleteness).toBe('truncated');
  });

  it('陰性対照: an ordinary deeper result marker (`⎿`) under the boundary is complete', () => {
    const pane = ['● Bash(ls)', '  ⎿ a.txt', '  ⎿ b.txt', 'Proceed? (y/n)'].join('\n');
    const promptData = yesNoOf(pane);
    expect(promptData.approvalTargetCompleteness).toBeUndefined();
    expect(resolveAutoAnswerWithPolicy(promptData, policy(['authorized_keys'])).answer).toBe('y');
  });

  it('陰性対照: the target is not widened into the older turn', () => {
    const promptData = yesNoOf(DEEP_HEREDOC);
    expect(promptData.approvalTarget).not.toContain('● task');
    expect(promptData.approvalTarget).not.toContain('cat <<EOF');
  });
});
