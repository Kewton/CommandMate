/**
 * 選択リストに出す操作の判断は 1 つ（Issue #3305）
 *
 * `resolveSelectionListOps` は、#2297 が `ChatSurface` の `case 'selectionList'` の中に
 * 書いた出し分け（番号キー、「このセッションのみ」／「既定に設定」、Plan review の Enter）を
 * そのまま外へ出したもの。チャット面のカードも、ターミナル面の pad も、これを読む。
 *
 * ここで固定するのは 2 つ:
 *
 *  1. 表のとおりに決まること（規則そのもの。実機の capture で確かめる）
 *  2. **面で変わるのは、ここに名前を書いた欄だけ**であること。番号キーと 2 つの確定ボタンは
 *     面で変わらない。この Issue の不具合は、その 2 つがチャット面にしか無かったこと。
 *
 * 3 つの面に実際に同じボタンが出るかは
 * `tests/unit/components/worktree/selection-list-surfaces-3305.test.tsx` が見る。
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  resolveSelectionListOps,
  type SelectionListOps,
  type SelectionListSurface,
} from '@/lib/session/selection-list-ops';
import { PLAN_APPROVE_KEY_TOOL_IDS, SESSION_SCOPE_KEY_TOOL_IDS } from '@/types/terminal-keys';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const capture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');

/** claude 2.1.259 の `/model`: `Enter to set as default · s to use this session only · Esc to cancel`。 */
const CLAUDE_MODEL = capture('chat-dialog-card-2254/claude-model-2-1-259.txt');
/** claude 2.1.259 のフォルダの信頼: `Enter to confirm · Esc to cancel`。番号なし。 */
const CLAUDE_TRUST = capture('chat-dialog-card-2254/claude-trust-2-1-259.txt');
/** codex 0.151.0 の `/model`: 番号つきの 7 件。 */
const CODEX_MODEL = capture('chat-dialog-card-2254/codex-model-0-151-0.txt');
/** Command Code 1.40.1 の `/model`: 検索ボックスつきの名前の一覧。 */
const COMMAND_CODE_MODEL = capture('chat-dialog-card-2254/command-code-model-1-40-1.txt');
/** Command Code の Plan review。`❯ Approve` にフォーカス。この画面の Enter は plan を実行する。 */
const PLAN_REVIEW = capture('command-code-plan-review-2763/plan-review-action-focus-approve.txt');
/** Command Code の AskUserQuestion（フッタなし）。番号は、答えられるキーと測れていない（#2521）。 */
const ASK_USER_QUESTION = capture(
  'command-code-askuserquestion-2521/askuserquestion-wrapped-1530-200x1000.txt',
);

const SURFACES: readonly SelectionListSurface[] = ['chat', 'terminal'];

function ops(
  frame: string | null | undefined,
  cliToolId: string,
  surface: SelectionListSurface,
  pager = false,
): SelectionListOps {
  return resolveSelectionListOps({ frame, cliToolId, surface, pager });
}

describe('[#3305] 前提: この suite が頼っているツールの宣言', () => {
  it('`s` を宣言しているのは claude と command-code、codex はしていない', () => {
    expect([...SESSION_SCOPE_KEY_TOOL_IDS].sort()).toEqual(['claude', 'command-code']);
  });

  it('Plan review の承認キーを宣言しているのは command-code だけ', () => {
    expect([...PLAN_APPROVE_KEY_TOOL_IDS]).toEqual(['command-code']);
  });
});

// ===========================================================================
// 面で変わらないもの: 番号キーと、2 つの確定ボタン
// ===========================================================================

describe('[#3305] 番号キーと確定ボタンは、どちらの面でも同じ', () => {
  const FRAMES: ReadonlyArray<[string, string | null | undefined]> = [
    ['claude の /model', CLAUDE_MODEL],
    ['claude のフォルダの信頼', CLAUDE_TRUST],
    ['codex の /model', CODEX_MODEL],
    ['Command Code の /model', COMMAND_CODE_MODEL],
    ['Command Code の Plan review', PLAN_REVIEW],
    ['Command Code の AskUserQuestion', ASK_USER_QUESTION],
    ['空のフレーム', ''],
    ['フレームなし', undefined],
  ];
  const TOOLS = ['claude', 'command-code', 'codex', 'copilot', 'opencode', 'antigravity'];

  it.each(FRAMES)('%s: すべてのツールで、2 つの面の番号キーと確定ボタンが一致する', (_name, frame) => {
    for (const cliToolId of TOOLS) {
      const chat = ops(frame, cliToolId, 'chat');
      const terminal = ops(frame, cliToolId, 'terminal');

      expect(terminal.numberKeyCount, `${cliToolId}: numberKeyCount`).toBe(chat.numberKeyCount);
      expect(terminal.commitKeys, `${cliToolId}: commitKeys`).toEqual(chat.commitKeys);
    }
  });
});

