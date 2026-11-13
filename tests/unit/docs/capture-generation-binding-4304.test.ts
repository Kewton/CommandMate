/**
 * The design of Issue #4304's prerequisite (bind a capture frame to the pane generation it
 * came from) carries what the contract asked of it: the cause with facts tied to file:line,
 * the invariants G0/G1/G2, every capture reader R1〜R10 and R11 split by function and side
 * effect (with `sweepStalePendingPrompts` as an acting one), the F1 design including the
 * action-entry boundary, the per-operation generation lifetime, the final-collection
 * condition, the claim states and the identifier preconditions (second edition, after the
 * 2-4-4 review A〜F), the PR split before #4304 PR2a, the tests T1〜T10, TA〜TF and the
 * defence-removal controls (i)〜(v), the undecided items with who decides them, and how
 * #4304's own design is rewritten in its revision 7.
 *
 * It also checks that every `src/…:<line>` the document cites names a file that exists and
 * has that many lines, so a rename or a shrink shows up here rather than in a worker's
 * "I cannot find it".
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const DOC = 'docs/design/capture-generation-binding-4304.md';

/** What the design text must name; each entry is [why, the words it must contain]. */
const REQUIRED: ReadonlyArray<readonly [string, string]> = [
  ['section 1: cause', '## 1. 問題と共通の原因'],
  ['section 2: invariants', '## 2. 不変条件'],
  ['section 3: readers table', '## 3. capture の全読者の表'],
  ['section 4: F1 design', '## 4. F1 の設計'],
  ['section 5: PR split', '## 5. PR の分け方'],
  ['section 6: tests', '## 6. 試験'],
  ['section 6.3: full combination axes', '### 6.3 全組み合わせの軸'],
  ['section 7: unconfirmed', '## 7. 未確認・未決と確かめ方'],
  ['section 8: relation to #4304', '## 8. #4304 の設計書との関係'],
  ['section 9: revision history', '## 9. 改訂の履歴'],
  ['R11 split by function and side effect', '### 3.3 R11 を関数・副作用の単位で分けた表'],
  ['drivers of acting side effects', '### 3.4 行動の副作用の駆動元'],
  ['action entry boundary (review B)', '### 4.3 行動の入口の境界'],
  ['per-operation generation lifetime (review B)', '### 4.4 操作ごとの世代の取り方・持ち方・取り直し'],
  ['final collection condition (review C)', '### 4.6 最後の画面の回収の条件'],
  ['collection claim states (review D)', '### 4.7 回収の権利'],
  ['generation identifier preconditions (review E)', '### 4.8 世代の識別子の成立条件'],
  ['top-level invariant G0', '**G0'],
  ['R10 goes to F1-b', '入れ先は F1-b に決めた'],
  ['claim lands with #4304 PR2a', '回収の権利（§4.7）と最後の回収（§4.6）は #4304 PR2a に入れる'],
  ['unknown never permits an action', 'どれも行動を許可しない'],
  ['claim states', '失敗（打ち切り）'],
  ['invariant G1', '**G1**'],
  ['invariant G2', '**G2**'],
  ['generation identifier', '`(server の start_time, pane_id)`'],
  ['facts and readings are told apart', '**読み**'],
  ['readPaneGeneration', '`readPaneGeneration`'],
  ['capturePaneById', '`capturePaneById`'],
  ['captureBoundFrame', '`captureBoundFrame`'],
  ['Fresh write-back is dropped', '書き戻し'],
  ['claim is taken synchronously before await', 'await の前に同期で取る'],
  ['claim is once per generation', '世代ごとに 1 回'],
  ['sweepStalePendingPrompts is an acting reader', '`sweepStalePendingPrompts`'],
  ['F1-a', '**F1-a**'],
  ['F1-b', '**F1-b**'],
  ['before #4304 PR2a', 'PR2a より前'],
  ['team.md §6-3', '§6-3'],
  ['F2 is not taken here', '**F2'],
  ['F3 is not taken', '**F3'],
  ['isolated tmux for the unconfirmed items', 'tmux -L'],
  ['revision 7 of #4304', '改訂 7'],
  ['R6.2 of #4304', 'R6.2'],
  ['R6.5 of #4304', 'R6.5'],
  ['readers are cited by file:line', 'response-checker.ts:'],
  ['the cache is cited by file:line', 'tmux-capture-cache.ts:'],
  ...['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11-a', 'R11-b1', 'R11-c', 'R11-d', 'R11-f4', 'R11-s', 'R11-g'].map(
    (r) => [`reader ${r}`, `| ${r} |`] as const,
  ),
  ...['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10'].map(
    (t) => [`test ${t}`, `| ${t} |`] as const,
  ),
  ...['(i)', '(ii)', '(iii)', '(iv)', '(v)'].map((c) => [`control ${c}`, `**${c}**`] as const),
  ...['TA1', 'TA4', 'TB1', 'TB2', 'TB3', 'TC1', 'TC2', 'TD1', 'TD2', 'TD4', 'TE1', 'TF1', 'TF2'].map(
    (t) => [`review control ${t}`, `| ${t} |`] as const,
  ),
  ...['E-1', 'E-2', 'E-3', 'E-4'].map((e) => [`identifier precondition ${e}`, `| ${e} `] as const),
  ...['U1', 'U2', 'U3', 'U4', 'U5', 'U6'].map((u) => [`undecided ${u} with owner`, `| ${u} |`] as const),
];

