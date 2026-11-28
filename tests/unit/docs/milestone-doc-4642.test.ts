/**
 * Where the Milestone check is run, and how a person's approval is synced (Issue #4642 PR-2).
 *
 * `scripts/orchestrate/milestone-check.mjs` (PR-1) is advice: it changes nothing and sees
 * nothing unless someone runs it. PR-2 writes, in one canon (docs/orchestrate/milestone.md),
 * the time points at which it is run and the steps that follow an approval, and puts the
 * `summary --md` output at the head of the PM's report (docs/orchestrate/roles/project-manager.md).
 *
 * Pinned (the table is the generator of plan-4642.md PR-2: time point × the document decided
 * for it, read by the letter):
 * - T1: each time point is a bullet of its document, inside the registered section
 *   (from the `## ` heading to the next `## `).
 * - T2: each bullet of TIME_POINTS is in exactly one document of docs/orchestrate/ (top level
 *   and roles/) and the /orchestrate body: the canon is one place, other places point at it.
 * - T3: the four sync steps after an approval are the numbered items of the canon's section, in order.
 *
 * Controls run against strings first (a document with the line removed, a second copy), then
 * the real files. The real files are only read.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DOCS_DIR = 'docs/orchestrate';
const BODY = '.claude/commands/orchestrate.md';
const CANON = 'docs/orchestrate/milestone.md';
const PM_ROLE = 'docs/orchestrate/roles/project-manager.md';

export interface Row {
  /** The time point (plan-4642.md PR-2). */
  when: string;
  /** The document decided for it. */
  doc: string;
  /** The `## ` heading of the section it lives in. */
  section: string;
  /** The start of the bullet line, verbatim. */
  line: string;
}

/** Time point × document. */
export const TIME_POINTS: ReadonlyArray<Row> = [
  { when: '再起動の直後', doc: CANON, section: '## 検査を流す時点', line: '- 再起動の後の読み直しの最初' },
  { when: '定期の見張り', doc: CANON, section: '## 検査を流す時点', line: '- 定期の見張り（PM の台帳の 30 分ごとの行）' },
  { when: 'PR のマージの後', doc: CANON, section: '## 検査を流す時点', line: '- PR のマージの後' },
  {
    when: '区切りの報告の前',
    doc: CANON,
    section: '## 検査を流す時点',
    line: '- 人への区切りの報告の前（`summary --md` の出力を報告の頭に貼る。',
  },
  {
    when: '区切りの報告の前（報告の形）',
    doc: PM_ROLE,
    section: '## 報告',
    line: '- 人への報告は、頭に今の区切りの表（例: `milestone-check.mjs summary --md` の出力）',
  },
  {
    when: '承認の後で次のディスパッチの前',
    doc: CANON,
    section: '## 検査を流す時点',
    line: '- 人の承認（「推奨で」を含む）の後、次のディスパッチの前',
  },
];

/** The steps after an approval, in order (the start of each numbered item). */
export const SYNC_SECTION = '## 承認の日の移しと途中の替え';
export const SYNC_STEPS: ReadonlyArray<string> = [
  '1. 承認された表のとおり Issue を移す（`gh issue edit <N> --milestone "<名前>"`',
  '2. 今の Sprint が替わるなら `.commandmate/flow.yaml` の `milestone.current` を替える',
  '3. #4461 に変更をコメントで残す',
  '4. `node scripts/orchestrate/milestone-check.mjs check` が exit 0',
];

/** The lines of one `## ` section (heading excluded); empty when the heading is missing. */
export function sectionLines(text: string, heading: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === heading || l.startsWith(`${heading}（`));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^## /.test(l)) break;
    out.push(l);
  }
  return out;
}

/** T1: `<when>: …` for each row whose bullet is not in its section. */
export function missingTimePoints(rows: ReadonlyArray<Row>, read: (doc: string) => string): string[] {
  return rows
    .filter((r) => !sectionLines(read(r.doc), r.section).some((l) => l.startsWith(r.line)))
    .map((r) => `${r.when}: not in ${r.doc} ${r.section}`);
}

/** T2: `<when>: [files]` for each row whose bullet is not in exactly its own document. */
export function copiedTimePoints(rows: ReadonlyArray<Row>, docs: ReadonlyArray<{ path: string; text: string }>): string[] {
  const problems: string[] = [];
  for (const r of rows) {
    const where = docs.filter((d) => d.text.split('\n').some((l) => l.startsWith(r.line))).map((d) => d.path);
    if (where.length !== 1 || where[0] !== r.doc) problems.push(`${r.when}: [${where.join(', ')}] (owner ${r.doc})`);
  }
  return problems;
}

