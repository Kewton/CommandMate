/**
 * Command Code 1.58.0: Plan review 画面（Issue #2761）
 *
 * フッタが `Approve ctrl+a` / `Cancel esc` の全画面オーバーレイ。検出できないと
 * `running` / `default`（unclassified）になり、しかも plan 本文の末尾が `(y/n)` で
 * 終わっていると汎用パーサが yes/no プロンプトとして読む。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { commandCodeStatusDetector } from '@/lib/detection/tools/command-code/detect';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { SELECTION_LIST_REASONS } from '@/lib/detection/status-detector';
import {
  COMMAND_CODE_PLAN_REVIEW_FOOTER,
  hasDismissablePanelFooter,
  readCommandCodeQuestionRegion,
  readSelectionListShape,
  shouldOfferOptionNumbers,
} from '@/lib/detection/selection-shape';

const FIXTURES = path.join(process.cwd(), 'tests/fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');
const PLAN_REVIEW = read('command-code-plan-review-2761/plan-review-1-58-0.txt');
const detect = (raw: string) => commandCodeStatusDetector.detect(normalizeFrame(raw));

describe('Plan review 画面の検出 (Issue #2761)', () => {
  it('waiting / command_code_plan_review と答え、回答可能な prompt は publish しない', () => {
    const verdict = detect(PLAN_REVIEW);
    expect(verdict.status).toBe('waiting');
    expect(verdict.reason).toBe(STATUS_REASON.COMMAND_CODE_PLAN_REVIEW);
    expect(verdict.hasActivePrompt).toBe(false);
    expect(verdict.evidence).toBe('positive');
    expect(verdict.promptDetection).toBeUndefined();
  });

  it('selection list の一員である（矢印カード・wait の exit 10 に乗る）', () => {
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.COMMAND_CODE_PLAN_REVIEW)).toBe(true);
  });

  it('本番ジオメトリ（200x1000・上端寄せ・末尾 900 行超が空行）でも同じ判定', () => {
    const padded = PLAN_REVIEW + '\n'.repeat(953);
    expect(padded.split('\n').length).toBe(1000);
    expect(detect(padded).reason).toBe(STATUS_REASON.COMMAND_CODE_PLAN_REVIEW);
  });

  it.each([
    ['(y/n) で終わる plan', '  23   Do you want to proceed? (y/n)'],
    ['Approve? で終わる plan', '  23   Approve?'],
  ])('%s を yes/no プロンプトとして読まない（beforePrompt に置いた理由）', (_name, row) => {
    const frame = PLAN_REVIEW.replace('  23    ', row);
    expect(frame).not.toBe(PLAN_REVIEW);
    const verdict = detect(frame);
    expect(verdict.reason).toBe(STATUS_REASON.COMMAND_CODE_PLAN_REVIEW);
    expect(verdict.hasActivePrompt).toBe(false);
  });

  it('Approve 行が無ければ Plan review ではない（Cancel esc だけでは発火しない）', () => {
    const frame = PLAN_REVIEW.replace('Approve ctrl+a   executes the plan\n', '');
    expect(COMMAND_CODE_PLAN_REVIEW_FOOTER.test(frame)).toBe(false);
    expect(detect(frame).reason).not.toBe(STATUS_REASON.COMMAND_CODE_PLAN_REVIEW);
  });

  it('他の Command Code 専用リーダは、この画面を自分のものとして読まない', () => {
    expect(hasDismissablePanelFooter(PLAN_REVIEW)).toBe(false);
    expect(readCommandCodeQuestionRegion(PLAN_REVIEW)).toBeNull();
  });
});

describe('Plan review 画面の shape (Issue #2761)', () => {
  it('offersPlanApprove を立てる', () => {
    expect(readSelectionListShape(PLAN_REVIEW).offersPlanApprove).toBe(true);
  });

  it('plan 本文に番号付きの行があっても、番号ボタンは出さない', () => {
    const frame = PLAN_REVIEW.replace('       12,11.', '       1. then merge');
    const shape = readSelectionListShape(frame);
    expect(shape.optionCount).toBeGreaterThan(0);
    expect(shape.offersPlanApprove).toBe(true);
    expect(shouldOfferOptionNumbers(shape)).toBe(false);
  });

  it.each([
    'chat-dialog-card-2254/command-code-model-1-40-1.txt',
    'chat-dialog-card-2254/claude-model-2-1-259.txt',
    'chat-dialog-card-2254/codex-model-0-151-0.txt',
    'command-code-askuserquestion-2753/multiselect-answered-tabs.txt',
  ])('%s では offersPlanApprove は false', (rel) => {
    expect(readSelectionListShape(read(rel)).offersPlanApprove).toBe(false);
  });

  it('空フレームでは false', () => {
    expect(readSelectionListShape('').offersPlanApprove).toBe(false);
    expect(readSelectionListShape(null).offersPlanApprove).toBe(false);
  });
});
