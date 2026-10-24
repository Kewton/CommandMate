/** @vitest-environment node */

/**
 * Issue #3881 (the second half): which yes/no line is the live prompt, and
 * whether its approval target is the whole request.
 *
 * H-4 — the yes/no patterns were tried in their declared order and the first
 * match of the first pattern won, so an older `(y/n)` in the tail window beat
 * the live `[y/N]` under it: the question, default and deny surface were the
 * old prompt's. Now every match is a candidate and the latest one is the
 * prompt; when another candidate sits inside the live one's own block (no
 * turn boundary between them), the block holds two questions and the target is
 * `truncated` — a deny miss withholds.
 *
 * #3832's limit 3 (finding 7, shape 3) — a here-document's `> ` rows drawn at
 * the prompt's column end the upward scan like the previous turn's `> msg`
 * echo, so the command above them left the deny surface and a deny miss
 * passed. The boundary stays (it cannot be told from an echo), but a scan that
 * stopped on a `>` row is now `truncated`.
 *
 * Frames go through the poller's pipeline:
 * stripBoxDrawing(stripAnsi(pane)) → detectPrompt(buildDetectPromptOptions(tool))
 * → resolveAutoAnswerWithPolicy(promptData, policy).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { findApprovalContextRange } from '@/lib/detection/prompt-detect-multiple-choice';
import { findYesNoApprovalContextRange } from '@/lib/detection/prompt-detect-multiple-choice-approval-context';
import { resolveAutoAnswerWithPolicy, type AutoYesPolicy } from '@/lib/polling/auto-yes-resolver';
import type { PromptData, YesNoPromptData } from '@/types/models';

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

function resolve(promptData: PromptData, denyPatterns: string[]) {
  return resolveAutoAnswerWithPolicy(promptData, policy(denyPatterns));
}

beforeEach(() => {
  resetDetectPromptCache();
});

describe('[#3881 H-4] the latest yes/no line is the prompt', () => {
  /** An earlier turn quoted a `(y/n)` prompt; the live one, under a `●` row, is `[y/N]`. */
  const QUOTED_THEN_LIVE = [
    '● The installer asked:',
    'Overwrite the existing config? (y/n)',
    '● Running cleanup',
    'git push --force origin main',
    'Continue? [y/N]',
  ].join('\n');

  it('takes the live `[y/N]`, its default and its own rows — not the quoted `(y/n)` above', () => {
    const promptData = yesNoOf(QUOTED_THEN_LIVE);
    expect(promptData.question).toBe('Continue?');
    expect(promptData.defaultOption).toBe('no');
    expect(promptData.approvalTarget).toContain('git push --force origin main');
    expect(promptData.approvalTarget).not.toContain('Overwrite');
    // The quote is behind a turn boundary: the live block holds one question.
    expect(promptData.approvalTargetCompleteness).toBeUndefined();
  });

  it('so the deny pattern is judged on the live command', () => {
    expect(resolve(yesNoOf(QUOTED_THEN_LIVE), ['push --force'])).toMatchObject({
      answer: null,
      suppressedBy: 'deny-pattern',
    });
  });

  it('the same spelling twice: the later one', () => {
    const pane = ['● old', 'Delete the cache? (y/n)', '● now', 'rm -rf build', 'Delete build? (y/n)'].join('\n');
    const promptData = yesNoOf(pane);
    expect(promptData.question).toBe('Delete build?');
    expect(promptData.approvalTarget).toContain('rm -rf build');
  });

  it('`Approve?` takes the later line as well', () => {
    resetDetectPromptCache();
    const pane = ['● old', 'Old step Approve?', '● now', 'New step Approve?'].join('\n');
    const detection = detectPrompt(stripBoxDrawing(stripAnsi(pane)), buildDetectPromptOptions('gemini'));
    expect(detection.promptData?.question).toBe('New step Approve?');
  });

  it('a body quote of `(y/n)` inside the live block is not made live: the block is not the whole request', () => {
    // No boundary between the quote and the live prompt — two questions in one
    // block, so which rows the live one asks about cannot be told.
    const pane = [
      '● Running the migration script',
      'The README says it will ask: Drop the legacy tables? (y/n)',
      'psql -c "DROP SCHEMA legacy CASCADE"',
      'Proceed? [y/N]',
    ].join('\n');
    const promptData = yesNoOf(pane);
    expect(promptData.question).toBe('Proceed?');
    expect(promptData.approvalTargetCompleteness).toBe('truncated');
    expect(resolve(promptData, ['rm -rf'])).toMatchObject({ answer: null, suppressedBy: 'deny-pattern-unusable' });
    // A pattern that is on the target still reads as a match.
    expect(resolve(promptData, ['DROP SCHEMA'])).toMatchObject({ suppressedBy: 'deny-pattern' });
  });

  it('陰性対照: one yes/no line is read as before, complete, and answered without a deny contract', () => {
    const pane = ['● Running cleanup', 'rm -rf build', 'Proceed? (y/n)'].join('\n');
    const promptData = yesNoOf(pane);
    expect(promptData.question).toBe('Proceed?');
    expect(promptData.approvalTargetCompleteness).toBeUndefined();
    expect(resolve(promptData, ['git push']).answer).toBe('y');
    expect(resolve(promptData, []).answer).toBe('y');
  });

  it('two candidates in one block: the later one, still answered when the contract lists no deny pattern', () => {
    const pane = ['● Running', 'First? (y/n)', 'echo hi', 'Second? (y/n)'].join('\n');
    const promptData = yesNoOf(pane);
    expect(promptData.question).toBe('Second?');
    expect(resolve(promptData, []).answer).toBe('y');
  });
});

