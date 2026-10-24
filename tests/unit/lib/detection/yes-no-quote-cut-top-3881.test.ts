/** @vitest-environment node */

/**
 * Issue #3881, the second review of the second half (review-3881-b2-2 (3),
 * N4): a yes/no scan whose start was set by a deeper `> ` row and that ran up
 * to the frame's first row with no boundary was `top-unknown`, and only
 * `complete` was turned into `truncated` — so on a capture known to start at
 * the history's top (`headCut === false` → `history-start`) nothing marked
 * the target incomplete, and `authorized_keys`, on screen above the `> `
 * rows, missed the deny patterns and was answered.
 *
 * Now a cut at a `> ` row is `truncated` whatever the scan's end said. The
 * target itself is not widened.
 *
 * Grid: with / without a `●` boundary above the command × the capture's top
 * known (`headCut === false`) / unknown (a window the capture filled). The
 * positive control (fails before) is the no-`●` × known cell.
 */

import { describe, expect, it } from 'vitest';
import { detectPromptWithOptions } from '@/lib/polling/response-checker';
import { captureTopOf, withCaptureTopCompleteness } from '@/lib/polling/prompt-screen-reading';
import { resolveAutoAnswerWithPolicy } from '@/lib/polling/auto-yes-resolver';
import { findYesNoApprovalContextRange } from '@/lib/detection/prompt-detect-multiple-choice-approval-context';

const HEREDOC = [
  '  cat <<EOF >> ~/.ssh/authorized_keys',
  '  > key',
  '  > EOF',
  'Proceed? (y/n)',
];
const FRAMES = {
  'no boundary': HEREDOC.join('\n'),
  '`●` boundary': ['● task', ...HEREDOC].join('\n'),
} as const;

/** The capture's top: known whole (`headCut === false`), or a window it filled. */
function captureTop(frame: string, known: boolean) {
  const rows = frame.split('\n').length;
  return known ? captureTopOf(frame, 1000, 'gemini', false) : captureTopOf(frame, rows, 'gemini');
}

function resolvedUnder(frame: string, known: boolean, denyPatterns: string[]) {
  const detection = withCaptureTopCompleteness(detectPromptWithOptions(frame, 'gemini'), captureTop(frame, known));
  expect(detection.promptData?.type).toBe('yes_no');
  return {
    promptData: detection.promptData!,
    resolution: resolveAutoAnswerWithPolicy(detection.promptData!, { mode: null, allowPromptTypes: [], denyPatterns }, 'gemini'),
  };
}

describe('[#3881 review N4] a `> ` cut is truncated whatever the scan\'s end said', () => {
  it('premises: the two tops read as history-start and clipped', () => {
    expect(captureTop(FRAMES['no boundary'], true)).toBe('history-start');
    expect(captureTop(FRAMES['no boundary'], false)).toBe('clipped');
  });

  it('the scan with no boundary reaches the top, and the cut makes it truncated', () => {
    const lines = HEREDOC;
    expect(findYesNoApprovalContextRange([...lines], 3, 4)).toEqual({ start: 3, completeness: 'truncated' });
  });

  for (const [label, frame] of Object.entries(FRAMES)) {
    for (const known of [true, false]) {
      it(`${label}, capture top ${known ? 'known (headCut=false)' : 'unknown'}: truncated, deny miss withheld, target not widened`, () => {
        const { promptData, resolution } = resolvedUnder(frame, known, ['authorized_keys']);
        expect(promptData.approvalTarget).toBe('Proceed? (y/n)');
        expect(promptData.approvalTargetCompleteness).toBe('truncated');
        expect(resolution).toMatchObject({ answer: null, suppressedBy: 'deny-pattern-unusable' });
      });
    }
  }

  it('陰性対照: no deny pattern — answered', () => {
    expect(resolvedUnder(FRAMES['no boundary'], true, []).resolution.answer).toBe('y');
  });

  it('陰性対照: a command with no `> ` row reaching the top of a known history is complete and answered', () => {
    const frame = ['  ls -la', 'Proceed? (y/n)'].join('\n');
    const { promptData, resolution } = resolvedUnder(frame, true, ['authorized_keys']);
    expect(promptData.approvalTargetCompleteness).toBeUndefined();
    expect(resolution.answer).toBe('y');
  });
});
