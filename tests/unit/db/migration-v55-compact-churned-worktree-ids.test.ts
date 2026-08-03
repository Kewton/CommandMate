/**
 * Issue #1658: migration v55 folds the IDs that ran away back onto their
 * directory name.
 *
 * With one git repository registered under two scan roots, every sync re-derived
 * each worktree's ID against a taken set that contained its own current ID and
 * its own aliases, so `deriveWorktreeId` answered one rung further up the digest
 * ladder — 8 hex digits per sync, up to 81 characters in production. The sync
 * fix stops the growth by *keeping* whatever ID a path already has, which means
 * it also freezes the inflated ones; this migration is what collapses them, and
 * what frees the rungs the minter would otherwise reserve forever.
 *
 * What it must get right:
 *
 * - the ID being vacated stays answerable (URLs and `commandmate send <id>` were
 *   minted while the churn was running);
 * - the intermediate rungs are dropped — they all point at the same worktree,
 *   none outlived the second it took the next sync to replace it;
 * - a genuine former name (`…-develop`, `…-detached-1c64d87f`, anything from the
 *   branch-derived era) is NOT a rung and must survive;
 * - an ID another live worktree holds is never taken.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import {
  CURRENT_SCHEMA_VERSION,
  runMigrations,
  rollbackMigrations,
} from '@/lib/db/migrations/runner';
import { migrations as allMigrations } from '@/lib/db/migrations';
import { planWorktreeIdCompaction } from '@/lib/db/migrations/v55-compact-churned-worktree-ids';
import { resolveWorktreeIdWithAlias } from '@/lib/db/worktree-alias-db';

const BON0_PATH = '/private/tmp/commandagent-bon0-run';
const BON0_BASE = 'commandagent-bon0-run';
const DEVELOP_PATH = '/repos/CommandAgent-develop';
const DEVELOP_BASE = 'commandagent-develop';

/** The rung `deriveWorktreeId` produces after `hexLength/8` collisions. */
function rung(worktreePath: string, base: string, hexLength: number): string {
  const digest = createHash('sha256').update(worktreePath).digest('hex');
  return `${base}-${digest.slice(0, hexLength)}`;
}

/** Every rung from 8 hex up to and including `hexLength`. */
function ladder(worktreePath: string, base: string, hexLength: number): string[] {
  const rungs: string[] = [];
  for (let length = 8; length <= hexLength; length += 8) {
    rungs.push(rung(worktreePath, base, length));
  }
  return rungs;
}

let v54Snapshot: Buffer | null = null;

/** A database with everything up to and including v54 applied. */
function makeV54Database(): Database.Database {
  if (!v54Snapshot) {
    const template = new Database(':memory:');
    runMigrations(
      template,
      allMigrations.filter((migration) => migration.version <= 54)
    );
    v54Snapshot = template.serialize();
    template.close();
  }
  return new Database(v54Snapshot);
}

