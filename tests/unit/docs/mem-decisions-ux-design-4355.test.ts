/**
 * The design of Issue #4355 (the decisions screen chosen by repository → branch, the phone
 * and PC flow, and the CLI that reads decisions) carries what the contract asked of it:
 * the four upstream parts of `docs/orchestrate/team.md` §6 (invariants, the return/throw/
 * write table, the input × state table, the PR split), the CLI approval left to the 2-4-4
 * review behind a TTY-only proposal, and facts tied to file:line.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const DOC = 'docs/design/mem-decisions-ux-4355.md';

/** What a design text must name; each entry is [why, the words it must contain]. */
const REQUIRED: ReadonlyArray<readonly [string, string]> = [
  ['invariants section', '## 2. 不変条件'],
  ['return/throw/write table', '## 4. return・throw・書き込みの表'],
  ['input × state table', '## 5. 入力×状態の表'],
  ['PR split', '## 6. PR の分け方'],
  ['PR1 is the reading CLI', 'PR1 読みの CLI'],
  ['PR2 is the repository → branch select', 'PR2 画面の選択と PC'],
  ['PR3 is the phone', 'PR3 スマホ'],
  ['the reading CLI command', '`commandmate mem decisions'],
  ['CLI approval waits for the pre-review', '2-4-4'],
  ['CLI approval needs a TTY', 'TTY'],
  ['non-interactive runs are refused', 'パイプ'],
  ['the screen-only premise is named', '`screen_only`'],
  ['UI PRs put e2e in the contract and merge with --last', '`--last`'],
  ['both widths of the e2e', '390'],
  ['the PC width', '1280'],
  ['the URL shape is kept', '?branch=<name>'],
  ['the page is cited by file:line', 'page.tsx:'],
  ['the panel is cited by file:line', 'DecisionPromotePanel.tsx:'],
  ['the CLI is cited by file:line', 'mem.ts:'],
  ['related #4354', '#4354'],
  ['related #4225', '#4225'],
  ['facts and estimates are told apart', '見立て'],
];

/** The reasons a design text falls short of the contract (empty: it does not). */
export function designFindings(text: string): string[] {
  return REQUIRED.filter(([, words]) => !text.includes(words)).map(([why]) => why);
}

describe('design doc of #4355 (mem decisions UX)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const writeTemp = (text: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-4355-'));
    dirs.push(dir);
    const file = path.join(dir, 'doc.md');
    fs.writeFileSync(file, text);
    return file;
  };

  it('(positive control) a design without the upstream parts is flagged', () => {
    const file = writeTemp('# 決定の画面\n\n画面を直す。\n');
    const findings = designFindings(fs.readFileSync(file, 'utf8'));
    expect(findings).toContain('invariants section');
    expect(findings).toContain('PR split');
    expect(findings).toContain('CLI approval needs a TTY');
  });

  it('(negative control) a text naming every required part is not flagged', () => {
    const file = writeTemp(REQUIRED.map(([, words]) => words).join('\n'));
    expect(designFindings(fs.readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('the design exists and carries every required part', () => {
    const text = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
    expect(designFindings(text)).toEqual([]);
  });

  it('does not decide to add the CLI approval before the pre-review', () => {
    const text = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
    expect(text).toContain('この設計では入れると決めない');
  });

  it('cites only files that exist', () => {
    const text = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
    const cited = new Set([...text.matchAll(/`((?:src|tests|docs|\.claude|\.agents)\/[^`:\s*]+\.(?:tsx?|md|mjs))(?::\d+(?:-\d+)?)?`/g)].map((m) => m[1]));
    expect(cited.size).toBeGreaterThan(5);
    const missing = [...cited].filter((p) => !fs.existsSync(path.join(ROOT, p)));
    expect(missing).toEqual([]);
  });
});
