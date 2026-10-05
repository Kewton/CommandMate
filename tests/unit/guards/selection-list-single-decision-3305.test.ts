/**
 * 選択リストの操作を決める場所と描く場所は、それぞれ 1 つ（Issue #3305）
 *
 * ## 何が起きたか
 *
 * #2297（PR #2308）は、選択リストの操作 — 番号キーと、Claude の `/model` の
 * 「このセッションのみ（`s`）」「既定に設定（Enter）」 — を `ChatSurface` の
 * `case 'selectionList'` に足した。同じフレームに pad を出している場所はほかに 2 つ
 * あった（PC の分割ペインのフッタ、スマホのドック）。そちらは変わらず、どの suite も
 * 緑のままだった。足した面の suite は足したものを見て、足していない面の suite は
 * 「矢印と Enter が出る」を見ていたので、どちらも正しかった。ターミナル面で押せる確定が
 * 既定のモデルを書き換える Enter だけ、という状態は、過去の PR を読み直すまで見つからなかった。
 *
 * 取り残された呼び出し元は、コンパイルが通り、それらしい画面を出すので見えない。
 * だから固定するのは「ターミナル面にもボタンがある」ではなく（それは
 * `selection-list-surfaces-3305.test.tsx` が見る）、1 つの面だけが先へ進める**形**のほう:
 * 誰が選択リストの部品を直接載せてよいか、誰がフレームを直接読んでよいか。
 *
 * ## 固定するもの
 *
 *  1. 選択リストの下に並ぶ部品（番号キー、確定ボタン、Plan review、opencode のモデルのキー）を
 *     JSX で載せるのは `SelectionListKeys.tsx` だけ
 *  2. `SelectionListKeys` を載せるのは、下の表の面だけ（#3336 で `/sessions` のタイルが加わって 4 つ）
 *  3. `resolveSelectionListOps` を呼ぶのは `SelectionListKeys.tsx` だけ
 *  4. フレームを読む（`readSelectionListFrame`、その下の `readSelectionListShape`）のは、
 *     下の表のファイルだけ
 *
 * 新しい面に選択リストの操作を出すとき、あるいは新しい部品を足すとき、ここが赤くなる。
 * そのときは表に理由を書く。書けないなら、足す場所が違う。
 *
 * 走査は下の「走査が空振りしていない」で、JSX・呼び出し・コメントだけの言及・定義に当てて
 * 確かめる。何にも当たらない走査は、何も守らない。
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();

/** 選択リストの操作を描く部品。 */
const PART = 'src/components/worktree/SelectionListKeys.tsx';
/** 何を出すかを決める関数。 */
const DECISION = 'src/lib/session/selection-list-ops.ts';

/** `SelectionListKeys` を載せてよい面と、その理由。 */
const MOUNTS: readonly { file: string; why: string }[] = [
  {
    file: 'src/components/worktree/ChatSurface.tsx',
    why: 'チャット面のカード（`case \'selectionList\'`）。#2297 が操作を足した場所。',
  },
  {
    file: 'src/components/worktree/TerminalSplitPaneContent.tsx',
    why: 'ターミナル面: PC の分割ペインのフッタ。フレームは自分の `terminal.output`。',
  },
  {
    file: 'src/components/worktree/WorktreeDetailRefactored.tsx',
    why:
      'ターミナル面: スマホのドック。画面はフレームを持たないので（#736）、controller の poll が'
      + '読んだ読み取り（`selectionListReading`）を渡す。',
  },
  {
    file: 'src/components/sessions/SessionTile.tsx',
    why:
      'ターミナル面: `/sessions` のタイル（#3336）。#3305 が取り残した 4 つ目の面。'
      + 'フレームは自分の `terminal.output`。',
  },
] as const;

/** 選択リストの下に並ぶ部品。`SelectionListKeys` の外で載せると、面ごとの出し分けに戻る。 */
const STRIPS: readonly string[] = [
  'SelectionNumberKeys',
  'SelectionCommitKeys',
  'PlanReviewControls',
  'OpencodeModelKeys',
];

/** `readSelectionListFrame`（フレーム → 読み取り）を呼んでよいファイルと、その理由。 */
const FRAME_READERS: readonly { file: string; why: string }[] = [
  {
    file: PART,
    why: 'フレームを持っている面（チャット面のカード、PC のフッタ）のために、部品が読む。',
  },
  {
    file: 'src/hooks/useWorktreeDetailController.ts',
    why:
      'スマホの画面の poll。ドックは History / Files / Tools のタブでも出たままで、そこには'
      + 'フレームを持つターミナルのタブが無い。`isSelectionListActive` を受け取ったのと同じ'
      + '応答のフレームをここで読み、読み取りだけを state に持つ（フレームは持たない、#736）。',
  },
] as const;

/** その下の `readSelectionListShape` を直接呼んでよいファイルと、その理由。 */
const SHAPE_READERS: readonly { file: string; why: string }[] = [
  {
    file: DECISION,
    why: '`readSelectionListFrame` の中身。フレームの読み取りを、出す操作へ変える唯一の場所。',
  },
  {
    file: 'src/hooks/useWorktreeDetailController.ts',
    why:
      '#2809 の `offersPlanApprove`（Plan review かどうかの boolean）。同じ欄が'
      + '`selectionListReading` にあり、ドックはそちらを読むので、画面にはもう読み手が無い。'
      + '#3304 が同じ行を `paneGate` へ移しているため、このブランチでは消していない'
      + '（消すときは、この行を表から外す）。',
  },
] as const;

