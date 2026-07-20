/**
 * Unit tests for migration v46 (skill_installations cascade, Issue #1430).
 *
 * The bug this pins is not "a stale row": a surviving row is invisible (the
 * re-created worktree has a new UUID) yet the payload it describes is still on
 * disk, so the worktree becomes un-installable *and* un-uninstallable from the
 * UI. Both halves are covered here — the constraint that keeps new rows honest,
 * and the sweep that clears what v45 already let accumulate.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  runMigrations,
  rollbackMigrations,
  getCurrentVersion,
  CURRENT_SCHEMA_VERSION,
} from '@/lib/db/db-migrations';
import {
  deleteWorktreesByIds,
  migrateWorktreeIdPreservingChildren,
} from '@/lib/db/worktree-db';

function insertWorktree(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name)
     VALUES (?, ?, ?, '/tmp/cm-1430/repo', 'repo')`
  ).run(id, id, `/tmp/cm-1430/repo/${id}`);
}

function insertInstallation(
  db: Database.Database,
  id: string,
  worktreeId: string,
  skillId = 'demo-skill'
): void {
  db.prepare(
    `INSERT INTO skill_installations (
      id, worktree_id, skill_id, version, install_root, receipt_sha256,
      source_repository, source_ref, source_commit, artifact_sha256,
      effective_risk, operation_id, installed_at, updated_at
    ) VALUES (?, ?, ?, '1.2.3', ?, ?,
      'Kewton/commandmate-skills', 'demo-skill-v1.2.3', ?, ?,
      'low', 'op-1', 1800000000000, 1800000000001)`
  ).run(
    id,
    worktreeId,
    skillId,
    `.agents/skills/${skillId}`,
    'd'.repeat(64),
    'b'.repeat(40),
    'c'.repeat(64)
  );
}

function installationIds(db: Database.Database): string[] {
  return (
    db
      .prepare('SELECT id FROM skill_installations ORDER BY id')
      .all() as Array<{ id: string }>
  ).map((r) => r.id);
}

function worktreeForeignKeys(db: Database.Database): Array<{ table: string; on_delete: string }> {
  return db.pragma('foreign_key_list(skill_installations)') as Array<{
    table: string;
    on_delete: string;
  }>;
}

/** Bring a database up to v45 only — the state an existing install is in. */
function migrateToV45(db: Database.Database): void {
  runMigrations(db);
  rollbackMigrations(db, 45);
}

describe('migration v46: fresh DB end state', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('ties skill_installations to worktrees with ON DELETE CASCADE', () => {
    expect(worktreeForeignKeys(db)).toEqual([
      expect.objectContaining({ table: 'worktrees', on_delete: 'CASCADE' }),
    ]);
  });

  it('keeps the v45 columns', () => {
    const cols = (db.pragma('table_info(skill_installations)') as Array<{ name: string }>).map(
      (c) => c.name
    );
    expect(cols).toEqual([
      'id',
      'worktree_id',
      'skill_id',
      'version',
      'install_root',
      'receipt_sha256',
      'source_repository',
      'source_ref',
      'source_commit',
      'artifact_sha256',
      'effective_risk',
      'operation_id',
      'installed_at',
      'updated_at',
    ]);
  });

  it('keeps the lookup indexes the rebuild dropped along with the old table', () => {
    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='skill_installations'"
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_skill_installations_worktree',
        'idx_skill_installations_skill',
      ])
    );
  });

  it('keeps one row per (worktree, skill)', () => {
    insertWorktree(db, 'wt-1');
    insertInstallation(db, 'install-1', 'wt-1');
    expect(() => insertInstallation(db, 'install-2', 'wt-1')).toThrow(/UNIQUE/);
  });

  it('refuses a row for a worktree that does not exist', () => {
    expect(() => insertInstallation(db, 'install-1', 'ghost-wt')).toThrow(/FOREIGN KEY/);
  });

  it('reports the schema version the migration chain ends at', () => {
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(46);
  });
});

describe('migration v46: upgrading a v45 database', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrateToV45(db);
    insertWorktree(db, 'wt-live');
    insertInstallation(db, 'install-live', 'wt-live');
    // v45 has no foreign key, which is exactly how these accumulated.
    insertInstallation(db, 'install-dangling', 'wt-deleted-long-ago');
    insertInstallation(db, 'install-dangling-2', 'wt-deleted-long-ago', 'other-skill');
  });

  afterEach(() => {
    db.close();
  });

  it('sweeps rows whose worktree is gone', () => {
    runMigrations(db);
    expect(installationIds(db)).toEqual(['install-live']);
  });

  it('carries a live row over with every column value intact', () => {
    const before = db
      .prepare('SELECT * FROM skill_installations WHERE id = ?')
      .get('install-live');

    runMigrations(db);

    const after = db.prepare('SELECT * FROM skill_installations WHERE id = ?').get('install-live');
    expect(after).toEqual(before);
  });

  it('frees the (worktree, skill) pair a swept row was holding', () => {
    runMigrations(db);
    insertWorktree(db, 'wt-deleted-long-ago');
    expect(() => insertInstallation(db, 'install-new', 'wt-deleted-long-ago')).not.toThrow();
  });
});

describe('migration v46: worktree deletion', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    insertWorktree(db, 'wt-1');
    insertWorktree(db, 'wt-2');
    insertInstallation(db, 'install-1', 'wt-1');
    insertInstallation(db, 'install-2', 'wt-2');
  });

  afterEach(() => {
    db.close();
  });

  it('removes the installations of the deleted worktree only', () => {
    deleteWorktreesByIds(db, ['wt-1']);
    expect(installationIds(db)).toEqual(['install-2']);
  });

  it('keeps installations across a same-directory branch switch (#1151)', () => {
    db.transaction(() => {
      migrateWorktreeIdPreservingChildren(db, 'wt-1', 'wt-1-renamed');
    })();

    const row = db
      .prepare('SELECT worktree_id FROM skill_installations WHERE id = ?')
      .get('install-1') as { worktree_id: string } | undefined;
    expect(row?.worktree_id).toBe('wt-1-renamed');
  });
});

describe('migration v46: rollback and idempotency', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    insertWorktree(db, 'wt-1');
    insertInstallation(db, 'install-1', 'wt-1');
  });

  afterEach(() => {
    db.close();
  });

  it('down() drops the constraint without dropping the rows', () => {
    rollbackMigrations(db, 45);

    expect(getCurrentVersion(db)).toBe(45);
    expect(worktreeForeignKeys(db)).toEqual([]);
    expect(installationIds(db)).toEqual(['install-1']);
  });

  it('re-running runMigrations changes nothing', () => {
    expect(() => runMigrations(db)).not.toThrow();
    expect(installationIds(db)).toEqual(['install-1']);
    expect(worktreeForeignKeys(db)).toEqual([
      expect.objectContaining({ table: 'worktrees', on_delete: 'CASCADE' }),
    ]);
  });
});