// ===========================================================================
// 規則（#2297 / #2521 / #2793 が測ったもの。場所が移っただけ）
// ===========================================================================

describe('[#3305] 「このセッションのみ」／「既定に設定」', () => {
  it.each(SURFACES)('%s: claude の /model には出る。Enter は既定を書き換える、と分かっている', (surface) => {
    expect(ops(CLAUDE_MODEL, 'claude', surface).commitKeys).toEqual({ commitsDefaultOnEnter: true });
  });

  it.each(SURFACES)('%s: `s` を宣言している command-code にも、同じフッタなら出る', (surface) => {
    expect(ops(CLAUDE_MODEL, 'command-code', surface).commitKeys).toEqual({
      commitsDefaultOnEnter: true,
    });
  });

  // 陰性対照: ツールが宣言していないキーのボタンは、route が 400 を返すだけのボタンになる。
  it.each(SURFACES)('%s: `s` を宣言していない codex には、同じフッタでも出ない', (surface) => {
    expect(ops(CLAUDE_MODEL, 'codex', surface).commitKeys).toBeNull();
  });

  // 陰性対照: 決めているのはフレームで、ツールではない。
  it.each(SURFACES)('%s: claude でも、フッタが言っていない画面（フォルダの信頼）には出ない', (surface) => {
    expect(ops(CLAUDE_TRUST, 'claude', surface).commitKeys).toBeNull();
  });

  // 変異注入: フッタの 1 文を消すと、同じ capture から確定ボタンが消える。
  it.each(SURFACES)('%s: /model のフッタから `s to use this session only` を消すと出なくなる', (surface) => {
    const mutated = CLAUDE_MODEL.replace('s to use this session only', 'x');
    expect(mutated).not.toBe(CLAUDE_MODEL);

    expect(ops(mutated, 'claude', surface).commitKeys).toBeNull();
  });
});

describe('[#3305] 番号キー', () => {
  it.each(SURFACES)('%s: codex の /model は 7 件', (surface) => {
    expect(ops(CODEX_MODEL, 'codex', surface).numberKeyCount).toBe(7);
  });

  it.each(SURFACES)('%s: claude の /model には出さない（番号キーが既定を書き換える）', (surface) => {
    expect(ops(CLAUDE_MODEL, 'claude', surface).numberKeyCount).toBe(0);
    // `s` を宣言していないツールでも同じ。出さない理由はフッタにあり、ツールには無い。
    expect(ops(CLAUDE_MODEL, 'codex', surface).numberKeyCount).toBe(0);
  });

  it.each(SURFACES)('%s: 検索ボックスのある一覧（Command Code の /model）には出さない', (surface) => {
    expect(ops(COMMAND_CODE_MODEL, 'command-code', surface).numberKeyCount).toBe(0);
  });

  it.each(SURFACES)('%s: Command Code の AskUserQuestion には出さない（#2521）', (surface) => {
    expect(ops(ASK_USER_QUESTION, 'command-code', surface).numberKeyCount).toBe(0);
  });

  it.each(SURFACES)('%s: Plan review には出さない（打った文字は plan へのコメントになる）', (surface) => {
    expect(ops(PLAN_REVIEW, 'command-code', surface).numberKeyCount).toBe(0);
  });

  it.each(SURFACES)('%s: フレームが無ければ出さない', (surface) => {
    expect(ops(undefined, 'codex', surface).numberKeyCount).toBe(0);
    expect(ops(null, 'codex', surface).numberKeyCount).toBe(0);
    expect(ops('', 'codex', surface).numberKeyCount).toBe(0);
  });
});

// ===========================================================================
// 面で変わるもの。ここに書いた 3 つだけ
// ===========================================================================

