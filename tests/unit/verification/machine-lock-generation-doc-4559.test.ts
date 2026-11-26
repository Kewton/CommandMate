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
 *   3. §2 is the section below, character for character (the guarantee sentences and nothing that contradicts them)
 *   4. §5's "確かめる所" cells are made from the model (T1（§7.3）… / NOT_IN_MODEL); §7.5 holds HUMAN_READ
 *   5. HTML comments are taken out of the document first (a table or a sentence hidden in one is not drawn),
 *      and each heading the checks use appears exactly once
 *   6. self-test: copies with the rows the reviews found (and a model copy whose table lies) are red
 *   7. (PR-2) the pairing with table F (docs/design/machine-lock-owner-atomic-4288.md §3, its rows in
 *      machine-lock-owner-atomic-4288.test.ts): every `mixed` row of table F names one §6.5 row; the rows named
 *      are exactly §6.5's open and later-PR rows but M3-ERASE (the M3 PR); a closed row is named by none
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NAMES, NOT_IN_MODEL, checkedBy, humanReadLine, renderMutantTable, renderT1Checks, t1Checks } from './lock-generation-model-4559';

const REPO = path.resolve(__dirname, '../../..');
const DESIGN = path.join(REPO, 'docs/design/machine-lock-generation-4559.md');
const MODEL = path.join(__dirname, 'lock-generation-model-4559.ts');

/** §2, character for character (after its heading, up to the next heading). */
const GUARANTEE_SECTION = [
  '',
  '- **新版どうしの安全（S1・S2）は P0 に依らず、前提 P1（壁時計の前提・pid の再利用の判定 D7 を含む）と、C2（取得の後の一覧の readdir が最大を返す）・C5（世代の名前の書式）・C6（`.gen` を消さない運用）・C7（パスで名付けたロックの `.gen` の名前が 1 つ）に依る**。停止の長さ・回数に上限を置かない。これは前提を緩めて保証を守る形ではなく、保証が P0 を使わなくなる形',
  '- C2 が崩れると取得の後の一覧が最大を見落として L3 が崩れ、C5〜C7 が崩れると世代の番号が振り直されるか鎖が 2 本になって L1 が崩れる。どれも S1 に効くので、実装の一覧の書き方・`.gen` の置き場を変えるときはこの文に照らす',
  '- **P0 の定義の文は変えない**。P0 は活性（札の期限・持ち主の無い世代の猶予）と、混在の間の限界にだけ残る',
  '- **混在の間の窓は、旧い版の書き手・回収者を相手にする `mixed` の行（§6.5）だけ**。新版どうしには無い。混在は長く続く（無期限もありうる）前提で、「新版どうしは閉じた」と「旧い版との間は `mixed` の行」の 2 つの文で受け入れる。混在の終わりを待たずに成り立つ',
  '- 他ホストの記録は今どおり死と判定しない（待つ）',
  '',
  '---',
  '',
].join('\n');

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

/** The document as drawn: HTML comments taken out (what is hidden in one is not shown). */
const drawn = (doc: string): string => doc.replace(/<!--[\s\S]*?-->/g, '');

/** The headings of the document that start with `heading` (a check's heading must appear once). */
const headingsLike = (doc: string, heading: string): number => drawn(doc).split('\n').filter((l) => l.startsWith(`${heading} `) || l === heading).length;

