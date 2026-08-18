/**
 * `docs/design/public-messaging.md` is the single source for public wording, and
 * `docs/concept.md` / `docs/en/concept.md` are the canonical Vision/Mission text
 * (Issue #1808, Epic #1807 Step A). Six later issues (#1810–#1815) copy from
 * these files, so a drift here splits every public surface at once.
 *
 * What this file pins, and why each pin is cheap to break by hand:
 *
 * 1. **The banned-term list lives in one place.** The list is written for humans
 *    in public-messaging.md and consumed by machine here. If the two were
 *    maintained separately, deleting a row from the doc would silently disarm
 *    the guard — so the two are asserted equal, and the doc's own rows are what
 *    the concept files are then scanned for.
 * 2. **The definition sentence is verbatim in three files.** It is the one
 *    sentence every surface repeats; paraphrasing it is exactly the failure the
 *    single source exists to prevent.
 * 3. **The two concept files stay structurally parallel.** Equal `##` counts is
 *    the cheapest check that a section was not added to one language only.
 * 4. **Claims that name code are asserted against the code**, not restated:
 *    `VerifyExitCode` for `exit 0 / 20 / 21` and `CLI_TOOL_IDS` for the agent
 *    list. Adding a CLI without updating the messaging is the realistic drift.
 * 5. **Demo telops fit the recorder that will render them.** The limits are read
 *    out of `storyboard.ts` rather than duplicated, so tightening the recorder
 *    fails the doc instead of failing the render months later.
 * 6. **No table cell is left blank.** The brief was "every item filled in both
 *    ja and en"; a blank cell is how a later issue ends up inventing wording.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VerifyExitCode } from '@/cli/types';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const MESSAGING_DOC = 'docs/design/public-messaging.md';
const CONCEPT_JA = 'docs/concept.md';
const CONCEPT_EN = 'docs/en/concept.md';
const STORYBOARD = '.claude/skills/demo-video/scripts/storyboard.ts';

/**
 * The banned terms, as this test knows them. The list in the doc must match
 * exactly — that equality is the whole point of asserting it (see the header).
 */
const BANNED_TERMS = [
  'control plane',
  'コントロールプレーン',
  'Orchestrate your agent CLIs, not your terminal tabs',
  'Vibe Coder',
  'Remote Control',
  'Happy Coder',
  'claude-squad',
  'Omnara',
];

/** The hero and the definition, verbatim. Changing these is a deliberate act. */
const HERO_H1_EN = 'From vibe coding to Vibe Engineering.';
const HERO_H1_JA = 'vibe coding から、Vibe Engineering へ。';
const DEFINITION_EN =
  'Vibe Engineering — the AI does the building; the system, not your expertise, guarantees the engineering.';