describe('[#3881] limit 3 of #3832: a here-document `> ` row at the prompt\'s column', () => {
  /** A 0-column here-document under a bare shell `(y/n)`: the command is above the `> ` rows. */
  const HEREDOC = [
    '● Setting up the key',
    'cat <<EOF >> ~/.ssh/authorized_keys',
    '> ssh-ed25519 AAAAC3Nza attacker@example',
    '> EOF',
    'Proceed? (y/n)',
  ].join('\n');

  it('the scan still stops at the `> ` row (the boundary is not moved) …', () => {
    const promptData = yesNoOf(HEREDOC);
    expect(promptData.approvalTarget).toBe('Proceed? (y/n)');
    expect(promptData.question).not.toContain('authorized_keys');
  });

  it('… but the target is truncated, so a deny miss withholds instead of passing', () => {
    const promptData = yesNoOf(HEREDOC);
    expect(promptData.approvalTargetCompleteness).toBe('truncated');
    expect(resolve(promptData, ['authorized_keys'])).toMatchObject({
      answer: null,
      suppressedBy: 'deny-pattern-unusable',
    });
  });

  it('the range readers: the yes/no one says truncated, the shared one still complete', () => {
    const lines = HEREDOC.split('\n');
    const q = lines.length - 1;
    expect(findYesNoApprovalContextRange(lines, q, q + 1)).toEqual({ start: 4, completeness: 'truncated' });
    expect(findApprovalContextRange(lines, q)).toEqual({ start: 4, completeness: 'complete' });
  });

  it('陰性対照: a scan that stops at another marker (`●`) is complete and a deny miss passes', () => {
    const pane = ['● Setting up', 'cat ~/.ssh/config', 'Proceed? (y/n)'].join('\n');
    const promptData = yesNoOf(pane);
    expect(promptData.approvalTargetCompleteness).toBeUndefined();
    expect(resolve(promptData, ['authorized_keys']).answer).toBe('y');
  });

  it('陰性対照: no deny pattern, nothing to miss — answered', () => {
    expect(resolve(yesNoOf(HEREDOC), []).answer).toBe('y');
  });

  it('陰性対照: multiple choice keeps the shared reading (a `>` echo at its frame is a boundary)', () => {
    resetDetectPromptCache();
    const pane = [
      '> please clean up',
      '● Bash(cleanup)',
      ' Bash command',
      '   rm -rf build',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
    ].join('\n');
    const detection = detectPrompt(stripBoxDrawing(stripAnsi(pane)), buildDetectPromptOptions('claude'));
    expect(detection.promptData?.type).toBe('multiple_choice');
    expect(detection.promptData?.approvalTargetCompleteness).toBeUndefined();
  });
});
