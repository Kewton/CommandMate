/**
 * Issue #4559 T7 — the design document of design A (docs/design/machine-lock-generation-4559.md) and the
 * model test (T1) say the same thing. The checks parse the document's tables and compare them pair by
 * pair (precedent: lock-observation-points-4288.test.ts, "the observation-point table"), not the presence
 * of a sentence:
 *   1. the `mixed` table (§6.5): every row has an ID, the old writer it is against, an Issue number and a
 *      state (open / closed / later-PR), and the rows are exactly the named windows below
 *   2. the lemma / condition / invariant list (§5) is exactly the set of names the T1 file names
 *   3. the mutant table (§7.2) is exactly T1's mutants, safety and liveness apart
 *   4. the guarantee section (§2) says "between new versions safety does not lean on P0" and "the windows
 *      while old writers remain are the `mixed` rows", and points at the `mixed` section
 *   5. self-test: a copy with one `mixed` row removed, with a row's Issue number removed, or with a blunt
 *      mutant added to the mutant table, is red
 * The pairing with table F of docs/design/machine-lock-owner-atomic-4288.md is added by PR-2 (§9).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIVENESS_MUTANTS, SAFETY_MUTANTS } from './lock-generation-model-4559';

const REPO = path.resolve(__dirname, '../../..');
const DESIGN = path.join(REPO, 'docs/design/machine-lock-generation-4559.md');
const T1 = path.join(__dirname, 'machine-lock-generation-model-4559.test.ts');

/** The named windows while old writers remain (design §6.5). A row is added by the PR that names it. */
const MIXED_ROWS: Array<{ id: string; state: 'open' | 'closed' | 'later-PR' }> = [
  { id: 'P-1', state: 'closed' },
  { id: 'P-2', state: 'open' },
  { id: 'P-3', state: 'later-PR' },
  { id: 'P-4', state: 'open' },
  { id: 'P-5', state: 'open' },
  { id: 'STALE-NEST', state: 'open' },
  { id: 'M3-ERASE', state: 'later-PR' },
  { id: 'TICKET-DONE', state: 'open' },
];
const STATES = new Set(['open', 'closed', 'later-PR']);

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

interface MixedRow { id: string; partner: string; issue: string; state: string }

