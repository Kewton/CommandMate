/**
 * Issue #3881 acceptance (3), H-3: an approval target cut at the 12-row cap is
 * not the whole request, and a deny pattern's miss on it is not a pass.
 *
 * `findApprovalContextStart` walks up at most `APPROVAL_TARGET_MAX_LOOKBACK`
 * rows. Before #3881 a scan that ran out there returned the same kind of
 * number as one that stopped at the previous turn's marker, and
 * `joinApprovalTarget` made either an ordinary string — so a command whose
 * only `rm -rf` sits 13 rows above a yes/no question reached neither
 * `question` nor `approvalTarget`, and the resolver answered `y` under a
 * contract that denies `rm -rf`.
 *
 * 陽性対照: the same prompt with the new field taken off (what the resolver
 * was handed before) is answered — the defect, reproduced. 陰性対照: a
 * boundary marker, blank rows above the cap, a contract without deny patterns,
 * and a pattern that matches what was read all behave exactly as before.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import {
  APPROVAL_TARGET_MAX_LOOKBACK,
  findApprovalContextRange,
  findApprovalContextStart,
} from '@/lib/detection/prompt-detect-multiple-choice';
import {
  resolveAutoAnswerWithPolicy,
  type AutoYesPolicy,
} from '@/lib/polling/auto-yes-resolver';
import type { PromptData } from '@/types/models';

const DENY_RM: AutoYesPolicy = { mode: null, allowPromptTypes: [], denyPatterns: ['rm -rf'] };
const NO_DENY: AutoYesPolicy = { mode: null, allowPromptTypes: [], denyPatterns: [] };

/** `rows` unmarked continuation rows — a long command's arguments, a here-document body. */
function body(rows: number): string[] {
  return Array.from({ length: rows }, (_, i) => `  build/artifact-${i}.o \\`);
}

/** A bare shell yes/no with the command's first row `distance` rows above the question. */
function shellYesNo(distance: number, above: string[] = []): string {
  return [...above, 'rm -rf build/cache \\', ...body(distance - 1), 'Proceed? (y/n)'].join('\n');
}

function promptOf(frame: string): PromptData {
  const result = detectPrompt(frame);
  if (!result.isPrompt || !result.promptData) throw new Error('no prompt');
  return result.promptData;
}

describe('[#3881] findApprovalContextRange says whether the top is a boundary', () => {
  it('a scan that runs out at the cap with rows above it is truncated', () => {
    const lines = shellYesNo(APPROVAL_TARGET_MAX_LOOKBACK + 1).split('\n');
    const q = lines.length - 1;
    const range = findApprovalContextRange(lines, q);
    expect(range).toEqual({ start: q - APPROVAL_TARGET_MAX_LOOKBACK, completeness: 'truncated' });
    // The start is the number it always was.
    expect(findApprovalContextStart(lines, q)).toBe(range.start);
  });

  it('陰性対照: a scan that stops at a marker is complete', () => {
    const lines = ['⏺ Bash(earlier)', ...shellYesNo(APPROVAL_TARGET_MAX_LOOKBACK - 2).split('\n')];
    const range = findApprovalContextRange(lines, lines.length - 1);
    expect(range).toEqual({ start: 1, completeness: 'complete' });
  });

  it('陰性対照: a scan that runs out at the cap over blank rows only is complete', () => {
    const lines = ['', '', ...shellYesNo(APPROVAL_TARGET_MAX_LOOKBACK).split('\n')];
    const range = findApprovalContextRange(lines, lines.length - 1);
    expect(range.completeness).toBe('complete');
  });

  it('a scan that reaches the frame’s first row without a boundary says the top is unknown', () => {
    const lines = shellYesNo(3).split('\n');
    expect(findApprovalContextRange(lines, lines.length - 1)).toEqual({ start: 0, completeness: 'top-unknown' });
  });
});