describe('[#3305] 違い 1: ターミナル面は、「既定に設定」が出るときラベルの無い Enter を出さない', () => {
  it('ターミナル面: claude の /model では pad から Enter を外す', () => {
    expect(ops(CLAUDE_MODEL, 'claude', 'terminal').padEnter).toBe(false);
  });

  it('チャット面: 両方を出したまま（#2297 の suite が固定。この Issue では変えない）', () => {
    expect(ops(CLAUDE_MODEL, 'claude', 'chat').padEnter).toBe(true);
  });

  // 陰性対照: Enter を外す条件は「既定に設定」が出ていること。出ていなければ Enter は残る。
  it.each<[string, string, string]>([
    ['`s` を宣言していない codex、同じフッタ', CLAUDE_MODEL, 'codex'],
    ['claude のフォルダの信頼', CLAUDE_TRUST, 'claude'],
    ['codex の /model', CODEX_MODEL, 'codex'],
    ['Command Code の /model', COMMAND_CODE_MODEL, 'command-code'],
  ])('ターミナル面: %s では Enter が残る', (_name, frame, cliToolId) => {
    expect(ops(frame, cliToolId, 'terminal').padEnter).toBe(true);
  });

  it.each(SURFACES)('%s: Plan review では、どのツールでも Enter を出さない（#2793 / #2809）', (surface) => {
    expect(ops(PLAN_REVIEW, 'command-code', surface).padEnter).toBe(false);
    expect(ops(PLAN_REVIEW, 'claude', surface).padEnter).toBe(false);
  });

  it.each(SURFACES)('%s: フレームが無ければ、今までどおりの pad（Enter あり、ほかは何も無い）', (surface) => {
    const none = ops(undefined, 'claude', surface);

    expect(none.padEnter).toBe(true);
    expect(none.numberKeyCount).toBe(0);
    expect(none.commitKeys).toBeNull();
    expect(none.planReview).toBe(false);
  });
});

describe('[#3305] 違い 2・3: Plan review の操作と opencode のモデルのキーは、チャット面だけ', () => {
  it('チャット面: command-code の Plan review には操作を出す', () => {
    expect(ops(PLAN_REVIEW, 'command-code', 'chat').planReview).toBe(true);
  });

  it('チャット面: 承認キーを宣言していないツールには出さない', () => {
    expect(ops(PLAN_REVIEW, 'claude', 'chat').planReview).toBe(false);
  });

  it('ターミナル面: Plan review の操作は出さない（Enter を外すだけ。#2809 のまま）', () => {
    expect(ops(PLAN_REVIEW, 'command-code', 'terminal').planReview).toBe(false);
  });

  it('opencode のモデルのキーを載せるのはチャット面だけ（ターミナル面には OpencodeQuickKeys がある）', () => {
    expect(ops(CODEX_MODEL, 'opencode', 'chat').opencodeModelKeys).toBe(true);
    expect(ops(CODEX_MODEL, 'opencode', 'terminal').opencodeModelKeys).toBe(false);
  });
});

// ===========================================================================
// ページャ
// ===========================================================================

describe('[#3305] ページャには pad だけ', () => {
  // ターミナル面はページャも同じ pad で描く（`isPagerActive` は `isSelectionListActive` の
  // 部分集合）。ページャの本文は transcript で、`1.` `2.` は選択肢ではない。
  it.each<[string, string, string]>([
    ['番号つきの本文（codex の /model のフレーム）', CODEX_MODEL, 'codex'],
    ['セッションだけの確定を言うフッタ（claude の /model のフレーム）', CLAUDE_MODEL, 'claude'],
  ])('%s でも、番号キーも確定ボタンも出さず、Enter は残す', (_name, frame, cliToolId) => {
    expect(ops(frame, cliToolId, 'terminal', true)).toEqual({
      padEnter: true,
      numberKeyCount: 0,
      commitKeys: null,
      planReview: false,
      opencodeModelKeys: false,
    });
  });

  // 陽性対照: 同じ入力でページャでなければ出る。上の 0 / null がフレームのせいでないことを示す。
  it('同じフレームでも、ページャでなければ番号キー・確定ボタンが出る', () => {
    expect(ops(CODEX_MODEL, 'codex', 'terminal', false).numberKeyCount).toBe(7);
    expect(ops(CLAUDE_MODEL, 'claude', 'terminal', false).commitKeys).not.toBeNull();
  });
});
