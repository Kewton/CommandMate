/**
 * Issue #4559 T7 — the design document of design A (docs/design/machine-lock-generation-4559.md) and the
 * model test (T1) say the same thing. The checks parse the document's tables and compare them pair by
 * pair (precedent: lock-observation-points-4288.test.ts, "the observation-point table"), not the presence
 * of a sentence, and every table counts its rows: a body row (a `|` line that is not the header or the
 * separator) that the parser cannot read is a problem, so a malformed row added to a table is red, not
 * skipped.
 *   1. the `mixed` table (§6.5): every row has an ID, the old writer it is against, an Issue number and a
 *      state (open / closed / later-PR), and the rows are exactly the named windows below
 *   2. the lemma / condition / invariant list (§5): the names whose "確かめる所" says T1 are exactly the
 *      names in T1's describe / it titles; the rest are exactly the model's NOT_IN_MODEL list
 *   3. the mutant table (§7.2) is exactly T1's mutants, safety and liveness apart
 *   4. the guarantee section (§2) says that safety between new versions does not lean on P0 and leans on
 *      P1・C2・C5・C6・C7, and that the windows while old writers remain are the `mixed` rows (§6.5)
 *   5. self-test: a copy with a row removed, an Issue number removed, a blunt mutant added, or a malformed
 *      row added (no backticks, bold, two spaces, a lower-case ID, an Issue of `—`, `| C10 |`) is red
 * The pairing with table F of docs/design/machine-lock-owner-atomic-4288.md is added by PR-2 (§9).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIVENESS_MUTANTS, NOT_IN_MODEL, SAFETY_MUTANTS } from './lock-generation-model-4559';

const REPO = path.resolve(__dirname, '../../..');
const DESIGN = path.join(REPO, 'docs/design/machine-lock-generation-4559.md');
const T1 = path.join(__dirname, 'machine-lock-generation-model-4559.test.ts');

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
const STATES = new Set(['open', 'closed', 'later-PR']);
const NAME = /\b([LCS][1-9][0-9]*)\b/g;

/** The body of the section whose heading starts with `heading`, up to the next heading of the same or a higher level. */
function section(doc: string, heading: string): string {
  const level = heading.match(/^#+/)?.[0].length ?? 0;
  const start = doc.split('\n').findIndex((l) => l.startsWith(`${heading} `) || l === heading);
  if (start < 0) return '';
  const lines = doc.split('\n').slice(start + 1);
  const end = lines.findIndex((l) => {
    const m = l.match(/^(#+) /);
    return m !== null && m[1].length <= level;
  });
  return (end < 0 ? lines : lines.slice(0, end)).join('\n');
}

/** The body rows of the tables in a section: `|` lines that are neither a table's first line (the header) nor a separator. */
function bodyRows(text: string): string[] {
  const rows: string[] = [];
  let inTable = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) { inTable = false; continue; }
    if (!inTable) { inTable = true; continue; } // the header
    if (/^\|[\s:|-]+\|?\s*$/.test(line)) continue; // the separator
    rows.push(line);
  }
  return rows;
}

/** Parse every body row with `re`; a row it cannot read is a problem (a malformed row is not skipped). */
function parseRows<T>(text: string, re: RegExp, read: (m: RegExpMatchArray) => T, where: string): { rows: T[]; problems: string[] } {
  const rows: T[] = [];
  const problems: string[] = [];
  for (const line of bodyRows(text)) {
    const m = line.match(re);
    if (m) rows.push(read(m));
    else problems.push(`${where}: cannot read the row ${JSON.stringify(line.slice(0, 60))}`);
  }
  return { rows, problems };
}

interface MixedRow { id: string; partner: string; issue: string; state: string }

/** The `mixed` table: `| 行 | 相手の版 | Issue | 状態 | 形 |`. */
function mixed(doc: string): { rows: MixedRow[]; problems: string[] } {
  return parseRows(
    section(doc, '### 6.5'),
    /^\| ([A-Z][A-Z0-9-]*) \|((?:[^|\\]|\\\|)*)\|([^|]*)\|([^|]*)\|/,
    (m) => ({ id: m[1], partner: m[2].trim(), issue: m[3].trim(), state: m[4].trim().replace(/`/g, '') }),
    '§6.5',
  );
}

function mixedProblems(doc: string): string[] {
  const { rows, problems } = mixed(doc);
  if (rows.length === 0) problems.push('§6.5 has no `mixed` table');
  for (const r of rows) {
    if (r.partner === '') problems.push(`${r.id}: no old writer named`);
    if (!/^#\d+(・#\d+)*$/.test(r.issue)) problems.push(`${r.id}: Issue "${r.issue}" is not #<n>`);
    if (!STATES.has(r.state)) problems.push(`${r.id}: state "${r.state}" is not open / closed / later-PR`);
  }
  const got = rows.map((r) => ({ id: r.id, state: r.state }));
  if (JSON.stringify(got) !== JSON.stringify(MIXED_ROWS)) problems.push(`rows ${JSON.stringify(got)} are not ${JSON.stringify(MIXED_ROWS)}`);
  return problems;
}

/** The §5 list: `| L1 | 文 | 確かめる所 |`. */
function names(doc: string): { rows: Array<{ name: string; where: string }>; problems: string[] } {
  return parseRows(section(doc, '## 5.'), /^\| ([LCS][1-9][0-9]*) \|.*\|([^|]*)\|\s*$/, (m) => ({ name: m[1], where: m[2].trim() }), '§5');
}

/** The names in T1's describe / it titles (single-quoted literals). */
function t1TitleNames(t1: string): string[] {
  const titles = [...t1.matchAll(/\b(?:describe|it)(?:\.each\([^)]*\))?\(\s*'((?:\\.|[^'\\])*)'/g)].map((m) => m[1]);
  return [...new Set(titles.flatMap((t) => [...t.matchAll(NAME)].map((m) => m[1])))].sort();
}

function namesProblems(doc: string, t1: string): string[] {
  const { rows, problems } = names(doc);
  const listed = rows.map((r) => r.name);
  if (new Set(listed).size !== listed.length) problems.push(`§5 names a name twice: ${listed.join(' ')}`);
  const inT1 = rows.filter((r) => r.where.includes('T1')).map((r) => r.name).sort();
  const notInModel = rows.filter((r) => !r.where.includes('T1')).map((r) => r.name).sort();
  const titles = t1TitleNames(t1);
  if (JSON.stringify(inT1) !== JSON.stringify(titles)) problems.push(`§5 says T1 checks ${inT1.join(' ')}, T1's titles name ${titles.join(' ')}`);
  const model = Object.keys(NOT_IN_MODEL).sort();
  if (JSON.stringify(notInModel) !== JSON.stringify(model)) problems.push(`§5 says the model leaves ${notInModel.join(' ')}, NOT_IN_MODEL lists ${model.join(' ')}`);
  return problems;
}

/** The §7.2 table: `| \`gc-max\` | S1・S2 | … |`. */
function mutants(doc: string): { rows: Array<[string, 'safety' | 'liveness']>; problems: string[] } {
  return parseRows(section(doc, '### 7.2'), /^\| `([a-z0-9-]+)` \| ([^|]+) \|/, (m) => [m[1], m[2].includes('S4') ? 'liveness' : 'safety'] as [string, 'safety' | 'liveness'], '§7.2');
}

function mutantProblems(doc: string): string[] {
  const { rows, problems } = mutants(doc);
  const want = [...SAFETY_MUTANTS.map((m) => [m, 'safety']), ...LIVENESS_MUTANTS.map((m) => [m, 'liveness'])];
  if (JSON.stringify(rows) !== JSON.stringify(want)) problems.push(`§7.2 lists ${JSON.stringify(rows)}, T1 runs ${JSON.stringify(want)}`);
  return problems;
}

function guaranteeProblems(doc: string): string[] {
  const g = section(doc, '## 2.');
  const problems: string[] = [];
  const sentence = g.split(/(?<=。)/).find((x) => x.includes('新版どうしの安全')) ?? '';
  if (!sentence.includes('P0 に依らず')) problems.push('§2 does not say that safety between new versions does not lean on P0');
  for (const premise of ['P1', 'C2', 'C5', 'C6', 'C7']) {
    if (!new RegExp(`\\b${premise}\\b`).test(sentence)) problems.push(`§2's safety sentence does not name ${premise}`);
  }
  if (!/混在の間の窓は[^。]*`mixed` の行（§6\.5）/.test(g)) problems.push('§2 does not say that the windows while old writers remain are the `mixed` rows (§6.5)');
  if (mixed(doc).rows.length === 0) problems.push('§6.5 has no `mixed` table');
  return problems;
}

describe('T7: the design document and the model say the same thing (#4559)', () => {
  const doc = (): string => fs.readFileSync(DESIGN, 'utf8');

  it('the `mixed` table: every row is readable and has an ID, an old writer, an Issue and a state, and the rows are the named windows', () => {
    expect(mixedProblems(doc())).toEqual([]);
  });

  it('the lemma / condition / invariant list: T1\'s titles name the ones it checks, NOT_IN_MODEL the rest, every row readable', () => {
    expect(names(doc()).rows.length).toBe(5 + 8 + 5);
    expect(namesProblems(doc(), fs.readFileSync(T1, 'utf8'))).toEqual([]);
  });

  it('the mutant table is exactly T1\'s mutants, safety and liveness apart, every row readable', () => {
    expect(mutantProblems(doc())).toEqual([]);
  });

  it('the guarantee section: not on P0 between new versions but on P1・C2・C5・C6・C7, and the mixed rows of §6.5', () => {
    expect(guaranteeProblems(doc())).toEqual([]);
  });
});

describe('T7 self-test: a broken copy of the document is red', () => {
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
  const afterLine = (text: string, prefix: string, added: string): string => {
    const line = lineStarting(text, prefix);
    return text.replace(line, `${line}\n${added}`);
  };

  it('one `mixed` row removed → red', () => {
    const text = original();
    expect(mixedProblems(copy(text.replace(`${lineStarting(text, '| P-2 |')}\n`, '')))).not.toEqual([]);
  });

  it('a row\'s Issue number removed → red', () => {
    const text = original();
    const row = lineStarting(text, '| P-4 |');
    const cells = row.split('|');
    cells[3] = ' ';
    expect(mixedProblems(copy(text.replace(row, cells.join('|'))))).not.toEqual([]);
  });

  it.each([
    ['a lower-case ID', '| p-6 | 旧い版 | #4559 | open | 形 |'],
    ['an Issue of —', '| P-6 | 旧い版 | — | open | 形 |'],
    ['a back-quoted ID', '| `P-6` | 旧い版 | #4559 | open | 形 |'],
  ])('a `mixed` row with %s added → red', (_what, row) => {
    expect(mixedProblems(copy(afterLine(original(), '| TICKET-DONE |', row)))).not.toEqual([]);
  });

  it('the guarantee sentence removed → red', () => {
    expect(guaranteeProblems(copy(original().replace(/P0 に依らず/g, 'P0 に依る')))).not.toEqual([]);
  });

  it('a premise dropped from the guarantee sentence → red', () => {
    expect(guaranteeProblems(copy(original().replace('C2（', 'readdir（')))).not.toEqual([]);
  });

  it('a blunt mutant added to the design\'s list (one T1 does not run) → red', () => {
    const blunt = '| `no-withdraw-end` | S4 | 身を引くときに `end` を付けない | (i) | 赤にならない |';
    expect(mutantProblems(copy(afterLine(original(), '| `c4-stuck` |', blunt)))).not.toEqual([]);
  });

  it.each([
    ['no backticks', '| no-withdraw-end | S4 | 身を引くときに `end` を付けない | (i) | — |'],
    ['bold', '| **`no-withdraw-end`** | S4 | 身を引くときに `end` を付けない | (i) | — |'],
    ['two spaces', '|  `no-withdraw-end`  | S4 | 身を引くときに `end` を付けない | (i) | — |'],
  ])('a mutant row with %s added → red', (_what, row) => {
    expect(mutantProblems(copy(afterLine(original(), '| `c4-stuck` |', row)))).not.toEqual([]);
  });

  it('a mutant row removed → red', () => {
    const text = original();
    expect(mutantProblems(copy(text.replace(`${lineStarting(text, '| `no-relist` |')}\n`, '')))).not.toEqual([]);
  });

  it('a `| C10 |` row added to §5 → red', () => {
    const t1 = fs.readFileSync(T1, 'utf8');
    expect(namesProblems(copy(afterLine(original(), '| C8 |', '| C10 | 新しい条件 | T2 |')), t1)).not.toEqual([]);
  });

  it('a name dropped from T1\'s titles → red', () => {
    const t1 = fs.readFileSync(T1, 'utf8').replace('tomb-separate L4,', 'tomb-separate,');
    expect(namesProblems(original(), t1)).not.toEqual([]);
  });
});
