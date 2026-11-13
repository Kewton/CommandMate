/**
 * Command Code's `AskUserQuestion` Review page is answerable by a HUMAN from
 * CommandMate (Issue #4313 (b), B-1).
 *
 * In the #4228 UAT Auto-Yes answered a single-select question with its digit
 * (`answer_only`, no Enter — by design), Command Code drew the Review page
 * (`❯ 1. Submit` / `2. Cancel` over `← to go back and edit`), and that page is
 * declined by the reader (#2755 §7) so that no payload reaches Auto-Yes. But
 * `/prompt-response` read the same decline and refused with
 * `unsupported_dialog_layout`, so `respond 1|2` could not finish the question
 * either: the pane sat on the Review page for eight minutes.
 *
 * Pinned here, on the 1.54.1 live capture (1.88.2 is not captured; UAT):
 *
 *  1. `assessPromptAnswerability` reads the page as a two-option prompt
 *     (`Submit` / `Cancel`, the default where the `❯` is), with no refusal;
 *  2. 陰性対照 — the status path is unchanged: the reader still declines the
 *     page as `review-page`, the status is the manual-operation fallback with
 *     no `promptData` (which is what keeps it away from Auto-Yes), and the page
 *     reached with answers missing (`⚠ You have not answered all questions`)
 *     is still refused by `/prompt-response` too.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import {
  readCommandCodeQuestionDialog,
  readCommandCodeReviewPagePrompt,
} from '@/lib/detection/tools/command-code/dialog';
import {
  assessPromptAnswerability,
  COMMAND_CODE_REVIEW_PAGE_UNANSWERED_MESSAGE,
  UNSUPPORTED_DIALOG_LAYOUT_REASON,
} from '@/lib/polling/auto-yes-dialog-gate';

const DIR = path.resolve(__dirname, '../../../../fixtures/command-code-askuserquestion-2754');
const frame = (name: string): string => readFileSync(path.join(DIR, `${name}.txt`), 'utf8');

const REVIEW = frame('review-page-submit-cancel');
const REVIEW_UNANSWERED = frame('review-page-unanswered-warning');

/**
 * The same capture with the `❯` moved from `1. Submit` to `2. Cancel`, the way
 * a `↓` would draw it. Built in memory from the live capture; no fixture file.
 */
function withCursorOnCancel(raw: string): string {
  const rows = raw.split('\n');
  const submit = rows.findIndex((row) => /^❯ 1\. Submit\s*$/.test(stripAnsi(row)));
  const cancel = rows.findIndex((row) => /^\s*2\. Cancel\s*$/.test(stripAnsi(row)));
  expect(submit).toBeGreaterThanOrEqual(0);
  expect(cancel).toBeGreaterThan(submit);
  rows[submit] = '  1. Submit';
  rows[cancel] = '❯ 2. Cancel';
  return rows.join('\n');
}

describe('[#4313] the Review page is read as a two-option prompt for a human', () => {
  it('assessPromptAnswerability: no refusal, Submit / Cancel with the default on Submit', () => {
    const assessment = assessPromptAnswerability('command-code', REVIEW);

    expect(assessment.refusal).toBeNull();
    expect(assessment.promptCheck.isPrompt).toBe(true);
    const promptData = assessment.promptCheck.promptData;
    expect(promptData?.type).toBe('multiple_choice');
    if (promptData?.type !== 'multiple_choice') return;
    expect(promptData.options.map((o) => ({ number: o.number, label: o.label, isDefault: o.isDefault }))).toEqual([
      { number: 1, label: 'Submit', isDefault: true },
      { number: 2, label: 'Cancel', isDefault: false },
    ]);
    expect(promptData.options.every((o) => o.requiresTextInput !== true)).toBe(true);
    // What the page summarises is shown to the human answering it.
    expect(promptData.instructionText).toContain('Which files should I update?');
    expect(promptData.instructionText).toContain('calc.js');
  });

  it('follows the `❯` when it rests on Cancel', () => {
    const reading = readCommandCodeReviewPagePrompt(withCursorOnCancel(REVIEW));
    expect(reading?.promptData?.type).toBe('multiple_choice');
    if (reading?.promptData?.type !== 'multiple_choice') return;
    expect(reading.promptData.options.map((o) => o.isDefault)).toEqual([false, true]);
  });
});

describe('[#4313] 陰性対照: what is NOT changed', () => {
  it('the page reached with answers missing is still refused', () => {
    expect(readCommandCodeReviewPagePrompt(REVIEW_UNANSWERED)).toBeNull();
    const assessment = assessPromptAnswerability('command-code', REVIEW_UNANSWERED);
    expect(assessment.refusal?.reason).toBe(UNSUPPORTED_DIALOG_LAYOUT_REASON);
    // Its own sentence: "retry once the screen has settled" never helps here.
    expect(assessment.refusal?.message).toBe(COMMAND_CODE_REVIEW_PAGE_UNANSWERED_MESSAGE);
    expect(assessment.promptCheck.isPrompt).toBe(false);
  });

  it('the status path still declines the page (no payload for Auto-Yes)', () => {
    const reading = readCommandCodeQuestionDialog(REVIEW);
    expect(reading.kind).toBe('unsupported');
    if (reading.kind === 'unsupported') expect(reading.reason).toBe('review-page');

    const status = detectSessionStatus(REVIEW, 'command-code');
    expect(status.status).toBe('waiting');
    expect(status.reason).toBe(STATUS_REASON.COMMAND_CODE_SELECTION_LIST);
    expect(status.hasActivePrompt).toBe(false);
    expect(status.promptDetection?.promptData).toBeUndefined();
  });

  it('a question screen is not a Review page', () => {
    expect(readCommandCodeReviewPagePrompt(frame('singleselect-initial-unanswered-tabs'))).toBeNull();
    expect(readCommandCodeReviewPagePrompt(frame('multiselect-cursor-on-submit'))).toBeNull();
    expect(readCommandCodeReviewPagePrompt(null)).toBeNull();
  });
});