/** The `mixed` table: `| ID | 相手の版 | Issue | 状態 | 形 |`. */
function mixedRows(doc: string): MixedRow[] {
  return [...section(doc, '### 6.5').matchAll(/^\| ([A-Z0-9-]+) \|([^|]*)\|([^|]*)\|([^|]*)\|/gm)].map((m) => ({
    id: m[1],
    partner: m[2].trim(),
    issue: m[3].trim(),
    state: m[4].trim().replace(/`/g, ''),
  }));
}

function mixedProblems(doc: string): string[] {
  const rows = mixedRows(doc);
  const problems: string[] = [];
  for (const r of rows) {
    if (r.partner === '') problems.push(`${r.id}: no old writer named`);
    if (!/^#\d+(・#\d+)*$/.test(r.issue)) problems.push(`${r.id}: Issue "${r.issue}" is not #<n>`);
    if (!STATES.has(r.state)) problems.push(`${r.id}: state "${r.state}" is not open / closed / later-PR`);
  }
  const got = rows.map((r) => ({ id: r.id, state: r.state }));
  if (JSON.stringify(got) !== JSON.stringify(MIXED_ROWS)) problems.push(`rows ${JSON.stringify(got)} are not ${JSON.stringify(MIXED_ROWS)}`);
  return problems;
}

const NAME = /\b([LCS][1-9])\b/g;

/** The §5 list: rows `| L1 | … |`. */
function designNames(doc: string): string[] {
  return [...section(doc, '## 5.').matchAll(/^\| ([LCS][1-9]) \|/gm)].map((m) => m[1]);
}

/** The §7.2 table: rows `| \`gc-max\` | S1・S2 | … |`. */
function designMutants(doc: string): Array<[string, 'safety' | 'liveness']> {
  return [...section(doc, '### 7.2').matchAll(/^\| `([a-z0-9-]+)` \| ([^|]+) \|/gm)].map((m) => [m[1], m[2].includes('S4') ? 'liveness' : 'safety']);
}

function guaranteeProblems(doc: string): string[] {
  const g = section(doc, '## 2.');
  const problems: string[] = [];
  if (!/新版どうしの安全[^。]*P0 に依らない/.test(g)) problems.push('§2 does not say that safety between new versions does not lean on P0');
  if (!/混在の間の窓は[^。]*`mixed` の行（§6\.5）/.test(g)) problems.push('§2 does not say that the windows while old writers remain are the `mixed` rows (§6.5)');
  if (mixedRows(doc).length === 0) problems.push('§6.5 has no `mixed` table');
  return problems;
}

describe('T7: the design document and the model say the same thing (#4559)', () => {
  const doc = (): string => fs.readFileSync(DESIGN, 'utf8');

  it('the `mixed` table: every row has an ID, an old writer, an Issue and a state, and the rows are the named windows', () => {
    expect(mixedProblems(doc())).toEqual([]);
  });

  it('the lemma / condition / invariant list is exactly the names the T1 file names', () => {
    const listed = designNames(doc());
    expect(listed).toEqual([...new Set(listed)]);
    expect(listed.length).toBe(5 + 8 + 5);
    const named = [...new Set([...fs.readFileSync(T1, 'utf8').matchAll(NAME)].map((m) => m[1]))];
    expect(named.sort()).toEqual([...listed].sort());
  });

  it('the mutant table is exactly T1\'s mutants, safety and liveness apart', () => {
    const want = [...SAFETY_MUTANTS.map((m) => [m, 'safety']), ...LIVENESS_MUTANTS.map((m) => [m, 'liveness'])];
    expect(designMutants(doc())).toEqual(want);
  });

  it('the guarantee section says "not on P0 between new versions" and "the mixed rows", and points at §6.5', () => {
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

  it('one `mixed` row removed → red', () => {
    const text = fs.readFileSync(DESIGN, 'utf8');
    const row = text.split('\n').find((l) => l.startsWith('| P-2 |'));
    expect(row).toBeDefined();
    expect(mixedProblems(copy(text.replace(`${row as string}\n`, '')))).not.toEqual([]);
  });

  it('a row\'s Issue number removed → red', () => {
    const text = fs.readFileSync(DESIGN, 'utf8');
    const row = text.split('\n').find((l) => l.startsWith('| P-4 |')) as string;
    const cells = row.split('|');
    cells[3] = ' ';
    expect(mixedProblems(copy(text.replace(row, cells.join('|'))))).not.toEqual([]);
  });

  it('the guarantee sentence removed → red', () => {
    const text = fs.readFileSync(DESIGN, 'utf8');
    expect(guaranteeProblems(copy(text.replace(/P0 に依らない/g, 'P0 に依る')))).not.toEqual([]);
  });

  it('a blunt mutant added to the design\'s list (one T1 does not run) → red', () => {
    const text = fs.readFileSync(DESIGN, 'utf8');
    const row = text.split('\n').find((l) => l.startsWith('| `c4-stuck` |')) as string;
    const blunt = '| `no-withdraw-end` | S4 | 身を引くときに `end` を付けない | (i) | 赤にならない |';
    const want = [...SAFETY_MUTANTS.map((m) => [m, 'safety']), ...LIVENESS_MUTANTS.map((m) => [m, 'liveness'])];
    expect(designMutants(copy(text.replace(row, `${row}\n${blunt}`)))).not.toEqual(want);
  });

  it('a mutant row removed → red', () => {
    const text = fs.readFileSync(DESIGN, 'utf8');
    const row = text.split('\n').find((l) => l.startsWith('| `no-relist` |')) as string;
    expect(designMutants(copy(text.replace(`${row}\n`, '')))).not.toEqual(designMutants(text));
  });
});
