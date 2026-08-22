/**
 * Issue #1271: モジュールスコープ const の表示文言直書きを検出する ESLint ルール
 *
 * このルールは `.eslintrc.json` の no-restricted-syntax セレクタとして実装されている。
 * セレクタは可読性が低く壊れても気付きにくいため、検出可否をテストで固定する。
 *
 * ## Issue #1977: なぜ `useEslintrc: false` なのか
 *
 * 以前はこのファイルが `new ESLint({ cwd: ROOT, useEslintrc: true })` を使い、
 * 最初の `lintText()` で `.eslintrc.json` の `extends`（`next/core-web-vitals` /
 * `next/typescript`）を解決していた。実測（アイドル時、開発機）:
 *
 *     eslint の import  95ms
 *     コンストラクタ     6ms
 *     1 回目 lintText  787ms   ← plugin ツリー（react / react-hooks / jsx-a11y /
 *     2 回目 lintText    4ms      import / @next / @typescript-eslint）の require
 *
 * つまりファイル所要のほぼ全部が「1 回目の lint で plugin を数百ファイル
 * require する」コストで、テスト対象のセレクタとは無関係だった。数百回の
 * ファイル読み込みは負荷で最も伸びる種類の仕事で、5000ms の既定予算に対する
 * 余裕をこのファイルから奪っていた（Issue #1977）。
 *
 * そこで plugin を読まない最小構成に切り替える。ただし **セレクタは実ファイル
 * `.eslintrc.json` から読み出す**ので、「セレクタが壊れたら赤になる」という
 * このテストの存在理由は変わらない。parser も本番と同じ
 * `@typescript-eslint/parser`（`next/typescript` が設定するもの）を使うため、
 * セレクタが照合する AST の形も変わらない。
 *
 * 実測: 1 回目 lintText 787ms -> 16ms（コンストラクタ 199ms 込みで ~215ms）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const RULE = 'no-restricted-syntax';
const ESLINTRC = path.join(ROOT, '.eslintrc.json');

/** `.eslintrc.json` の 1 エントリ（severity を除いた no-restricted-syntax の要素）。 */
interface RestrictedSyntaxEntry {
  selector: string;
  message: string;
}

/**
 * `.eslintrc.json` を読む。
 *
 * このファイルは JSONC（行頭 `//` コメントつき）なので、行コメントだけを落として
 * から `JSON.parse` する。文字列の途中に `//` を含む値は現時点で存在せず、
 * 混入したらここで `JSON.parse` が落ちるか、下の 2 つのガードが落ちる。
 */
function readEslintrc(): {
  rules: Record<string, unknown>;
  overrides?: Array<{ files: string[]; rules?: Record<string, unknown> }>;
} {
  const raw = fs.readFileSync(ESLINTRC, 'utf8');
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
}

let eslint: ESLint;
let entries: RestrictedSyntaxEntry[];

beforeAll(() => {
  const config = readEslintrc();
  const declared = config.rules[RULE];

  // ガード 1: ルールがそもそも宣言されていること。`.eslintrc.json` から
  // no-restricted-syntax ごと消えたら、下の検出テストが「セレクタが無いので
  // 何も出ない」を「正しく検出しない」と読み違える前にここで落ちる。
  expect(Array.isArray(declared)).toBe(true);
  entries = (declared as unknown[]).slice(1) as RestrictedSyntaxEntry[];
  expect(entries.length).toBeGreaterThan(0);

  // ガード 2: overrides が `src/components/**.tsx` に対してこのルールを
  // 上書き・無効化していないこと。最小構成は overrides を再現しないので、
  // 誰かが上書きを足したらこのテストの前提が崩れる。その時は黙って通すのでは
  // なく赤にして、上書きを再現するかテストを分けるかを選ばせる。
  const overriding = (config.overrides ?? []).filter((o) => o.rules && RULE in o.rules);
  expect(overriding).toEqual([]);

  eslint = new ESLint({
    cwd: ROOT,
    useEslintrc: false,
    baseConfig: {
      // 本番は next/typescript 経由で同じ parser を使う。
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      rules: { [RULE]: ['error', ...entries] },
    },
  });
});

/** src 配下の .tsx として lint し、対象ルールの指摘行のみ返す */
async function lintHits(code: string): Promise<number[]> {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(ROOT, 'src/components/__i18n_rule_fixture__.tsx'),
  });
  return result.messages.filter((m) => m.ruleId === RULE).map((m) => m.line);
}

describe('i18n: module-scope literal label rule (Issue #1271)', () => {
  it('detects the pre-fix Header.tsx shape (the regression this rule exists for)', async () => {
    // Issue #1206 で修正される前の Header.tsx の形
    const hits = await lintHits(`
const NAV_ITEMS: Array<{ label: string; href: string }> = [
  { label: 'Home', href: '/' },
  { label: 'Chat', href: '/chat' },
];
`);
    expect(hits).toEqual([3, 4]);
  });

  it('detects export const / as const / nested Record shapes', async () => {
    const hits = await lintHits(`
export const TABS = [{ label: 'Files' }] as const;
export const STATUS = { idle: { label: 'Idle' } };
export const META = { title: 'Offline' };
`);
    expect(hits).toEqual([2, 3, 4]);
  });

  it('does not flag the fixed labelKey form', async () => {
    const hits = await lintHits(`
const NAV_ITEMS = [
  { labelKey: 'nav.home', href: '/' },
];
`);
    expect(hits).toEqual([]);
  });

  it('does not flag hrefs, testids or other non-display properties', async () => {
    const hits = await lintHits(`
const ITEMS = [
  { href: '/chat', id: 'chat', 'data-testid': 'nav-chat', value: 'review' },
];
`);
    expect(hits).toEqual([]);
  });

  it('does not flag glyph-only labels (nothing to translate)', async () => {
    const hits = await lintHits(`
const KEYS = [{ label: '\\u25C0' }, { label: '\\u21B5' }];
`);
    expect(hits).toEqual([]);
  });

  it('does not flag literals inside a component body, where t() is reachable', async () => {
    // t() が呼べる位置は本ルールの対象外（#1270 の領分）。
    // ここを誤検知すると、ルールが無効化される原因になる。
    // `const X = () => {}` / `export const X = () => {}` はいずれもモジュールスコープの
    // VariableDeclaration なので、素朴な子孫セレクタだと関数本体まで誤検知が漏れる
    // （src/components/worktree/ContextMenu.tsx が実例）。
    const hits = await lintHits(`
const Inner = () => {
  const items = [{ label: 'Rename' }];
  return items;
};
export const Menu = () => {
  const items = [{ label: 'New File' }];
  return items.length;
};
`);
    expect(hits).toEqual([]);
  });
});