describe('[#3881] the yes/no detector carries the truncation to the prompt', () => {
  it('13 rows up: the command is outside both deny texts, and the prompt says so', () => {
    const promptData = promptOf(shellYesNo(APPROVAL_TARGET_MAX_LOOKBACK + 1));
    expect(promptData.question).toBe('Proceed?');
    expect(promptData.approvalTarget).not.toContain('rm -rf');
    expect(promptData.approvalTargetCompleteness).toBe('truncated');
  });

  it('the detection result carries the rows and the completeness', () => {
    const frame = shellYesNo(APPROVAL_TARGET_MAX_LOOKBACK + 1);
    const last = frame.split('\n').length - 1;
    expect(detectPrompt(frame).approvalContext).toEqual({
      startRow: last - APPROVAL_TARGET_MAX_LOOKBACK,
      endRow: last + 1,
      completeness: 'truncated',
    });
  });

  it('陰性対照: within the cap nothing is added to the prompt', () => {
    const promptData = promptOf(shellYesNo(APPROVAL_TARGET_MAX_LOOKBACK));
    expect(promptData.approvalTarget).toContain('rm -rf');
    expect(promptData).not.toHaveProperty('approvalTargetCompleteness');
  });
});

describe('[#3881] the resolver does not take a miss on a truncated target as a pass', () => {
  it('withholds under a deny contract (`deny-pattern-unusable`, no pattern named)', () => {
    const promptData = promptOf(shellYesNo(APPROVAL_TARGET_MAX_LOOKBACK + 1));
    expect(resolveAutoAnswerWithPolicy(promptData, DENY_RM)).toEqual({
      answer: null,
      suppressedBy: 'deny-pattern-unusable',
      pattern: undefined,
    });
  });

  it('陽性対照: handed the prompt as it was before #3881, the resolver answers `y`', () => {
    const { approvalTargetCompleteness: _dropped, ...before } = promptOf(shellYesNo(APPROVAL_TARGET_MAX_LOOKBACK + 1));
    expect(resolveAutoAnswerWithPolicy(before as PromptData, DENY_RM)).toEqual({ answer: 'y', suppressedBy: null });
  });

  it('陰性対照: a pattern that matches the part that was read still names itself', () => {
    const frame = shellYesNo(APPROVAL_TARGET_MAX_LOOKBACK + 1).replace('Proceed? (y/n)', 'Delete artifacts? (y/n)');
    const promptData = promptOf(frame);
    expect(resolveAutoAnswerWithPolicy(promptData, { ...DENY_RM, denyPatterns: ['Delete'] })).toMatchObject({
      suppressedBy: 'deny-pattern',
      pattern: 'Delete',
    });
  });

  it('陰性対照: a contract without deny patterns answers as before (nothing could be missed)', () => {
    const promptData = promptOf(shellYesNo(APPROVAL_TARGET_MAX_LOOKBACK + 1));
    expect(resolveAutoAnswerWithPolicy(promptData, NO_DENY)).toEqual({ answer: 'y', suppressedBy: null });
    expect(resolveAutoAnswerWithPolicy(promptData)).toEqual({ answer: 'y', suppressedBy: null });
  });

  it('陰性対照: a complete target under the same contract is answered as before', () => {
    const lines = ['⏺ Bash(ls)', '  ⎿ done', '❯ next', ...body(3), 'Proceed? (y/n)'];
    const promptData = promptOf(lines.join('\n'));
    expect(promptData).not.toHaveProperty('approvalTargetCompleteness');
    expect(resolveAutoAnswerWithPolicy(promptData, DENY_RM)).toEqual({ answer: 'y', suppressedBy: null });
  });
});

describe('[#3881] the multiple-choice parser carries it too', () => {
  /** A numbered dialog whose command begins `distance` rows above the question. */
  function numberedDialog(distance: number): string {
    return [
      'rm -rf build/cache \\',
      ...body(distance - 1),
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
    ].join('\n');
  }

  it('truncated at the cap: withheld under a deny contract', () => {
    const promptData = promptOf(numberedDialog(APPROVAL_TARGET_MAX_LOOKBACK + 1));
    expect(promptData.type).toBe('multiple_choice');
    expect(promptData.approvalTargetCompleteness).toBe('truncated');
    expect(resolveAutoAnswerWithPolicy(promptData, DENY_RM).suppressedBy).toBe('deny-pattern-unusable');
  });

  it('陰性対照: within the cap the command is read and named', () => {
    const promptData = promptOf(numberedDialog(APPROVAL_TARGET_MAX_LOOKBACK - 1));
    expect(promptData).not.toHaveProperty('approvalTargetCompleteness');
    expect(resolveAutoAnswerWithPolicy(promptData, DENY_RM)).toMatchObject({
      suppressedBy: 'deny-pattern',
      pattern: 'rm -rf',
    });
  });
});