function insertWorktree(db: Database.Database, id: string, worktreePath: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, branch, cli_tool_id)
     VALUES (?, 'main', ?, '/repos/CommandAgent', 'CommandAgent', 'main', 'claude')`
  ).run(id, worktreePath);
}

function insertAlias(
  db: Database.Database,
  oldId: string,
  worktreeId: string,
  createdAt = Date.now()
): void {
  db.prepare(
    'INSERT INTO worktree_aliases (old_id, worktree_id, created_at) VALUES (?, ?, ?)'
  ).run(oldId, worktreeId, createdAt);
}

function applyV55(db: Database.Database): void {
  runMigrations(
    db,
    allMigrations.filter((migration) => migration.version === 55)
  );
}

function worktreeIds(db: Database.Database): string[] {
  return (
    db.prepare('SELECT id FROM worktrees ORDER BY id').all() as Array<{ id: string }>
  ).map((row) => row.id);
}

function aliasesOf(db: Database.Database, worktreeId: string): string[] {
  return (
    db
      .prepare('SELECT old_id FROM worktree_aliases WHERE worktree_id = ? ORDER BY old_id')
      .all(worktreeId) as Array<{ old_id: string }>
  ).map((row) => row.old_id);
}

describe('migration v55: compact churned worktree IDs', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeV54Database();
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Planning rules (pure)
  // -------------------------------------------------------------------------

  describe('planWorktreeIdCompaction', () => {
    it('folds a churned ID back onto the basename', () => {
      const churned = rung(BON0_PATH, BON0_BASE, 48);
      const plan = planWorktreeIdCompaction(
        [{ id: churned, path: BON0_PATH }],
        ladder(BON0_PATH, BON0_BASE, 40)
          .concat(BON0_BASE)
          .map((oldId) => ({ oldId, worktreeId: churned }))
      );

      expect(plan.renames).toEqual([{ oldId: churned, newId: BON0_BASE }]);
      // Every rung above the destination goes; the basename itself is the
      // destination, so it is not in the drop list (the rename deletes it as a
      // now-live ID).
      expect(plan.droppedAliasIds.sort()).toEqual(ladder(BON0_PATH, BON0_BASE, 40).sort());
    });

    it('keeps a genuine former name while dropping the rungs', () => {
      const churned = rung(DEVELOP_PATH, DEVELOP_BASE, 24);
      const plan = planWorktreeIdCompaction(
        [{ id: churned, path: DEVELOP_PATH }],
        [
          ...ladder(DEVELOP_PATH, DEVELOP_BASE, 16),
          DEVELOP_BASE,
          'commandagent-develop-develop',
          'commandagent-develop-detached-1c64d87f',
        ].map((oldId) => ({ oldId, worktreeId: churned }))
      );

      expect(plan.renames).toEqual([{ oldId: churned, newId: DEVELOP_BASE }]);
      expect(plan.droppedAliasIds).not.toContain('commandagent-develop-develop');
      expect(plan.droppedAliasIds).not.toContain('commandagent-develop-detached-1c64d87f');
      expect(plan.droppedAliasIds.sort()).toEqual(ladder(DEVELOP_PATH, DEVELOP_BASE, 16).sort());
    });

    it('leaves a healthy row alone', () => {
      expect(planWorktreeIdCompaction([{ id: BON0_BASE, path: BON0_PATH }], [])).toEqual({
        renames: [],
        droppedAliasIds: [],
      });
    });

    it('never takes an ID another live worktree holds', () => {
      // `/repos/beta/main` cannot have `main`; the best it can do is the first
      // rung, which is still shorter than the third one it is sitting on.
      const churned = rung('/repos/beta/main', 'main', 24);
      const plan = planWorktreeIdCompaction(
        [
          { id: 'main', path: '/repos/alpha/main' },
          { id: churned, path: '/repos/beta/main' },
        ],
        ladder('/repos/beta/main', 'main', 16).map((oldId) => ({ oldId, worktreeId: churned }))
      );

      expect(plan.renames).toEqual([
        { oldId: churned, newId: rung('/repos/beta/main', 'main', 8) },
      ]);
      // Only the rung above the one it lands on is abandoned.
      expect(plan.droppedAliasIds).toEqual([rung('/repos/beta/main', 'main', 16)]);
    });

    it('never takes an ID another worktree still answers as an alias', () => {
      const churned = rung(BON0_PATH, BON0_BASE, 24);
      const plan = planWorktreeIdCompaction(
        [
          { id: 'other', path: '/repos/other' },
          { id: churned, path: BON0_PATH },
        ],
        // The basename is a former name of a DIFFERENT worktree.
        [{ oldId: BON0_BASE, worktreeId: 'other' }]
      );

      expect(plan.renames).toEqual([
        { oldId: churned, newId: rung(BON0_PATH, BON0_BASE, 8) },
      ]);
      expect(plan.droppedAliasIds).toEqual([]);
    });

    it('does not move a row when nothing shorter is available', () => {
      // Already on the first rung and the basename belongs to someone else.
      const settled = rung('/repos/beta/main', 'main', 8);
      expect(
        planWorktreeIdCompaction(
          [
            { id: 'main', path: '/repos/alpha/main' },
            { id: settled, path: '/repos/beta/main' },
          ],
          []
        )
      ).toEqual({ renames: [], droppedAliasIds: [] });
    });

    it('is deterministic', () => {
      const rows = [
        { id: rung(BON0_PATH, BON0_BASE, 32), path: BON0_PATH },
        { id: rung(DEVELOP_PATH, DEVELOP_BASE, 16), path: DEVELOP_PATH },
      ];
      expect(planWorktreeIdCompaction(rows, [])).toEqual(planWorktreeIdCompaction(rows, []));
    });
  });

  // -------------------------------------------------------------------------
  // Applied behaviour
  // -------------------------------------------------------------------------

  it('is part of the current schema version', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(55);
    applyV55(db);
    const applied = db.prepare('SELECT name FROM schema_version WHERE version = 55').get() as
      | { name: string }
      | undefined;
    expect(applied?.name).toBe('compact-churned-worktree-ids');
  });

  it('reproduces the production database and collapses it', () => {
    // Six syncs' worth of ladder, exactly as the alias timestamps recorded it.
    const churned = rung(BON0_PATH, BON0_BASE, 48);
    insertWorktree(db, churned, BON0_PATH);
    const rungs = ladder(BON0_PATH, BON0_BASE, 40);
    insertAlias(db, BON0_BASE, churned);
    for (const step of rungs) insertAlias(db, step, churned);

    // History hanging off the inflated ID must come along.
    db.prepare(
      `INSERT INTO chat_messages (worktree_id, role, content, timestamp, cli_tool_id)
       VALUES (?, 'user', 'hello', ?, 'claude')`
    ).run(churned, Date.now());

    applyV55(db);

    expect(worktreeIds(db)).toEqual([BON0_BASE]);
    // The 56-hex ID it was living under is still answerable…
    expect(aliasesOf(db, BON0_BASE)).toEqual([churned]);
    expect(resolveWorktreeIdWithAlias(db, churned)).toBe(BON0_BASE);
    // …and every intermediate rung is gone, freeing those IDs for good.
    for (const step of rungs) {
      expect(resolveWorktreeIdWithAlias(db, step)).toBeNull();
    }
    // The basename resolves because it is the live row again, not via an alias.
    expect(resolveWorktreeIdWithAlias(db, BON0_BASE)).toBe(BON0_BASE);

    const messages = db
      .prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE worktree_id = ?')
      .get(BON0_BASE) as { n: number };
    expect(messages.n).toBe(1);
  });

  it('keeps the genuine former names and drops only the rungs', () => {
    const churned = rung(DEVELOP_PATH, DEVELOP_BASE, 32);
    insertWorktree(db, churned, DEVELOP_PATH);
    insertAlias(db, DEVELOP_BASE, churned);
    for (const step of ladder(DEVELOP_PATH, DEVELOP_BASE, 24)) insertAlias(db, step, churned);
    insertAlias(db, 'commandagent-develop-develop', churned);
    insertAlias(db, 'commandagent-develop-detached-1c64d87f', churned);

    applyV55(db);

    expect(worktreeIds(db)).toEqual([DEVELOP_BASE]);
    expect(aliasesOf(db, DEVELOP_BASE)).toEqual([
      'commandagent-develop-detached-1c64d87f',
      'commandagent-develop-develop',
      churned,
    ]);
    expect(resolveWorktreeIdWithAlias(db, 'commandagent-develop-develop')).toBe(DEVELOP_BASE);
    expect(resolveWorktreeIdWithAlias(db, 'commandagent-develop-detached-1c64d87f')).toBe(
      DEVELOP_BASE
    );
  });

  it('does not disturb a worktree whose short ID belongs to someone else', () => {
    insertWorktree(db, 'main', '/repos/alpha/main');
    const churned = rung('/repos/beta/main', 'main', 24);
    insertWorktree(db, churned, '/repos/beta/main');
    for (const step of ladder('/repos/beta/main', 'main', 16)) insertAlias(db, step, churned);

    applyV55(db);

    expect(worktreeIds(db)).toEqual(['main', rung('/repos/beta/main', 'main', 8)]);
    // alpha's `main` never moved, and beta's bookmarks still land on beta.
    expect(resolveWorktreeIdWithAlias(db, 'main')).toBe('main');
    expect(resolveWorktreeIdWithAlias(db, churned)).toBe(rung('/repos/beta/main', 'main', 8));
  });

  it('is a no-op on a database that never churned', () => {
    insertWorktree(db, BON0_BASE, BON0_PATH);
    insertWorktree(db, DEVELOP_BASE, DEVELOP_PATH);

    applyV55(db);

    expect(worktreeIds(db)).toEqual([BON0_BASE, DEVELOP_BASE]);
    expect(aliasesOf(db, BON0_BASE)).toEqual([]);
    expect(aliasesOf(db, DEVELOP_BASE)).toEqual([]);
  });

  it('handles an empty worktrees table', () => {
    expect(() => applyV55(db)).not.toThrow();
    expect(worktreeIds(db)).toEqual([]);
  });

  it('restores the inflated IDs on rollback', () => {
    const churned = rung(BON0_PATH, BON0_BASE, 48);
    insertWorktree(db, churned, BON0_PATH);
    insertAlias(db, BON0_BASE, churned);
    for (const step of ladder(BON0_PATH, BON0_BASE, 40)) insertAlias(db, step, churned);
    insertAlias(db, 'commandagent-bon0-run-develop', churned);

    applyV55(db);
    expect(worktreeIds(db)).toEqual([BON0_BASE]);

    rollbackMigrations(db, allMigrations, 54);

    expect(worktreeIds(db)).toEqual([churned]);
    // The genuine former name is still attached; the rungs stay dropped (they
    // were the point of the migration).
    expect(aliasesOf(db, churned)).toEqual(['commandagent-bon0-run-develop']);
  });
});
