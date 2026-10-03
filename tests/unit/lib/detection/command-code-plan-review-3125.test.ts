/**
 * Command Code 1.74.0: the plan review (REVIEW) screen, and where its focus is
 * (Issue #3125).
 *
 * `wait` already read this screen (`command_code_plan_review`, exit 10); what
 * #3125 adds is reading WHICH part of it has the keyboard, because `Enter`
 * opens a comment in the plan body and RUNS the focused action on the list.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { commandCodeStatusDetector } from '@/lib/detection/tools/command-code/detect';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { readCommandCodePlanReviewState } from '@/lib/detection/tools/command-code/plan-review-state';

const FIXTURES = path.join(process.cwd(), 'tests/fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');
const detect = (raw: string) => commandCodeStatusDetector.detect(normalizeFrame(raw));

const INITIAL = read('command-code-plan-review-3125/plan-review-1-74-0-initial.txt');
const ONE_COMMENT = read('command-code-plan-review-3125/plan-review-1-74-0-one-comment.txt');

describe('1.74.0 の REVIEW 画面 (Issue #3125)', () => {
  it.each([
    ['initial', INITIAL],
    ['one-comment', ONE_COMMENT],
  ])('%s: wait と同じ waiting / command_code_plan_review、Auto-Yes が答えられる prompt は出さない', (_name, raw) => {
    const verdict = detect(raw);
    expect(verdict.status).toBe('waiting');
    expect(verdict.reason).toBe(STATUS_REASON.COMMAND_CODE_PLAN_REVIEW);
    expect(verdict.hasActivePrompt).toBe(false);
  });

  it('コメント 0 件: 本文にフォーカス、保留 0', () => {
    expect(readCommandCodePlanReviewState(INITIAL)).toEqual({
      phase: 'body',
      pendingComments: 0,
      approveChoice: null,
    });
  });

  it('コメント 1 件: `REVIEW   1 pending comment` を読む', () => {
    expect(readCommandCodePlanReviewState(ONE_COMMENT)).toEqual({
      phase: 'body',
      pendingComments: 1,
      approveChoice: null,
    });
  });
});

describe('1.58.0 の live capture でのフォーカス (Issue #2763 の fixture)', () => {
  it.each([
    ['plan-review-initial', 'body', 0],
    ['plan-review-short', 'body', 0],
    ['plan-review-comment-pinned', 'body', 1],
    ['plan-review-quick-comments', 'body', 4],
    ['plan-review-editor-exited', 'body', 4],
    ['plan-review-comment-box-open', 'comment-box', 0],
    ['plan-review-comment-typing', 'comment-box', 0],
    ['plan-review-action-focus-approve', 'action-focus', 0],
    ['plan-review-long-scrolled-cancel-focused', 'action-focus', 1],
    ['plan-review-long-submit-review-focused', 'action-focus', 1],
    ['plan-review-approve-choice', 'approve-choice', 4],
    ['plan-review-approve-choice-discard', 'approve-choice', 4],
  ])('%s → %s (pending %i)', (name, phase, pending) => {
    const state = readCommandCodePlanReviewState(read(`command-code-plan-review-2763/${name}.txt`));
    expect(state?.phase).toBe(phase);
    expect(state?.pendingComments).toBe(pending);
  });

  it('ラジオはどちらが (•) かを読む', () => {
    expect(
      readCommandCodePlanReviewState(read('command-code-plan-review-2763/plan-review-approve-choice.txt'))
        ?.approveChoice,
    ).toBe('with-comments');
    expect(
      readCommandCodePlanReviewState(read('command-code-plan-review-2763/plan-review-approve-choice-discard.txt'))
        ?.approveChoice,
    ).toBe('discard-comments');
  });

  it.each([
    'after-approve',
    'after-approve-immediate-blank',
    'after-cancel',
    'after-cancel-idle',
    'after-enter-on-focused-approve',
  ])('%s: 抜けた後は plan review ではない', (name) => {
    expect(readCommandCodePlanReviewState(read(`command-code-plan-review-2763/${name}.txt`))).toBeNull();
  });
});

describe('他の画面を plan review と読まない (Issue #3125)', () => {
  function allFixtures(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (!/\.(md|json|ya?ml|png|gif|webm|mp4)$/i.test(name)) out.push(full);
      }
    };
    walk(FIXTURES);
    walk(path.join(process.cwd(), 'tests/unit/lib/detection/fixtures'));
    return out;
  }

  it('当たるのは command-code-plan-review-* の capture だけ（AskUserQuestion・/model・許可ダイアログは null）', () => {
    const files = allFixtures();
    expect(files.length).toBeGreaterThan(300);
    const matched = files.filter((file) => readCommandCodePlanReviewState(readFileSync(file, 'utf8')) !== null);
    expect(matched.length).toBeGreaterThan(0);
    for (const file of matched) {
      expect(path.relative(FIXTURES, file)).toMatch(/^command-code-plan-review-(2761|2763|3125)\//);
    }
    const askUserQuestion = files.filter((file) => /command-code-askuserquestion/.test(file));
    expect(askUserQuestion.length).toBeGreaterThan(0);
  });
});