/** T3: the numbered items of the section, compared with the steps in order. */
export function syncStepProblems(text: string): string[] {
  const items = sectionLines(text, SYNC_SECTION).filter((l) => /^\d+\. /.test(l));
  const problems: string[] = [];
  if (items.length !== SYNC_STEPS.length) problems.push(`${items.length} numbered items, expected ${SYNC_STEPS.length}`);
  SYNC_STEPS.forEach((s, i) => {
    if (!items[i]?.startsWith(s)) problems.push(`step ${i + 1}: ${items[i] ?? '(missing)'}`);
  });
  return problems;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function ruleDocs(): Array<{ path: string; text: string }> {
  const top = fs.readdirSync(path.join(REPO_ROOT, DOCS_DIR)).filter((f) => f.endsWith('.md')).map((f) => `${DOCS_DIR}/${f}`);
  const roles = fs.readdirSync(path.join(REPO_ROOT, DOCS_DIR, 'roles')).filter((f) => f.endsWith('.md')).map((f) => `${DOCS_DIR}/roles/${f}`);
  return [...top, ...roles, BODY].map((rel) => ({ path: rel, text: read(rel) }));
}

describe('milestone doc (#4642 PR-2): controls', () => {
  const canon = `# M\n\n## 検査を流す時点\n\n${TIME_POINTS.filter((r) => r.doc === CANON).map((r) => r.line).join('\n')}\n\n## 次\n- x\n`;
  const role = `# PM\n\n## 報告\n${TIME_POINTS.filter((r) => r.doc === PM_ROLE).map((r) => r.line).join('\n')}\n`;
  const files: Record<string, string> = { [CANON]: canon, [PM_ROLE]: role };

  it('passes a document that has every line', () => {
    expect(missingTimePoints(TIME_POINTS, (d) => files[d])).toEqual([]);
  });

  it('fails when one time point is removed', () => {
    const cut = canon.replace(`${TIME_POINTS[2].line}\n`, '');
    expect(missingTimePoints(TIME_POINTS, (d) => (d === CANON ? cut : files[d]))).toEqual([`PR のマージの後: not in ${CANON} ## 検査を流す時点`]);
  });

  it('fails when the line sits in another section', () => {
    const moved = canon.replace(`${TIME_POINTS[2].line}\n`, '').replace('- x\n', `- x\n${TIME_POINTS[2].line}\n`);
    expect(missingTimePoints(TIME_POINTS, (d) => (d === CANON ? moved : files[d]))).toHaveLength(1);
  });

  it('fails when a time point is copied into a second document', () => {
    const docs = [
      { path: CANON, text: canon },
      { path: PM_ROLE, text: role },
      { path: 'docs/orchestrate/team.md', text: `${TIME_POINTS[1].line}\n` },
    ];
    expect(copiedTimePoints(TIME_POINTS, docs)).toEqual([`定期の見張り: [${CANON}, docs/orchestrate/team.md] (owner ${CANON})`]);
  });

  it('fails when the sync steps lose one or change order', () => {
    const ok = `${SYNC_SECTION}\n\n${SYNC_STEPS.map((s) => `${s} …`).join('\n')}\n`;
    expect(syncStepProblems(ok)).toEqual([]);
    const swapped = `${SYNC_SECTION}\n\n${[SYNC_STEPS[1], SYNC_STEPS[0], SYNC_STEPS[2], SYNC_STEPS[3]].join('\n')}\n`;
    expect(syncStepProblems(swapped)).toHaveLength(2);
    expect(syncStepProblems(`${SYNC_SECTION}\n\n${SYNC_STEPS.slice(0, 3).join('\n')}\n`)).toContain('3 numbered items, expected 4');
  });
});

describe('milestone doc (#4642 PR-2): this repository', () => {
  it('has the table (anti-vacuity)', () => {
    expect(new Set(TIME_POINTS.map((r) => r.when.replace(/（.*/, ''))).size).toBe(5);
  });

  it('T1: every time point is in its decided document and section', () => {
    expect(missingTimePoints(TIME_POINTS, read)).toEqual([]);
  });

  it('T2: every time point is written in one document only', () => {
    expect(copiedTimePoints(TIME_POINTS, ruleDocs())).toEqual([]);
  });

  it('T3: the steps after an approval are the canon’s numbered items, in order', () => {
    expect(syncStepProblems(read(CANON))).toEqual([]);
  });
});
