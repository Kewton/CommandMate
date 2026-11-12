/**
 * What a hand-off fixed stays fixed (Issue #4227 G-PR2, design `mem-ui-4227.md` §4.3・§7.3):
 * the v71 migration has the three triggers (a proposal's immutable columns, a request's
 * pinned columns, `end_forced` never 1 → 0), and `handoff-db.ts` never SETs a pinned or
 * immutable column and writes `end_forced` as `MAX(end_forced, ?)` only.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const MIGRATION = readFileSync(path.join(process.cwd(), 'src/lib/db/migrations/v71-mem-handoff.ts'), 'utf8');
const STORE = readFileSync(path.join(process.cwd(), 'src/lib/db/handoff-db.ts'), 'utf8');

const PINNED = ['repository_id', 'branch', 'detached', 'target_worktree_id', 'target_worktree_incarnation', 'instance_id', 'instance_incarnation', 'instance_on_roster', 'boundary_id'];
const IMMUTABLE = ['request_id', 'op', 'item_id', 'kind', 'payload', 'author_instance_id', 'author_incarnation'];

/** The SET lists of the UPDATEs of a source (template literals and strings alike). */
export function setLists(source: string): string[] {
  return [...source.matchAll(/UPDATE\s+mem_handoff_\w+\s+SET\s+([\s\S]*?)\s+WHERE/g)].map((match) => match[1]);
}
export function setViolations(source: string): string[] {
  const out: string[] = [];
  for (const list of setLists(source)) {
    for (const column of [...PINNED, ...IMMUTABLE]) if (new RegExp(`(^|[\\s,])${column}\\s*=`).test(list)) out.push(`sets ${column}`);
    if (/end_forced\s*=/.test(list) && !/end_forced\s*=\s*MAX\(end_forced,\s*\?\)/.test(list)) out.push('writes end_forced without MAX');
  }
  // The generic change's column map names no pinned column either.
  const map = /const REQUEST_COLUMNS[\s\S]*?};/.exec(source)?.[0] ?? '';
  for (const column of [...PINNED, 'end_forced']) if (new RegExp(`'${column}'`).test(map)) out.push(`maps ${column}`);
  return out;
}

describe('the hand-off’s fixed columns stay fixed (Issue #4227)', () => {
  it('v71 has the three triggers', () => {
    for (const name of ['mem_handoff_proposals_immutable', 'mem_handoff_requests_pinned', 'mem_handoff_requests_forced_sticky']) {
      expect(MIGRATION).toContain(`CREATE TRIGGER ${name}`);
    }
    expect(MIGRATION).toMatch(/WHEN OLD\.end_forced = 1 AND NEW\.end_forced = 0/);
  });

  it('handoff-db never sets a pinned or immutable column, and end_forced only through MAX', () => {
    expect(setLists(STORE).length).toBeGreaterThanOrEqual(4);
    expect(setViolations(STORE)).toEqual([]);
  });

  it('(positive control) a SET of a pinned column, a plain end_forced and a mapped pin are found', () => {
    expect(setViolations("db.prepare('UPDATE mem_handoff_requests SET boundary_id = ? WHERE id = ?')")).toEqual(['sets boundary_id']);
    expect(setViolations("db.prepare('UPDATE mem_handoff_requests SET end_forced = ? WHERE id = ?')")).toEqual(['writes end_forced without MAX']);
    expect(setViolations("const REQUEST_COLUMNS = { branch: 'branch' };")).toEqual(['maps branch']);
    expect(setViolations("db.prepare('UPDATE mem_handoff_requests SET end_forced = MAX(end_forced, ?) WHERE id = ?')")).toEqual([]);
  });
});