const DEFINITION_JA =
  'Vibe Engineering — 作るのは AI。エンジニアリングを保証するのは、あなたの専門知識ではなく仕組み。';

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/** Markdown emphasis carries no meaning here; strip it so prose matches survive it. */
function readProse(relative: string): string {
  return readDoc(relative).replace(/[`*]/g, '');
}

/** Cells of one markdown table row, or null when the line is not a row. */
function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|');
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

/** Every table row in the document, separators dropped. */
function tableRows(content: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = [];
  content.split('\n').forEach((line, index) => {
    const cells = tableCells(line);
    if (!cells || isSeparatorRow(cells)) return;
    rows.push({ line: index + 1, cells: cells.map((cell) => cell.trim()) });
  });
  return rows;
}

describe('public messaging is a single source', () => {
  const messaging = readDoc(MESSAGING_DOC);

  it('publishes the banned-term list this test enforces', () => {
    const start = messaging.indexOf('<!-- banned-terms:start -->');
    const end = messaging.indexOf('<!-- banned-terms:end -->');
    expect(start, `${MESSAGING_DOC} must delimit the banned-term table`).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const documented = tableRows(messaging.slice(start, end))
      .map((row) => row.cells[0])
      .filter((cell) => cell.startsWith('`') && cell.endsWith('`'))
      .map((cell) => cell.slice(1, -1));

    // Equality, not containment: a row removed from the doc must fail here
    // rather than quietly leaving the term enforced by this file alone.
    expect([...documented].sort()).toEqual([...BANNED_TERMS].sort());
  });

  it('states the hero and the definition in both languages', () => {
    const prose = readProse(MESSAGING_DOC);
    for (const line of [HERO_H1_EN, HERO_H1_JA, DEFINITION_EN, DEFINITION_JA]) {
      expect(prose, `${MESSAGING_DOC} must carry: ${line}`).toContain(line);
    }
  });

  it('leaves no table cell blank, so every item is filled in ja and en', () => {
    const blank = tableRows(messaging).filter((row) => row.cells.some((cell) => cell === ''));
    expect(
      blank.map((row) => `${MESSAGING_DOC}:${row.line}`),
      'every messaging item must be decided; a blank cell invites a later issue to invent wording'
    ).toEqual([]);
  });

  it('names the verification exit codes the CLI actually returns', () => {
    for (const code of [
      VerifyExitCode.SUCCESS,
      VerifyExitCode.VERIFY_FAILED,
      VerifyExitCode.NOT_STARTED,
    ]) {
      expect(messaging, `exit ${code} must appear in ${MESSAGING_DOC}`).toMatch(
        new RegExp(`(?<![0-9])${code}(?![0-9])`)
      );
    }
  });

  it('names every agent CLI the product supports', () => {
    const withoutTable = messaging.toLowerCase();
    for (const id of CLI_TOOL_IDS) {
      // The messaging spells the CLIs out in product names on the en/ja rows and
      // in ids on the evidence table, so the id itself is the stable token.
      expect(withoutTable, `${id} must be reflected in ${MESSAGING_DOC}`).toContain(id);
    }
  });
});

describe('concept docs are the canonical Vision/Mission text', () => {
  const ja = readProse(CONCEPT_JA);
  const en = readProse(CONCEPT_EN);

  it('carries the definition in its own language', () => {
    expect(ja, `${CONCEPT_JA} must carry the ja definition verbatim`).toContain(DEFINITION_JA);
    expect(en, `${CONCEPT_EN} must carry the en definition verbatim`).toContain(DEFINITION_EN);
  });

  it('carries the hero line', () => {
    expect(ja).toContain(HERO_H1_EN);
    expect(ja).toContain(HERO_H1_JA);
    expect(en).toContain(HERO_H1_EN);
  });

  it.each([
    [CONCEPT_JA, ja],
    [CONCEPT_EN, en],
  ])('%s uses none of the banned terms', (relative, prose) => {
    const lowered = prose.toLowerCase();
    const found = BANNED_TERMS.filter((term) => lowered.includes(term.toLowerCase()));
    expect(found, `${relative} still uses retired wording`).toEqual([]);
  });

  it('keeps the same number of ## sections in both languages', () => {
    const count = (content: string) => content.split('\n').filter((l) => /^## /.test(l)).length;
    expect(count(ja)).toBeGreaterThan(0);
    expect(count(en)).toBe(count(ja));
  });

  it('draws the loop without an image', () => {
    for (const [relative, content] of [
      [CONCEPT_JA, readDoc(CONCEPT_JA)],
      [CONCEPT_EN, readDoc(CONCEPT_EN)],
    ] as const) {
      expect(content, `${relative} must draw the loop inline`).toContain('```mermaid');
      expect(content, `${relative} must not illustrate the loop with an image`).not.toMatch(
        /!\[[^\]]*\]\(/
      );
    }
  });

  it('maps each implementation item to a CLI tool id that exists', () => {
    for (const id of CLI_TOOL_IDS) {
      expect(ja, `${CONCEPT_JA} must list ${id}`).toContain(id);
      expect(en, `${CONCEPT_EN} must list ${id}`).toContain(id);
    }
  });
});

describe('demo telops fit the storyboard validator', () => {
  const storyboard = readDoc(STORYBOARD);

  /** Read the limits out of the recorder rather than restating them here. */
  function limitsFor(type: 'record' | 'card'): { jaChars: number; enWords: number } {
    const match = storyboard.match(
      new RegExp(`${type}:\\s*\\{\\s*jaChars:\\s*(\\d+),\\s*enWords:\\s*(\\d+)\\s*\\}`)
    );
    expect(match, `${STORYBOARD} must declare the ${type} telop limits`).not.toBeNull();
    return { jaChars: Number(match![1]), enWords: Number(match![2]) };
  }

  /** Same counting rules as storyboard.ts: code points for ja, whitespace runs for en. */
  const jaChars = (text: string) => [...text].length;
  const enWords = (text: string) => (text.trim() === '' ? 0 : text.trim().split(/\s+/).length);

  const telopRows = tableRows(readDoc(MESSAGING_DOC)).filter(
    (row) => row.cells.length === 4 && /^(record|card)$/.test(row.cells[1])
  );

  it('lists a telop for every demo and scene type', () => {
    expect(telopRows.length).toBe(8);
  });

  it.each([
    ['record' as const],
    ['card' as const],
  ])('%s telops stay inside the declared limits', (type) => {
    const limits = limitsFor(type);
    const overLong = telopRows
      .filter((row) => row.cells[1] === type)
      .filter(
        (row) => jaChars(row.cells[2]) > limits.jaChars || enWords(row.cells[3]) > limits.enWords
      )
      .map((row) => `${MESSAGING_DOC}:${row.line}`);
    expect(overLong).toEqual([]);
  });
});