/** The lines of the section whose heading starts with `heading`, up to the next heading of the same or a higher level. */
function section(doc: string, heading: string): string[] {
  const level = heading.match(/^#+/)?.[0].length ?? 0;
  const lines = drawn(doc).split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${heading} `) || l === heading);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#+) /);
    return m !== null && m[1].length <= level;
  });
  return end < 0 ? rest : rest.slice(0, end);
}

const headingProblems = (doc: string, heading: string): string[] => {
  const n = headingsLike(doc, heading);
  return n === 1 ? [] : [`${heading}: ${n} headings (one expected)`];
};

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
  const problems: string[] = headingProblems(doc, heading);
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
    if (!t1.has(name) && !(name in NOT_IN_MODEL)) problems.push(`§5 ${name}: neither T1 nor NOT_IN_MODEL`);
    else if (where !== checkedBy(name)) problems.push(`§5 ${name}: "確かめる所" is "${where}", the model makes "${checkedBy(name)}"`);
  }
  return problems;
}

function madeProblems(doc: string, heading: string, made: string): string[] {
  const found = tables(section(doc, heading));
  const problems: string[] = headingProblems(doc, heading);
  if (found.length !== 1) problems.push(`${heading}: ${found.length} tables (one expected)`);
  if ((found[0] ?? []).join('\n') !== made) problems.push(`${heading}: the table is not the one made from the model`);
  return problems;
}
const mutantProblems = (doc: string, made = renderMutantTable()): string[] => madeProblems(doc, '### 7.2', made);
const t1ChecksProblems = (doc: string, made = renderT1Checks()): string[] => madeProblems(doc, '### 7.3', made);

function guaranteeProblems(doc: string): string[] {
  const problems = headingProblems(doc, '## 2.');
  if (section(doc, '## 2.').join('\n') !== GUARANTEE_SECTION) problems.push('§2 is not the guarantee section, character for character');
  return problems;
}

function humanReadProblems(doc: string): string[] {
  const problems = headingProblems(doc, '### 7.5');
  if (!section(doc, '### 7.5').includes(humanReadLine())) problems.push(`§7.5 does not hold: ${humanReadLine()}`);
  return problems;
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

  it('§5 writes back to itself, names the model\'s names in order, and its "確かめる所" cells are the ones made from the model', () => {
    expect(namesProblems(doc())).toEqual([]);
  });

  it('§2 is the guarantee section, character for character', () => {
    expect(guaranteeProblems(doc())).toEqual([]);
  });

  it('§7.5 holds the names T1 cannot bind (HUMAN_READ), character for character', () => {
    expect(humanReadProblems(doc())).toEqual([]);
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
    ['the table hidden in an HTML comment and a different claim shown', () => { const t = original(); const sec = section(t, '### 6.5'); const table = tables(sec)[0].join('\n'); return copy(t.replace(table, `<!--\n${table}\n\n-->\n- P-1〜P-5 は全部 closed`)); }],
    ['a second "### 6.5" heading with an old table before the real one', () => { const t = original(); const at = t.indexOf('### 6.5 '); const old = tables(section(t, '### 6.5'))[0].join('\n').replace('| P-2 | ', '| P-2 | ').replace(/(\| P-2 \|[^\n]*\| #4559 \| )open/, '$1closed'); return copy(`${t.slice(0, at)}### 6.5 控え（前の版）\n\n${old}\n\n${t.slice(at)}`); }],
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
    ['the table hidden in an HTML comment', () => { const t = original(); const table = tables(section(t, '### 7.2'))[0].join('\n'); return copy(t.replace(table, `<!--\n${table}\n\n-->\n- \`no-relist\`・\`tomb-separate\` は今は緑`)); }],
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
    ['C5\'s cell rewritten T3 → T2', () => { const t = original(); const row = lineStarting(t, '| C5 |'); return copy(t.replace(row, row.replace(/\| T3 \|$/, '| T2 |'))); }],
    ['L6 added to §5 and §7.3 (the model does not have it)', () => { const t = afterLine(LAST_NAME, '| L6 | **墓は猶予の後にだけ置く** | T1（§7.3） |'); return copy(t.replace('| S1 | `walk-i`', '| L6 | `walk-i`・`walk-ii` で違反 0 |\n| S1 | `walk-i`')); }],
    ['a line without `|` right after the table', () => afterLine(LAST_NAME, 'C10 新しい条件')],
  ])('§5 with %s → red', (_what, make) => {
    expect(namesProblems(make())).not.toEqual([]);
  });

  it.each([
    ['negated', () => replaced('に依る**。停止の長さ', 'にも依らない**。停止の長さ')],
    ['a premise dropped', () => replaced('・C5（世代の名前の書式）', '')],
    ['the mixed sentence changed', () => replaced('`mixed` の行（§6.5）だけ**', '`mixed` の行（§6.5）にもある**')],
    ['hidden in an HTML comment and the negation shown', () => { const t = original(); const line = GUARANTEE_SECTION.split('\n')[1]; return copy(t.replace(line, `<!--\n${line}\n-->\n- **新版どうしの安全は P0 に依る**（停止が 10 分を超えると崩れる）`)); }],
    ['followed by a sentence that takes it back', () => replaced('- 他ホストの記録は今どおり死と判定しない（待つ）', '- 他ホストの記録は今どおり死と判定しない（待つ）\n- ただし、上の 1 つ目の文は取り消す。新版どうしの安全も P0 に依る')],
    ['under a second "## 2." heading', () => { const t = original(); const at = t.indexOf('## 2. '); return copy(`${t.slice(0, at)}## 2. 保証（前の版）\n\n- 新版どうしの安全も P0 に依る\n\n${t.slice(at)}`); }],
  ])('§2 with the guarantee %s → red', (_what, make) => {
    expect(guaranteeProblems(make())).not.toEqual([]);
  });

  it('§7.5 with the HUMAN_READ line changed → red', () => {
    expect(humanReadProblems(replaced(humanReadLine(), humanReadLine().replace('L2・S3', 'L2')))).not.toEqual([]);
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

// ---------------------------------------------------------------------------------------- 7: table F ↔ §6.5 (PR-2)

const TABLE_F = path.join(__dirname, 'machine-lock-owner-atomic-4288.test.ts');

/** Table F's `mixed` limits as written in its source: each `kind: 'mixed'` limit, and the §6.5 row it names (or null). */
export function tableFMixed(source: string): Array<{ id: string; row65: string | null }> {
  const out: Array<{ id: string; row65: string | null }> = [];
  let id = '';
  for (const line of source.split('\n')) {
    const row = /^ {2}'(F\d+-[a-z0-9-]+)': \{/.exec(line);
    if (row) id = row[1];
    if (/^ {4}limit: \{ kind: 'mixed'/.test(line)) out.push({ id, row65: /row65: '([^']+)'/.exec(line)?.[1] ?? null });
  }
  return out;
}

/** The §6.5 rows table F has to name: open and later-PR, but the M3 PR's (M3-ERASE). */
const namedBy = (rows: string[][]): string[] =>
  rows.filter((r) => (r[3] === 'open' || r[3] === 'later-PR') && r[0] !== 'M3-ERASE').map((r) => r[0]).sort();

function tableFProblems(doc: string, source: string): string[] {
  const { rows } = oneTable(doc, '### 6.5');
  const mixed = tableFMixed(source);
  const problems: string[] = [];
  if (mixed.length < 7) problems.push(`table F: only ${mixed.length} mixed rows read`);
  for (const m of mixed) if (m.row65 === null) problems.push(`table F ${m.id}: a mixed row naming no §6.5 row`);
  const ids = rows.map((r) => r[0]);
  for (const m of mixed) if (m.row65 !== null && !ids.includes(m.row65)) problems.push(`table F ${m.id}: names ${m.row65}, not a row of §6.5`);
  const named = [...new Set(mixed.map((m) => m.row65).filter((r): r is string => r !== null))].sort();
  if (JSON.stringify(named) !== JSON.stringify(namedBy(rows))) problems.push(`table F names ${JSON.stringify(named)}, §6.5's open rows are ${JSON.stringify(namedBy(rows))}`);
  for (const r of rows.filter((x) => x[3] === 'closed')) if (mixed.some((m) => m.row65 === r[0])) problems.push(`table F names the closed row ${r[0]}`);
  return problems;
}

describe('#4559 T7 (PR-2): table F\'s mixed rows and §6.5, both ways', () => {
  it('every mixed row of table F names a §6.5 row, and the open rows of §6.5 are exactly the ones named', () => {
    expect(tableFMixed(fs.readFileSync(TABLE_F, 'utf8')).length).toBeGreaterThanOrEqual(7);
    expect(tableFProblems(fs.readFileSync(DESIGN, 'utf8'), fs.readFileSync(TABLE_F, 'utf8'))).toEqual([]);
  });

  it.each([
    ['a §6.5 row removed', (d: string, f: string) => [d.replace(/^\| STALE-NEST \|.*\n/m, ''), f]],
    ['a mixed row of table F without its §6.5 row', (d: string, f: string) => [d, f.replace("row65: 'TICKET-DONE' ", '')]],
    ['a table F row naming a row §6.5 lacks', (d: string, f: string) => [d, f.replace("row65: 'P-3' ", "row65: 'P-9' ")]],
    ['a table F row naming the closed P-1', (d: string, f: string) => [d, f.replace("row65: 'P-1-PIDONLY' ", "row65: 'P-1' ")]],
    ['an open §6.5 row nobody names', (d: string, f: string) => [d.replace('| P-4 | 目印の旧い版の保有者', '| P-6 | 新しい窓 |'), f]],
  ] as const)('self-test: %s → red', (_what, make) => {
    const [doc, source] = make(fs.readFileSync(DESIGN, 'utf8'), fs.readFileSync(TABLE_F, 'utf8'));
    expect(tableFProblems(doc, source)).not.toEqual([]);
  });
});
