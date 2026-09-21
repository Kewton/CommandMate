/**
 * Command Code 1.58.0: Plan review の 24 枚を全件判定する（Issue #2793）
 *
 * `tests/fixtures/command-code-plan-review-2763/` は #2763 が隔離環境で 1 キーずつ
 * 採った live capture で、#2761（検出）より後に入ったため、どのスイートも開いて
 * いなかった。ここで 1 枚ずつ verdict を pin する。
 *
 * #2793 が動かしたのは 4 枚（`changedIn2793`）だけで、残り 20 枚は #2793 の前と
 * 同じ verdict のまま:
 *
 *  - **偽完了の 2 枚**: `↓` で本文の最終行より先へ進むとフォーカスがアクション一覧に
 *    移り、`❯ Approve  ctrl+a` / `❯ Cancel  esc` と描かれる。行頭の `❯` のせいで
 *    `COMMAND_CODE_PLAN_REVIEW_FOOTER` に当たらず、composer 判定
 *    （`COMMAND_CODE_PROMPT_PATTERN`）がその行を composer と読んで `ready` を返していた。
 *  - **ラジオ確認の 2 枚**: コメントが残った状態の `ctrl+a` で挟まる
 *    `Approve (•) with N comments as notes ( ) original plan` /
 *    `←/→ choose · enter confirm · esc back`。どのルールにも当たらず `running` /
 *    `default` だった。
 *
 * どちらも「人間が plan の扱いを決めるまで何も動かない」画面なので、
 * `waiting` / `command_code_plan_review` に揃えた。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { commandCodeStatusDetector } from '@/lib/detection/tools/command-code/detect';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { stripAnsi } from '@/lib/detection/ansi';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import {
  COMMAND_CODE_PLAN_APPROVE_CHOICE_FOOTER,
  COMMAND_CODE_PLAN_APPROVE_CHOICE_ROW,
  COMMAND_CODE_PLAN_REVIEW_FOOTER,
  isCommandCodePlanApproveChoice,
  readSelectionListShape,
} from '@/lib/detection/selection-shape';

const FIXTURES = path.join(process.cwd(), 'tests/fixtures');
const DIR = path.join(FIXTURES, 'command-code-plan-review-2763');
const frame = (name: string): string => readFileSync(path.join(DIR, `${name}.txt`), 'utf8');
const detect = (raw: string) => commandCodeStatusDetector.detect(normalizeFrame(raw));

/** `from` がちょうど 1 回だけ現れることを確かめてから置き換える（空振りの変異を許さない）。 */
function mutate(raw: string, from: string, to: string): string {
  expect(raw.split(from).length - 1).toBe(1);
  return raw.replace(from, to);
}

interface Expectation {
  /** fixture のファイル名（`.txt` 抜き）。 */
  frame: string;
  status: 'ready' | 'running' | 'waiting';
  reason: string;
  hasActivePrompt: boolean;
  /** チャット面が矢印パッドから `Enter` を外し、承認ボタンを出すか。 */
  offersPlanApprove: boolean;
  /** #2793 がこの verdict を動かしたか。 */
  changedIn2793: boolean;
}

const PLAN_REVIEW = STATUS_REASON.COMMAND_CODE_PLAN_REVIEW;

