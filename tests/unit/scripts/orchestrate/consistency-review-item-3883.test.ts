/**
 * scripts/orchestrate/consistency-review.mjs — the work item of a review (Issue #3883).
 * Everything is under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendReviewRow, claimReviewLabel, nextReviewLabel, parseArgs } from '../../../../scripts/orchestrate/consistency-review.mjs';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-consistency-item-'));
  fs.writeFileSync(path.join(tmp, 'brief.txt'), 'brief\n');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('one review label per review, per work item (#3883)', () => {
  it('two PRs of one Issue get labels of their own', () => {
    expect(claimReviewLabel(tmp, 3883, 'd1', 'p1')).toBe('review-3883-d1');
    expect(claimReviewLabel(tmp, 3883, 'd2', 'p2')).toBe('review-3883-d2');
    expect(fs.readFileSync(path.join(tmp, 'review-3883-d1.prompt.txt'), 'utf8')).toBe('p1');
  });

  it('two reviews that looked at the same moment: the second takes the next name, the first keeps its prompt', () => {
    // Both saw review-3883 free (nextReviewLabel), the first wrote it first.
    expect(nextReviewLabel(tmp, 3883)).toBe('review-3883');
    expect(claimReviewLabel(tmp, 3883, undefined, 'first')).toBe('review-3883');
    expect(claimReviewLabel(tmp, 3883, undefined, 'second')).toBe('review-3883b');
    expect(fs.readFileSync(path.join(tmp, 'review-3883.prompt.txt'), 'utf8')).toBe('first');
  });

  it('without --item the labels are the Issue’s, as before (negative control)', () => {
    expect(nextReviewLabel(tmp, 3883)).toBe('review-3883');
    expect(nextReviewLabel(tmp, 3883, 'd1')).toBe('review-3883-d1');
  });

  it('the table row names the work item', () => {
    const file = path.join(tmp, 'consistency-review.md');
    expect(appendReviewRow(file, { issue: 3883, item: 'd1', rereview: false, head: 'a'.repeat(40), durationSec: 1, doneLine: 'DONE: 指摘なし' })).toContain('| #3883/d1 |');
  });

  it('--item must be able to name a file', () => {
    const base = ['--run-dir', tmp, '--issues', '3883', '--issue', '3883', '--head', 'a'.repeat(40), '--brief', path.join(tmp, 'brief.txt')];
    expect(parseArgs([...base, '--item', '../x']).error).toMatch(/--item/);
    expect((parseArgs([...base, '--item', 'd1']).options as { item?: string } | undefined)?.item).toBe('d1');
  });
});
