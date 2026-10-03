/**
 * `docs/design/public-messaging.md` is a reference of facts and of what the
 * public surfaces do not say — not a source of wording to copy. Issue #3057
 * retired the #1808 rule that every surface copies its sentences verbatim from
 * that file and that tests pin the copies; what is pinned here is only what a
 * surface must not get wrong, whatever words it chooses.
 *
 * 1. **The banned-term list lives in one place.** The list is written for humans
 *    in public-messaging.md and consumed by machine here. If the two were
 *    maintained separately, deleting a row from the doc would silently disarm
 *    the guard — so the two are asserted equal, and the doc's own rows are what
 *    the concept files and the READMEs are then scanned for. Since #3057 the
 *    list holds competitor product names only.
 * 2. **Claims that name code are asserted against the code**, not restated:
 *    `VerifyExitCode` for `exit 0 / 20 / 21` and `CLI_TOOL_IDS` for the agent
 *    list. Adding a CLI without updating the reference is the realistic drift.
 * 3. **No table cell is left blank**, so no fact in the reference is half-stated.
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
const README_EN = 'README.md';
const README_JA = 'docs/ja/README.md';

/**
 * The banned terms, as this test knows them. The list in the doc must match
 * exactly — that equality is the whole point of asserting it (see the header).
 * #3057 cut it to competitor product names; the old-axis wording it used to
 * carry is left to each surface.
 */
const BANNED_TERMS = [
  'Remote Control',
  'Happy Coder',
  'claude-squad',
  'Omnara',
  // Issue #2549 (Epic #2548's competitor survey). Matched as case-insensitive
  // substrings like every other row, so `Lanes` also catches "planes".
  'Orca',
  'Herdr',
  'Lanes',
];

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

describe('the public messaging reference', () => {
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

  it('leaves no table cell blank, so every item is filled in ja and en', () => {
    const blank = tableRows(messaging).filter((row) => row.cells.some((cell) => cell === ''));
    expect(
      blank.map((row) => `${MESSAGING_DOC}:${row.line}`),
      'every fact in the reference must be stated in full'
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

describe('the concept docs stay true to the reference', () => {
  const ja = readProse(CONCEPT_JA);
  const en = readProse(CONCEPT_EN);

  it.each([
    [CONCEPT_JA, ja],
    [CONCEPT_EN, en],
  ])('%s uses none of the banned terms', (relative, prose) => {
    const lowered = prose.toLowerCase();
    const found = BANNED_TERMS.filter((term) => lowered.includes(term.toLowerCase()));
    expect(found, `${relative} still uses retired wording`).toEqual([]);
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

describe('the READMEs stay true to the reference', () => {
  const en = readProse(README_EN);
  const ja = readProse(README_JA);

  it.each([
    [README_EN, en],
    [README_JA, ja],
  ])('%s uses none of the banned terms', (relative, prose) => {
    const lowered = prose.toLowerCase();
    const found = BANNED_TERMS.filter((term) => lowered.includes(term.toLowerCase()));
    expect(found, `${relative} still uses retired wording`).toEqual([]);
  });
});
