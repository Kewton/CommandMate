/**
 * Issue #4559 T7 — the design document of design A (docs/design/machine-lock-generation-4559.md) and the
 * model (T1) say the same thing. Every check is an exact match; nothing is recognised by a row's shape:
 *   1. §7.2 (the mutants) and §7.3 (the names T1 checks) are made from the model's MUTANT_TABLE — the
 *      section's table must be the made table, character for character
 *   2. §6.5 (`mixed`) and §5 (lemmas, conditions, invariants) are the design's own tables: parsing the
 *      table and writing it back must give the table, character for character (a round trip), and the
 *      parsed rows are compared with the named windows / the model's names. The table is what GFM draws:
 *      from its first line to the first blank line, so a line without a `|` right after it is a row too;
 *      a second table (or a stray `|` line) in the section is a problem
 *   3. §2 holds the two guarantee sentences below, character for character
 *   4. self-test: copies with the rows the reviews found (and a model copy whose table lies) are red
 * The pairing with table F of docs/design/machine-lock-owner-atomic-4288.md is added by PR-2 (§9).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NAMES, NOT_IN_MODEL, renderMutantTable, renderT1Checks, t1Checks } from './lock-generation-model-4559';

const REPO = path.resolve(__dirname, '../../..');
const DESIGN = path.join(REPO, 'docs/design/machine-lock-generation-4559.md');
const MODEL = path.join(__dirname, 'lock-generation-model-4559.ts');

/** The guarantee sentences of §2, character for character. */
const GUARANTEE = [
  '- **新版どうしの安全（S1・S2）は P0 に依らず、前提 P1（壁時計の前提・pid の再利用の判定 D7 を含む）と、C2（取得の後の一覧の readdir が最大を返す）・C5（世代の名前の書式）・C6（`.gen` を消さない運用）・C7（パスで名付けたロックの `.gen` の名前が 1 つ）に依る**。停止の長さ・回数に上限を置かない。これは前提を緩めて保証を守る形ではなく、保証が P0 を使わなくなる形',
  '- **混在の間の窓は、旧い版の書き手・回収者を相手にする `mixed` の行（§6.5）だけ**。新版どうしには無い。混在は長く続く（無期限もありうる）前提で、「新版どうしは閉じた」と「旧い版との間は `mixed` の行」の 2 つの文で受け入れる。混在の終わりを待たずに成り立つ',
];

/** The named windows while old writers remain (design §6.5). A row is added by the PR that names it. */
const MIXED_ROWS: Array<{ id: string; state: 'open' | 'closed' | 'later-PR' }> = [
  { id: 'P-1', state: 'closed' },
  { id: 'P-1-PIDONLY', state: 'open' },
  { id: 'P-2', state: 'open' },
  { id: 'P-3', state: 'later-PR' },
  { id: 'P-4', state: 'open' },
  { id: 'P-5', state: 'open' },
  { id: 'STALE-NEST', state: 'open' },
  { id: 'M3-ERASE', state: 'later-PR' },
  { id: 'TICKET-DONE', state: 'open' },
];
const MIXED_HEADER = ['行', '相手の版（旧い書き手）', 'Issue', '状態', '形'];
const NAMES_HEADER = ['名', '文', '確かめる所'];

