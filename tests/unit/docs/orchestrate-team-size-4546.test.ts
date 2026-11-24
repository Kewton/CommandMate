/**
 * The byte cap on docs/orchestrate/team.md (Issue #4546).
 *
 * team.md is the rules of the development team, read at the start of every PM
 * and leader session. It grew to 38,831 bytes by absorbing dated measurements,
 * the story behind decisions and procedure detail next to the rules. #4546 PR-2
 * moved those, verbatim, to docs/orchestrate/ (history.md, verify-queue.md and
 * others) and left a one-line pointer in place. The person's decision: team.md
 * stays at 24 KB or less, checked the way CLAUDE.md's size is (count the bytes,
 * fail past the cap, and say in the failure how to fix it).
 *
 * PR-2 は途中の値 28,000 B を置き（移した後は 27,984 B）、PR-4 が受入の 24,000 B へ下げた（PR-4 は規則の
 * 本文を一字一句のまま運用文書へ移し、team.md には元の行の先頭と指し先を残した。orchestrate-moved-verbatim-4546）。
 *
 * The cap is inclusive, so the boundary is pinned at the limit and one byte over.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');

export const TEAM_MD_RELATIVE_PATH = 'docs/orchestrate/team.md';
/** 24,000 bytes: the person's decision for #4546 (team.md at 24 KB or less). */
export const TEAM_MD_SIZE_LIMIT_BYTES = 24000;

export const HOW_TO_FIX =
  'team.md に規則以外（日付つきの実測・経緯・参照の細部）が溜まっている。' +
  '文を書き換えずに docs/orchestrate/ の下（経緯は history.md、重い検証の順番は verify-queue.md など）へ移し、' +
  '元の場所に 1 行の指し先を残す。節番号と見出しは変えない（docs/orchestrate/README.md の置き場の原則）';

/**
 * @returns `{ size, limit, ok }` for team.md under `root`
 * @throws when team.md is missing: a guard that found nothing to measure must not report "under the limit"
 */
export function checkTeamMdSize(root: string): { size: number; limit: number; ok: boolean } {
  const file = path.join(root, TEAM_MD_RELATIVE_PATH);
  if (!fs.existsSync(file)) throw new Error(`${TEAM_MD_RELATIVE_PATH} not found at ${file}`);
  const size = fs.statSync(file).size;
  return { size, limit: TEAM_MD_SIZE_LIMIT_BYTES, ok: size <= TEAM_MD_SIZE_LIMIT_BYTES };
}

/** The failure text: the size, the cap and how to fix it. Empty when within the cap. */
export function sizeProblem(result: { size: number; limit: number; ok: boolean }): string {
  return result.ok
    ? ''
    : `${TEAM_MD_RELATIVE_PATH} は ${result.size} B で、上限 ${result.limit} B を超えている。${HOW_TO_FIX}`;
}

describe('team.md size cap: controls (#4546)', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  const rootWithBytes = (count: number): string => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-team-size-'));
    const file = path.join(root, TEAM_MD_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'a'.repeat(count));
    return root;
  };

  it('is 24000 bytes (the acceptance of #4546)', () => {
    expect(TEAM_MD_SIZE_LIMIT_BYTES).toBe(24000);
  });

  it('negative: a file exactly at the limit passes (the cap is inclusive)', () => {
    const result = checkTeamMdSize(rootWithBytes(TEAM_MD_SIZE_LIMIT_BYTES));
    expect(result).toMatchObject({ size: 24000, ok: true });
    expect(sizeProblem(result)).toBe('');
  });

  it('positive: one byte over the limit fails, and the failure says how to fix it', () => {
    const result = checkTeamMdSize(rootWithBytes(TEAM_MD_SIZE_LIMIT_BYTES + 1));
    expect(result).toMatchObject({ size: 24001, ok: false });
    expect(sizeProblem(result)).toContain('24001 B');
    expect(sizeProblem(result)).toContain('history.md');
  });

  it('counts bytes, not characters (team.md is Japanese)', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-team-size-'));
    const file = path.join(root, TEAM_MD_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'あ'.repeat(8001)); // 8,001 characters, 24,003 bytes
    expect(checkTeamMdSize(root)).toMatchObject({ size: 24003, ok: false });
  });

  it('throws when team.md is missing instead of passing', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-team-size-'));
    expect(() => checkTeamMdSize(root as string)).toThrow(/not found/);
  });
});

describe('team.md size cap: this repository (#4546)', () => {
  it(`docs/orchestrate/team.md is at most ${TEAM_MD_SIZE_LIMIT_BYTES} bytes`, () => {
    expect(sizeProblem(checkTeamMdSize(REPO_ROOT))).toBe('');
  });
});
