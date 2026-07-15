/**
 * Issue #1271: モジュールスコープ const の表示文言直書きを検出する ESLint ルール
 *
 * このルールは `.eslintrc.json` の no-restricted-syntax セレクタとして実装されている。
 * セレクタは可読性が低く壊れても気付きにくいため、検出可否をテストで固定する。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const RULE = 'no-restricted-syntax';

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT, useEslintrc: true });
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