/** ディレクトリの 24 枚すべてと、今日の verdict。 */
const EXPECTATIONS: readonly Expectation[] = [
  // ---- #2793 が直した 4 枚 ------------------------------------------------
  // 偽完了: `❯ Approve  ctrl+a`。ここで Enter を押すと plan が実行される画面。
  { frame: 'plan-review-action-focus-approve', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: true, changedIn2793: true },
  // 偽完了: `❯ Cancel  esc`（886 行の plan を末尾までスクロール）。
  { frame: 'plan-review-long-scrolled-cancel-focused', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: true, changedIn2793: true },
  // 未分類: コメント 4 件で ctrl+a。ラジオは `enter` が確定なので offersPlanApprove は立てない。
  { frame: 'plan-review-approve-choice', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: false, changedIn2793: true },
  { frame: 'plan-review-approve-choice-discard', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: false, changedIn2793: true },

  // ---- Plan review そのもの（#2761 のまま） -------------------------------
  { frame: 'plan-review-initial', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: true, changedIn2793: false },
  { frame: 'plan-review-cursor-moved', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: true, changedIn2793: false },
  { frame: 'plan-review-short', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: true, changedIn2793: false },
  { frame: 'plan-review-second-plan', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: true, changedIn2793: false },
  { frame: 'plan-review-comment-box-open', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: true, changedIn2793: false },
  { frame: 'plan-review-comment-typing', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: true, changedIn2793: false },
  { frame: 'plan-review-comment-pinned', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: true, changedIn2793: false },
  { frame: 'plan-review-quick-comments', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: true, changedIn2793: false },
  { frame: 'plan-review-editor-exited', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: true, changedIn2793: false },
  { frame: 'plan-review-long-top', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: true, changedIn2793: false },
  // `❯ Submit review (1)  ctrl+r` にフォーカス。`Approve` / `Cancel` の 2 行に `❯` が無いので #2761 の時点で読めていた。
  { frame: 'plan-review-long-submit-review-focused', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: true, changedIn2793: false },
  // Esc 直後の再描画途中。フッタがまだ残っている。
  { frame: 'after-cancel-partial-redraw', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: true, changedIn2793: false },
  // vi を kill した後の階段状フレーム。フッタの 2 行はそれぞれ 1 行に収まっている。
  { frame: 'editor-killed-staircase', status: 'waiting', reason: PLAN_REVIEW, hasActivePrompt: false, offersPlanApprove: true, changedIn2793: false },

  // ---- Plan review を抜けた後（#2761 のまま） -----------------------------
  { frame: 'after-approve-immediate-blank', status: 'running', reason: STATUS_REASON.DEFAULT, hasActivePrompt: false, offersPlanApprove: false, changedIn2793: false },
  { frame: 'after-approve', status: 'waiting', reason: STATUS_REASON.PROMPT_DETECTED, hasActivePrompt: true, offersPlanApprove: false, changedIn2793: false },
  { frame: 'after-approve-with-comments', status: 'running', reason: STATUS_REASON.THINKING_INDICATOR, hasActivePrompt: false, offersPlanApprove: false, changedIn2793: false },
  { frame: 'after-cancel', status: 'running', reason: STATUS_REASON.THINKING_INDICATOR, hasActivePrompt: false, offersPlanApprove: false, changedIn2793: false },
  { frame: 'after-cancel-idle', status: 'ready', reason: STATUS_REASON.INPUT_PROMPT, hasActivePrompt: false, offersPlanApprove: false, changedIn2793: false },
  { frame: 'after-enter-on-focused-approve', status: 'waiting', reason: STATUS_REASON.PROMPT_DETECTED, hasActivePrompt: true, offersPlanApprove: false, changedIn2793: false },
  { frame: 'editor-took-the-pane', status: 'running', reason: STATUS_REASON.DEFAULT, hasActivePrompt: false, offersPlanApprove: false, changedIn2793: false },
];

describe('Plan review の 24 枚 (Issue #2763 の実測 / Issue #2793)', () => {
  it('表はディレクトリの fixture をちょうど網羅する（足した fixture は表に載るまで赤）', () => {
    const onDisk = readdirSync(DIR)
      .filter((name) => name.endsWith('.txt'))
      .map((name) => name.replace(/\.txt$/, ''))
      .sort();
    expect(EXPECTATIONS.map((e) => e.frame).sort()).toEqual(onDisk);
    expect(onDisk).toHaveLength(24);
  });

  it('#2793 が動かしたのは Issue の表の 4 枚だけ', () => {
    expect(EXPECTATIONS.filter((e) => e.changedIn2793).map((e) => e.frame).sort()).toEqual([
      'plan-review-action-focus-approve',
      'plan-review-approve-choice',
      'plan-review-approve-choice-discard',
      'plan-review-long-scrolled-cancel-focused',
    ]);
  });

  it.each(EXPECTATIONS)('$frame → $status / $reason', (e) => {
    const verdict = detect(frame(e.frame));
    expect({
      status: verdict.status,
      reason: verdict.reason,
      hasActivePrompt: verdict.hasActivePrompt,
    }).toEqual({ status: e.status, reason: e.reason, hasActivePrompt: e.hasActivePrompt });
  });

  it.each(EXPECTATIONS)('$frame の offersPlanApprove は $offersPlanApprove', (e) => {
    expect(readSelectionListShape(frame(e.frame)).offersPlanApprove).toBe(e.offersPlanApprove);
  });

  it('Plan review と読んだ画面は、どれも `ready` にならず回答用 payload も出さない', () => {
    for (const e of EXPECTATIONS.filter((x) => x.reason === PLAN_REVIEW)) {
      const verdict = detect(frame(e.frame));
      expect(verdict.status, e.frame).toBe('waiting');
      expect(verdict.evidence, e.frame).toBe('positive');
      expect(verdict.promptDetection?.isPrompt ?? false, e.frame).toBe(false);
    }
  });
});