/** The lines of the section whose heading starts with `heading`, up to the next heading of the same or a higher level. */
function section(doc: string, heading: string): string[] {
  const level = heading.match(/^#+/)?.[0].length ?? 0;
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${heading} `) || l === heading);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#+) /);
    return m !== null && m[1].length <= level;
  });
  return end < 0 ? rest : rest.slice(0, end);
}

/** The tables of a section as GFM draws them: from a line starting with `|` (after spaces) to the first blank line. */
function tables(lines: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    if (cur !== null) {
      if (line.trim() === '') { out.push(cur); cur = null; } else cur.push(line);
    } else if (line.trimStart().startsWith('|')) cur = [line];
  }
  if (cur !== null) out.push(cur);
  return out;
}

const cellsOf = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
const writeRow = (cells: string[]): string => `| ${cells.join(' | ')} |`;

/** The one table of a section, its round trip, and its parsed rows. */
function oneTable(doc: string, heading: string): { table: string[]; problems: string[]; header: string[]; rows: string[][] } {
  const found = tables(section(doc, heading));
  const problems: string[] = [];
  if (found.length !== 1) problems.push(`${heading}: ${found.length} tables (one expected)`);
  const table = found[0] ?? [];
  const header = table.length > 0 ? cellsOf(table[0]) : [];
  const rows = table.slice(2).map(cellsOf);
  const back = table.length === 0 ? [] : [writeRow(header), `|${'---|'.repeat(header.length)}`, ...rows.map(writeRow)];
  if (back.join('\n') !== table.join('\n')) problems.push(`${heading}: the table does not write back to itself`);
  return { table, problems, header, rows };
}

function mixedProblems(doc: string): string[] {
  const { problems, header, rows } = oneTable(doc, '### 6.5');
  if (JSON.stringify(header) !== JSON.stringify(MIXED_HEADER)) problems.push(`§6.5: header ${JSON.stringify(header)}`);
  for (const [id, partner, issue, state] of rows) {
    if ((partner ?? '') === '') problems.push(`${id}: no old writer named`);
    if (!/^#\d+(・#\d+)*$/.test(issue ?? '')) problems.push(`${id}: Issue "${issue}" is not #<n>`);
    if (!['open', 'closed', 'later-PR'].includes(state ?? '')) problems.push(`${id}: state "${state}"`);
  }
  const got = rows.map(([id, , , state]) => ({ id, state }));
  if (JSON.stringify(got) !== JSON.stringify(MIXED_ROWS)) problems.push(`§6.5: rows ${JSON.stringify(got)} are not ${JSON.stringify(MIXED_ROWS)}`);
  return problems;
}

function namesProblems(doc: string): string[] {
  const { problems, header, rows } = oneTable(doc, '## 5.');
  if (JSON.stringify(header) !== JSON.stringify(NAMES_HEADER)) problems.push(`§5: header ${JSON.stringify(header)}`);
  const names = rows.map((r) => r[0]);
  if (JSON.stringify(names) !== JSON.stringify(NAMES)) problems.push(`§5: names ${names.join(' ')} are not the model's ${NAMES.join(' ')}`);
  const t1 = new Set(t1Checks().map((c) => c.name));
  for (const [name, , where] of rows) {
    const saysT1 = (where ?? '').includes('T1');
    if (saysT1 !== t1.has(name)) problems.push(`§5 ${name}: says ${saysT1 ? '' : 'not '}T1, the model's §7.3 ${t1.has(name) ? 'has' : 'has not'} it`);
    if (saysT1 && !(where ?? '').startsWith('T1（§7.3）')) problems.push(`§5 ${name}: the T1 column is not "T1（§7.3）…"`);
    if (!saysT1 && !(name in NOT_IN_MODEL)) problems.push(`§5 ${name}: neither T1 nor NOT_IN_MODEL`);
  }
  return problems;
}

function madeProblems(doc: string, heading: string, made: string): string[] {
  const found = tables(section(doc, heading));
  const problems: string[] = [];
  if (found.length !== 1) problems.push(`${heading}: ${found.length} tables (one expected)`);
  if ((found[0] ?? []).join('\n') !== made) problems.push(`${heading}: the table is not the one made from the model`);
  return problems;
}
const mutantProblems = (doc: string, made = renderMutantTable()): string[] => madeProblems(doc, '### 7.2', made);
const t1ChecksProblems = (doc: string, made = renderT1Checks()): string[] => madeProblems(doc, '### 7.3', made);

