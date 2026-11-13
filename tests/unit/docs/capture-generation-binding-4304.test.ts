/**
 * The design of Issue #4304's prerequisite (bind a capture frame to the pane generation it
 * came from) carries what the contract asked of it: the cause with facts tied to file:line,
 * the invariants G1/G2, every capture reader R1〜R11 split into acting and display readers
 * (with `sweepStalePendingPrompts` as an acting one), the F1 design, the PR split before
 * #4304 PR2a, the test table T1〜T10 with the defence-removal controls (i)〜(iv), the
 * unconfirmed items, and how #4304's own design is rewritten in its revision 7.
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
  ['section 6: test table', '## 6. 全組み合わせの試験の表'],
  ['section 7: unconfirmed', '## 7. 未確認・未決と確かめ方'],
  ['section 8: relation to #4304', '## 8. #4304 の設計書との関係'],
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
  ...['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11'].map(
    (r) => [`reader ${r}`, `| ${r} |`] as const,
  ),
  ...['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10'].map(
    (t) => [`test ${t}`, `| ${t} |`] as const,
  ),
  ...['(i)', '(ii)', '(iii)', '(iv)'].map((c) => [`control ${c}`, `**${c}**`] as const),
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
    expect(findings).toContain('reader R11');
    expect(findings).toContain('test T10');
    expect(findings).toContain('control (iv)');
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