describe('変異注入: アクション一覧フォーカスの `❯` (Issue #2793)', () => {
  const FOCUS_APPROVE = frame('plan-review-action-focus-approve');
  const FOCUS_CANCEL = frame('plan-review-long-scrolled-cancel-focused');

  it('#2763 の変異（行頭 `❯ ` → 空白 2 つ）をかけても同じ verdict — ルールは `❯` を許すだけで要求しない', () => {
    const approve = mutate(FOCUS_APPROVE, '❯ Approve', '  Approve');
    const cancel = mutate(FOCUS_CANCEL, '❯ Cancel', '  Cancel');
    expect(detect(approve).reason).toBe(PLAN_REVIEW);
    expect(detect(cancel).reason).toBe(PLAN_REVIEW);
  });

  // フッタの認識を外すと、同じフレームが `ready` に落ちる。つまり 2 枚の fixture は
  // 本当に `❯` の偽完了を抱えていて、それを止めているのがこのフッタの認識である。
  it('`Cancel esc` 行を消すと Plan review ではなくなり、`❯ Approve` 行が composer と読まれて ready に落ちる', () => {
    const verdict = detect(mutate(FOCUS_APPROVE, '\nCancel esc\n', '\n'));
    expect(verdict.reason).not.toBe(PLAN_REVIEW);
    expect(verdict.status).toBe('ready');
  });

  it('`Approve ctrl+a` 行を消すと Plan review ではなくなり、`❯ Cancel` 行が composer と読まれて ready に落ちる', () => {
    const verdict = detect(
      mutate(FOCUS_CANCEL, '\nApprove ctrl+a   executes the plan · comments go along as notes\n', '\n'),
    );
    expect(verdict.reason).not.toBe(PLAN_REVIEW);
    expect(verdict.status).toBe('ready');
  });

  it.each([
    ['`›`（codex のカーソル）', '› Approve'],
    ['`>`（ASCII）', '> Approve'],
  ])('許すのは実測した `❯` だけ: %s は Plan review にならない', (_name, row) => {
    const mutated = mutate(FOCUS_APPROVE, '❯ Approve', row);
    expect(COMMAND_CODE_PLAN_REVIEW_FOOTER.test(stripAnsi(mutated))).toBe(false);
    expect(detect(mutated).reason).not.toBe(PLAN_REVIEW);
  });
});

describe('変異注入: 承認時のラジオ確認 (Issue #2793)', () => {
  const CHOICE = frame('plan-review-approve-choice');
  const RADIO_ROW = 'Approve (•) with 4 comments as notes ( ) original plan · discard comments';
  const HINT_BAR = '←/→ choose · enter confirm · esc back';

  it('ラジオ行とヒントバーの両方で読む', () => {
    const tail = normalizeFrame(CHOICE).lastLines;
    expect(COMMAND_CODE_PLAN_APPROVE_CHOICE_ROW.test(tail)).toBe(true);
    expect(COMMAND_CODE_PLAN_APPROVE_CHOICE_FOOTER.test(tail)).toBe(true);
    expect(isCommandCodePlanApproveChoice(tail)).toBe(true);
  });

  it('ラジオ行を消すと Plan review ではない（ヒントバーだけでは発火しない）', () => {
    expect(detect(mutate(CHOICE, `${RADIO_ROW}\n`, '')).reason).not.toBe(PLAN_REVIEW);
  });

  it('ヒントバーを消すと Plan review ではない（ラジオ行だけでは発火しない）', () => {
    expect(detect(mutate(CHOICE, HINT_BAR, '')).reason).not.toBe(PLAN_REVIEW);
  });

  it('ヒントバーの下に行がある（transcript がこの画面を引用している）ときは発火しない', () => {
    const quoted = mutate(CHOICE, HINT_BAR, `${HINT_BAR}\n\nAnything drawn below it`);
    expect(detect(quoted).reason).not.toBe(PLAN_REVIEW);
  });

  it('コメント 1 件の単数形（`with 1 comment as notes`）でも読む', () => {
    const single = mutate(CHOICE, 'with 4 comments as notes', 'with 1 comment as notes');
    expect(detect(single).reason).toBe(PLAN_REVIEW);
  });

  it('ラジオは offersPlanApprove を立てない（`enter` がこの画面の確定キー）', () => {
    expect(readSelectionListShape(CHOICE).offersPlanApprove).toBe(false);
    expect(COMMAND_CODE_PLAN_REVIEW_FOOTER.test(stripAnsi(CHOICE))).toBe(false);
  });
});

describe('新しいパターンは Plan review の capture にしか当たらない (Issue #2793)', () => {
  /** `tests/fixtures` と `tests/unit/lib/detection/fixtures` の全ファイル。 */
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

  it('フッタ（`❯` 込み）とラジオに当たるのは command-code-plan-review-* の capture だけ', () => {
    const files = allFixtures();
    expect(files.length).toBeGreaterThan(300);
    const matched = files.filter((file) => {
      const tail = normalizeFrame(readFileSync(file, 'utf8')).lastLines;
      return COMMAND_CODE_PLAN_REVIEW_FOOTER.test(tail) || isCommandCodePlanApproveChoice(tail);
    });
    expect(matched.length).toBe(18);
    for (const file of matched) {
      expect(path.relative(FIXTURES, file)).toMatch(/^command-code-plan-review-27(61|63)\//);
    }
  });
});