/** The reasons a design text falls short of the contract (empty: it does not). */
export function designFindings(text: string): string[] {
  return REQUIRED.filter(([, words]) => !text.includes(words)).map(([why]) => why);
}

/**
 * Every `src/<path>:<line>` citation (inside backticks) whose file is missing under `root`
 * or is shorter than the cited line. A range `:a-b` checks `b`.
 */
export function staleCitations(text: string, root: string): string[] {
  const found: string[] = [];
  const re = /`(src\/[^`\s:]+):(\d+)(?:-(\d+))?/g;
  for (const m of text.matchAll(re)) {
    const [, rel, start, end] = m;
    const file = path.join(root, rel);
    const line = Number(end ?? start);
    if (!fs.existsSync(file)) {
      found.push(`${rel}: missing`);
      continue;
    }
    const lines = fs.readFileSync(file, 'utf8').split('\n').length;
    if (lines < line) found.push(`${rel}:${line}: file has ${lines} lines`);
  }
  return found;
}

describe('design doc of #4304 prerequisite (capture generation binding)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-4304-capgen-'));
    dirs.push(dir);
    return dir;
  };

  it('(positive control) a design without the required parts is flagged', () => {
    const file = path.join(tempDir(), 'doc.md');
    fs.writeFileSync(file, '# capture\n\ncapture を直す。\n');
    const findings = designFindings(fs.readFileSync(file, 'utf8'));
    expect(findings).toContain('invariant G1');
    expect(findings).toContain('reader R11-s');
    expect(findings).toContain('top-level invariant G0');
    expect(findings).toContain('test T10');
    expect(findings).toContain('control (v)');
    expect(findings).toContain('review control TC1');
  });

  it('(negative control) a text naming every required part is not flagged', () => {
    const file = path.join(tempDir(), 'doc.md');
    fs.writeFileSync(file, REQUIRED.map(([, words]) => words).join('\n'));
    expect(designFindings(fs.readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('(positive control) a citation of a missing file or a line past the end is flagged', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'src/lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/lib/a.ts'), 'one\ntwo\n');
    const text = '`src/lib/a.ts:2` `src/lib/a.ts:1-9` `src/lib/gone.ts:1`';
    expect(staleCitations(text, root)).toEqual([
      'src/lib/a.ts:9: file has 3 lines',
      'src/lib/gone.ts: missing',
    ]);
  });

  it('(negative control) citations inside the file are not flagged', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/b.ts'), 'a\nb\nc\n');
    expect(staleCitations('`src/b.ts:3` `src/b.ts:1-2`', root)).toEqual([]);
  });

  it('the design exists and carries every required part', () => {
    const text = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
    expect(designFindings(text)).toEqual([]);
  });

  it('every src file:line the design cites exists in the tree', () => {
    const text = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
    expect(staleCitations(text, ROOT)).toEqual([]);
  });

  it('keeps F2 and F3 out of this design', () => {
    const text = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
    expect(text).toMatch(/\*\*F2[^\n]*\*\*: この設計では採らない/);
    expect(text).toMatch(/\*\*F3[^\n]*\*\*: 採らない/);
  });
});
