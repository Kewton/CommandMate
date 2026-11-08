/**
 * close_when: grammar, the kind × type table and the stored form (Issue #4221, design §2),
 * pinned against the fixture #4222 reads (`tests/fixtures/mem/close-when-v1.json`), and the
 * worktree condition decided by the incarnation, not the id (2nd review 5).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import path from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { deleteWorktreesByIds, migrateWorktreeIdPreservingChildren } from '@/lib/db/worktree-db';
import {
  CLOSE_WHEN_ALLOWED,
  CLOSE_WHEN_DEFAULTS,
  CLOSE_WHEN_TYPES,
  finalizeCloseWhen,
  parseCloseWhen,
  parseOriginUrl,
  readStoredCloseWhen,
} from '@/lib/mem/close-when';
import { getOrCreateWorktreeIncarnation, worktreeIncarnationAlive } from '@/lib/mem/incarnation';
import { MEM_KINDS, type MemCloseWhenType, type MemKind } from '@/types/mem';

interface Fixture {
  schema: number;
  types: MemCloseWhenType[];
  allowed: Record<MemKind, Record<MemCloseWhenType, boolean>>;
  defaults: Record<MemKind, string | null>;
  inputs: Record<MemCloseWhenType, string>;
  stored: Record<MemCloseWhenType, Record<string, unknown>>;
  binding: { origin: string; tip: string; repositoryId: string; worktreeId: string; worktreeIncarnation: string };
  invalid: string[];
  worktreeLifecycle: Array<{ event: string; storedIncarnationAlive: boolean; expected: 'met' | 'not-met' }>;
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(path.join(process.cwd(), 'tests/fixtures/mem/close-when-v1.json'), 'utf-8')
) as Fixture;

const binding = {
  origin: parseOriginUrl(FIXTURE.binding.origin),
  tip: FIXTURE.binding.tip,
  repositoryId: FIXTURE.binding.repositoryId,
  worktreeIncarnation: (id: string) => (id === FIXTURE.binding.worktreeId ? FIXTURE.binding.worktreeIncarnation : null),
  sessionGeneration: null,
};

const kindTaking = (type: MemCloseWhenType): MemKind => MEM_KINDS.find((kind) => FIXTURE.allowed[kind][type])!;

describe('close_when (Issue #4221)', () => {
  it('holds the same kind × type table as the fixture #4222 reads', () => {
    expect(FIXTURE.schema).toBe(1);
    expect([...CLOSE_WHEN_TYPES]).toEqual(FIXTURE.types);
    for (const kind of MEM_KINDS) {
      for (const type of FIXTURE.types) {
        expect([kind, type, CLOSE_WHEN_ALLOWED[kind].has(type)]).toEqual([kind, type, FIXTURE.allowed[kind][type]]);
      }
      expect(CLOSE_WHEN_DEFAULTS[kind]).toBe(FIXTURE.defaults[kind]);
    }
  });

  it('refuses every × of the table and takes every ○ (R10)', () => {
    for (const kind of MEM_KINDS) {
      for (const type of FIXTURE.types) {
        const parsed = parseCloseWhen(kind, FIXTURE.inputs[type].replace('WORKTREE_ID', 'wt-1'));
        expect([kind, type, parsed.ok]).toEqual([kind, type, FIXTURE.allowed[kind][type]]);
      }
    }
    // The one the first version allowed to waiting / next.
    expect(parseCloseWhen('waiting', 'replaced').ok).toBe(false);
    expect(parseCloseWhen('next', 'replaced').ok).toBe(false);
  });

  it('fills the default per kind, and requires one where there is none', () => {
    expect(parseCloseWhen('now', undefined)).toEqual({ ok: true, draft: { type: 'replaced' } });
    expect(parseCloseWhen('note', undefined)).toEqual({ ok: true, draft: { type: 'manual' } });
    expect(parseCloseWhen('decision', undefined)).toEqual({ ok: true, draft: { type: 'promoted' } });
    for (const kind of ['waiting', 'next', 'external'] as const) {
      expect(parseCloseWhen(kind, undefined).ok).toBe(false);
    }
    const decision = parseCloseWhen('decision', undefined);
    expect(decision.ok && finalizeCloseWhen(decision.draft, binding)).toEqual({ ok: true, value: null });
  });

  it('stores each type as the fixture says, and reads the stored value back (T-COND)', () => {
    for (const type of FIXTURE.types) {
      const parsed = parseCloseWhen(kindTaking(type), FIXTURE.inputs[type].replace('WORKTREE_ID', FIXTURE.binding.worktreeId));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const bound = finalizeCloseWhen(parsed.draft, binding);
      expect(bound).toEqual({ ok: true, value: FIXTURE.stored[type] });
      expect(readStoredCloseWhen(JSON.stringify(FIXTURE.stored[type]))).toEqual(FIXTURE.stored[type]);
    }
  });

  it('refuses unknown types, a time without an offset, a PID, repeated keys and extra text', () => {
    for (const raw of FIXTURE.invalid) {
      expect([raw, parseCloseWhen('next', raw).ok]).toEqual([raw, false]);
    }
    expect(parseCloseWhen('next', `at:2026-11-09T09:00+09:00${'x'.repeat(300)}`).ok).toBe(false);
  });

  it('refuses `#N` when origin cannot be read, rather than guessing', () => {
    const parsed = parseCloseWhen('waiting', 'issue:#1');
    expect(parsed.ok && finalizeCloseWhen(parsed.draft, { ...binding, origin: null })).toEqual({ ok: false, reason: 'no_origin' });
    // A named target needs no origin (control).
    const named = parseCloseWhen('waiting', 'issue:github.com/a/b#1');
    expect(named.ok && finalizeCloseWhen(named.draft, { ...binding, origin: null }).ok).toBe(true);
  });

  it('refuses a merged-branch condition without the tip, and a worktree that does not exist', () => {
    const branch = parseCloseWhen('next', 'branch:x?merged=develop');
    expect(branch.ok && finalizeCloseWhen(branch.draft, { ...binding, tip: null })).toEqual({ ok: false, reason: 'no_tip' });
    const wt = parseCloseWhen('next', 'worktree:missing');
    expect(wt.ok && finalizeCloseWhen(wt.draft, binding)).toEqual({ ok: false, reason: 'no_worktree' });
  });

  it('reads an unknown schema as unknown (null), which never closes anything', () => {
    expect(readStoredCloseWhen('{"schema":2,"type":"manual"}')).toBeNull();
    expect(readStoredCloseWhen('not json')).toBeNull();
  });
});

describe('the worktree condition follows the incarnation (2nd review 5)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES ('wt-a', 'a', '/tmp/cm-4221/a', '/tmp/cm-4221', 'r')`
    ).run();
  });
  afterEach(() => db.close());

  const expectFor = (event: string) => FIXTURE.worktreeLifecycle.find((entry) => entry.event === event)!;

  it('a rename keeps the stored incarnation alive: not met', () => {
    const stored = getOrCreateWorktreeIncarnation(db, 'wt-a');
    db.transaction(() => migrateWorktreeIdPreservingChildren(db, 'wt-a', 'wt-b'))();
    const alive = worktreeIncarnationAlive(db, stored);
    expect(alive).toBe(expectFor('rename').storedIncarnationAlive);
    expect(expectFor('rename').expected).toBe('not-met');
  });

  it('a delete and a re-creation at the same id make a new incarnation: met', () => {
    const stored = getOrCreateWorktreeIncarnation(db, 'wt-a');
    deleteWorktreesByIds(db, ['wt-a']);
    expect(worktreeIncarnationAlive(db, stored)).toBe(expectFor('delete').storedIncarnationAlive);
    db.prepare(
      `INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES ('wt-a', 'a', '/tmp/cm-4221/a', '/tmp/cm-4221', 'r')`
    ).run();
    const again = getOrCreateWorktreeIncarnation(db, 'wt-a');
    expect(again).not.toBe(stored);
    expect(worktreeIncarnationAlive(db, stored)).toBe(expectFor('delete-and-recreate').storedIncarnationAlive);
    expect(expectFor('delete-and-recreate').expected).toBe('met');
  });
});
