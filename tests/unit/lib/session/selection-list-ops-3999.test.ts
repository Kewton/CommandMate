/**
 * Issue #3999: Command Code の Plan review の操作は両方の面に出し、入力欄のガードと
 * 同じ判定を使う。
 *
 * 2026-10-30、Command Code が REVIEW で約 5 時間止まった。ターミナル表示には
 * ◀▲▼▶ と Esc しか無く（`surface === 'chat'` の条件）、承認できなかった。
 *
 *  - 陽性: REVIEW の実機 capture では、チャット面・ターミナル面のどちらでも
 *    `planReview: true`、どちらでも Enter は出さない（#2793 / #2809 のまま）。
 *  - 陰性: 承認時のラジオ（approve-choice）は Plan review ではなく、Enter が残る。
 *    `/model` も今までどおり。ページャには何も足さない。
 *  - 入力欄のガード（`isPlanReviewUp`）は操作と同じ規則で、selection list が
 *    出ていない・ページャ・承認キーを宣言していないツールでは偽。
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  NO_SELECTION_LIST_READING,
  isPlanReviewUp,
  offersPlanReviewControls,
  readSelectionListFrame,
  resolveSelectionListOps,
  type SelectionListSurface,
} from '@/lib/session/selection-list-ops';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const capture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');

/** REVIEW 画面（本文が長い。#3999 で観測した形）。 */
const PLAN_REVIEW_LONG = capture('command-code-plan-review-2763/plan-review-long-top.txt');
/** REVIEW 画面（1.74.0 の文言）。 */
const PLAN_REVIEW_174 = capture('command-code-plan-review-3125/plan-review-1-74-0-initial.txt');
/** 承認時のラジオ（コメントがあるときの ctrl+a）。Enter が確定。 */
const APPROVE_CHOICE = capture('command-code-plan-review-2763/plan-review-approve-choice.txt');
/** Command Code の `/model`。 */
const COMMAND_CODE_MODEL = capture('chat-dialog-card-2254/command-code-model-1-40-1.txt');

const SURFACES: readonly SelectionListSurface[] = ['chat', 'terminal'];

function ops(frame: string, cliToolId: string, surface: SelectionListSurface, pager = false) {
  return resolveSelectionListOps({ reading: readSelectionListFrame(frame), cliToolId, surface, pager });
}

describe('[#3999] resolveSelectionListOps: Plan review の操作は両面', () => {
  it.each(SURFACES)('%s: REVIEW では planReview: true、Enter は出さない', (surface) => {
    for (const frame of [PLAN_REVIEW_LONG, PLAN_REVIEW_174]) {
      const result = ops(frame, 'command-code', surface);
      expect(result.planReview).toBe(true);
      expect(result.padEnter).toBe(false);
    }
  });

  it.each(SURFACES)('%s: 承認キーを宣言していないツールには出さない', (surface) => {
    expect(ops(PLAN_REVIEW_LONG, 'claude', surface).planReview).toBe(false);
  });

  it.each(SURFACES)('%s 陰性: 承認時のラジオは Plan review ではなく、Enter が残る', (surface) => {
    const result = ops(APPROVE_CHOICE, 'command-code', surface);
    expect(result.planReview).toBe(false);
    expect(result.padEnter).toBe(true);
  });

  it.each(SURFACES)('%s 陰性: /model は今までどおり', (surface) => {
    const result = ops(COMMAND_CODE_MODEL, 'command-code', surface);
    expect(result.planReview).toBe(false);
    expect(result.padEnter).toBe(true);
  });

  it('陰性: ページャには操作を足さない', () => {
    expect(ops(PLAN_REVIEW_LONG, 'command-code', 'terminal', true).planReview).toBe(false);
  });
});

describe('[#3999] 入力欄のガードは操作と同じ判定', () => {
  const reading = readSelectionListFrame(PLAN_REVIEW_LONG);

  it('offersPlanReviewControls は resolveSelectionListOps の planReview と一致する', () => {
    for (const [frame, tool] of [
      [PLAN_REVIEW_LONG, 'command-code'],
      [PLAN_REVIEW_LONG, 'claude'],
      [APPROVE_CHOICE, 'command-code'],
      [COMMAND_CODE_MODEL, 'command-code'],
    ] as const) {
      for (const surface of SURFACES) {
        expect(offersPlanReviewControls(readSelectionListFrame(frame), tool)).toBe(
          ops(frame, tool, surface).planReview,
        );
      }
    }
  });

  it('selection list が出ていて REVIEW なら真', () => {
    expect(isPlanReviewUp({ isSelectionListActive: true, reading, cliToolId: 'command-code' })).toBe(true);
  });

  it('陰性: selection list が出ていない・ページャ・ほかのツール・読みが無いときは偽', () => {
    expect(isPlanReviewUp({ isSelectionListActive: false, reading, cliToolId: 'command-code' })).toBe(false);
    expect(
      isPlanReviewUp({ isSelectionListActive: true, isPagerActive: true, reading, cliToolId: 'command-code' }),
    ).toBe(false);
    expect(isPlanReviewUp({ isSelectionListActive: true, reading, cliToolId: 'claude' })).toBe(false);
    expect(isPlanReviewUp({ isSelectionListActive: true, reading, cliToolId: undefined })).toBe(false);
    expect(
      isPlanReviewUp({ isSelectionListActive: true, reading: NO_SELECTION_LIST_READING, cliToolId: 'command-code' }),
    ).toBe(false);
  });
});