function guaranteeProblems(doc: string): string[] {
  const lines = section(doc, '## 2.');
  return GUARANTEE.filter((g) => !lines.includes(g)).map((g) => `§2 does not hold: ${g.slice(0, 40)}…`);
}

describe('T7: the design document and the model say the same thing (#4559)', () => {
  const doc = (): string => fs.readFileSync(DESIGN, 'utf8');

  it('§7.2 is the mutant table made from the model, character for character', () => {
    expect(mutantProblems(doc())).toEqual([]);
  });

  it('§7.3 is the table of the names T1 checks made from the model, character for character', () => {
    expect(t1ChecksProblems(doc())).toEqual([]);
  });

  it('§6.5 (`mixed`) writes back to itself and its rows are the named windows, each with an old writer, an Issue and a state', () => {
    expect(mixedProblems(doc())).toEqual([]);
  });

  it('§5 writes back to itself, names the model\'s names in order, and says T1（§7.3） exactly for the names of §7.3', () => {
    expect(namesProblems(doc())).toEqual([]);
  });

  it('§2 holds the guarantee sentences, character for character', () => {
    expect(guaranteeProblems(doc())).toEqual([]);
  });
});

describe('T7 self-test: a broken copy is red', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-gen-doc-4559-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const copy = (text: string): string => {
    const p = path.join(dir, 'design.md');
    fs.writeFileSync(p, text);
    return fs.readFileSync(p, 'utf8');
  };
  const original = (): string => fs.readFileSync(DESIGN, 'utf8');
  const lineStarting = (text: string, prefix: string): string => {
    const line = text.split('\n').find((l) => l.startsWith(prefix));
    if (line === undefined) throw new Error(`no line starts with ${prefix}`);
    return line;
  };
  const afterLine = (prefix: string, added: string): string => {
    const text = original();
    const line = lineStarting(text, prefix);
    return copy(text.replace(line, `${line}\n${added}`));
  };
  const replaced = (from: string, to: string): string => {
    const text = original();
    if (!text.includes(from)) throw new Error(`the design has no ${from}`);
    return copy(text.replace(from, to));
  };
  const LAST_MIXED = '| TICKET-DONE |';
  const LAST_MUTANT = '| `abort-no-end` |';
  const LAST_NAME = '| S5 |';
  const BLUNT = '| `no-withdraw-end` | S4 | (i) | a4 | — | — | 身を引くときに `end` を付けない | S4 で輪 |';

  it.each([
    ['a row removed (P-2)', () => { const t = original(); return copy(t.replace(`${lineStarting(t, '| P-2 |')}\n`, '')); }],
    ['an Issue removed (P-4)', () => { const t = original(); const row = lineStarting(t, '| P-4 |'); const c = row.split('|'); c[3] = ' '; return copy(t.replace(row, c.join('|'))); }],
    ['a P-6 with an Issue of —', () => afterLine(LAST_MIXED, '| P-6 | 旧い版 | — | open | 形 |')],
    ['a lower-case ID', () => afterLine(LAST_MIXED, '| p-6 | 旧い版 | #4559 | open | 形 |')],
    ['a back-quoted ID', () => afterLine(LAST_MIXED, '| `P-6` | 旧い版 | #4559 | open | 形 |')],
    ['a row with a leading space', () => afterLine(LAST_MIXED, ' | P-6 | 旧い版 | #4559 | open | 形 |')],
    ['a row right after a blank line', () => afterLine(LAST_MIXED, '\n| P-6 | 旧い版 | #4559 | open | 形 |')],
    ['a line without `|` right after the table', () => afterLine(LAST_MIXED, 'P-6 旧い版 #4559 open')],
  ])('§6.5 with %s → red', (_what, make) => {
    expect(mixedProblems(make())).not.toEqual([]);
  });

  it.each([
    ['a blunt mutant row', () => afterLine(LAST_MUTANT, BLUNT)],
    ['a row without backticks', () => afterLine(LAST_MUTANT, BLUNT.replace('`no-withdraw-end`', 'no-withdraw-end'))],
    ['a bold row', () => afterLine(LAST_MUTANT, BLUNT.replace('`no-withdraw-end`', '**`no-withdraw-end`**'))],
    ['a row with two spaces', () => afterLine(LAST_MUTANT, BLUNT.replace('| `no-withdraw-end` |', '|  `no-withdraw-end`  |'))],
    ['a row with a leading space', () => afterLine(LAST_MUTANT, ` ${BLUNT}`)],
    ['a row right after a blank line', () => afterLine(LAST_MUTANT, `\n${BLUNT}`)],
    ['a second table (a row, then a separator)', () => afterLine(LAST_MUTANT, `\n${BLUNT}\n|---|---|---|---|---|---|---|---|`)],
    ['a line without `|` right after the table', () => afterLine(LAST_MUTANT, '`no-withdraw-end` S4')],
    ['a row removed (no-relist)', () => { const t = original(); return copy(t.replace(`${lineStarting(t, '| `no-relist` |')}\n`, '')); }],
    ['no-postcheck\'s combination rewritten (ii) → (i)', () => replaced('| `no-postcheck` | S1・S2 | (ii) |', '| `no-postcheck` | S1・S2 | (i) |')],
  ])('§7.2 with %s → red', (_what, make) => {
    expect(mutantProblems(make())).not.toEqual([]);
  });

  it('§7.3 with a row rewritten (L3 credited to tomb-separate) → red', () => {
    expect(t1ChecksProblems(replaced('| L3 | `no-postcheck` が赤（§7.2） |', '| L3 | `tomb-separate` が赤（§7.2） |'))).not.toEqual([]);
  });

  it.each([
    ['a | C10 | row right after a blank line', () => afterLine(LAST_NAME, '\n| C10 | 新しい条件 | T2 |')],
    ['a | C10 | row in the table', () => afterLine(LAST_NAME, '| C10 | 新しい条件 | T2 |')],
    ['a name rewritten (L3 → L6)', () => replaced('| L3 |', '| L6 |')],
    ['a new lemma that says T1 (the names T1 checks come from the model)', () => afterLine(LAST_NAME, '| L6 | 新しい補題 | T1（§7.3） |')],
    ['a name moved off T1 (L4 → T2 only)', () => { const t = original(); const row = lineStarting(t, '| L4 |'); return copy(t.replace(row, row.replace(/\| T1（§7\.3）[^|]*\|$/, '| T2 |'))); }],
    ['a line without `|` right after the table', () => afterLine(LAST_NAME, 'C10 新しい条件')],
  ])('§5 with %s → red', (_what, make) => {
    expect(namesProblems(make())).not.toEqual([]);
  });

  it.each([
    ['negated', () => replaced('に依る**。停止の長さ', 'にも依らない**。停止の長さ')],
    ['a premise dropped', () => replaced('・C5（世代の名前の書式）', '')],
    ['the mixed sentence changed', () => replaced('`mixed` の行（§6.5）だけ**', '`mixed` の行（§6.5）にもある**')],
  ])('§2 with the guarantee %s → red', (_what, make) => {
    expect(guaranteeProblems(make())).not.toEqual([]);
  });

  it('a model copy whose table moves tomb-separate to another step makes a §7.2 the design does not hold → red', async () => {
    let text = fs.readFileSync(MODEL, 'utf8');
    const from = "name: 'tomb-separate', property: 'S1・S2', combo: '(i)', steps: ['j0']";
    if (!text.includes(from)) throw new Error('the model has no tomb-separate row');
    text = text.replace(from, "name: 'tomb-separate', property: 'S1・S2', combo: '(i)', steps: ['jk']");
    const file = path.join(dir, 'model-copy.ts');
    fs.writeFileSync(file, text);
    const m = (await import(file)) as typeof import('./lock-generation-model-4559');
    expect(mutantProblems(original(), m.renderMutantTable())).not.toEqual([]);
  });
});