/** `src/` の ts / tsx。未コミットの新しいファイルも含める（ignore されたものは除く）。 */
function sources(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'src'],
    { cwd: REPO_ROOT, encoding: 'utf-8' },
  )
    .split('\0')
    .filter((f) => /\.tsx?$/.test(f) && existsSync(join(REPO_ROOT, f)));
}

/** コメントを落とす。docstring の中の `<Foo` や `foo(` を数えないため。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** このソースは `<Name …>` を JSX で載せているか。 */
export function mountsComponent(source: string, name: string): boolean {
  return new RegExp(`<${name}(?![\\w])`).test(stripComments(source));
}

/** このソースは `name(…)` を呼んでいるか（定義は数えない）。 */
export function callsFunction(source: string, name: string): boolean {
  return new RegExp(`(?<!function\\s)(?<![\\w.])${name}\\s*\\(`).test(stripComments(source));
}

function filesWhere(predicate: (source: string) => boolean): string[] {
  return sources()
    .filter((f) => predicate(readFileSync(join(REPO_ROOT, f), 'utf-8')))
    .sort();
}

describe('[#3305] 選択リストの部品を直接載せるのは SelectionListKeys だけ', () => {
  it.each(STRIPS)('<%s> を載せているのは部品のファイルだけ', (strip) => {
    expect(filesWhere((source) => mountsComponent(source, strip))).toEqual([PART]);
  });
});

describe('[#3305] SelectionListKeys を載せる面は、表の 3 つ', () => {
  const actual = filesWhere((source) => mountsComponent(source, 'SelectionListKeys'));

  it('表と一致する', () => {
    expect(actual).toEqual(MOUNTS.map((e) => e.file).sort());
  });

  it('どの面にも理由が書いてある', () => {
    for (const { file, why } of MOUNTS) {
      expect(why.length, `${file} に理由が要る`).toBeGreaterThan(20);
    }
  });
});

describe('[#3305] 何を出すかを決めるのは resolveSelectionListOps だけ', () => {
  it('呼ぶのは部品のファイルだけ（面は自分で判断を呼ばない）', () => {
    expect(filesWhere((source) => callsFunction(source, 'resolveSelectionListOps'))).toEqual([PART]);
  });

  it('フレームを読み取りにする（readSelectionListFrame）のは、表のファイルだけ', () => {
    expect(filesWhere((source) => callsFunction(source, 'readSelectionListFrame'))).toEqual(
      FRAME_READERS.map((e) => e.file).sort(),
    );
  });

  it('その下の readSelectionListShape を直接呼ぶのは、表のファイルだけ', () => {
    expect(filesWhere((source) => callsFunction(source, 'readSelectionListShape'))).toEqual(
      SHAPE_READERS.map((e) => e.file).sort(),
    );
  });

  it('どの読み手にも理由が書いてある', () => {
    for (const { file, why } of [...FRAME_READERS, ...SHAPE_READERS]) {
      expect(existsSync(join(REPO_ROOT, file)), `${file} は表にあるが、ファイルが無い`).toBe(true);
      expect(why.length, `${file} に理由が要る`).toBeGreaterThan(20);
    }
  });
});

describe('[#3305] 走査が空振りしていない', () => {
  it('JSX で載せていれば当たる（1 行でも、属性が次の行でも）', () => {
    expect(mountsComponent('return <SelectionCommitKeys {...keyProps} />;', 'SelectionCommitKeys')).toBe(true);
    expect(mountsComponent('return (\n  <SelectionCommitKeys\n    a={1}\n  />\n);', 'SelectionCommitKeys')).toBe(true);
  });

  it('コメントの中の言及、import、定義は「載せている」に数えない', () => {
    expect(mountsComponent('/** see <SelectionCommitKeys /> */\nexport const x = 1;', 'SelectionCommitKeys')).toBe(false);
    expect(mountsComponent('// <SelectionCommitKeys />\n', 'SelectionCommitKeys')).toBe(false);
    expect(mountsComponent("import { SelectionCommitKeys } from './PromptAnswerKeys';", 'SelectionCommitKeys')).toBe(false);
    expect(mountsComponent('export function SelectionCommitKeys() { return null; }', 'SelectionCommitKeys')).toBe(false);
  });

  it('名前が前方一致するだけの別の部品には当たらない', () => {
    expect(mountsComponent('<SelectionListKeysExtra />', 'SelectionListKeys')).toBe(false);
  });

  it('呼び出しには当たり、定義・コメント・メソッド呼び出しには当たらない', () => {
    expect(callsFunction('const s = readSelectionListShape(frame);', 'readSelectionListShape')).toBe(true);
    expect(callsFunction('export function readSelectionListShape(frame) {}', 'readSelectionListShape')).toBe(false);
    expect(callsFunction('/** `readSelectionListShape(frame).optionCount` */', 'readSelectionListShape')).toBe(false);
    expect(callsFunction('// readSelectionListShape(frame)\n', 'readSelectionListShape')).toBe(false);
    expect(callsFunction('other.readSelectionListShape(frame);', 'readSelectionListShape')).toBe(false);
  });
});
