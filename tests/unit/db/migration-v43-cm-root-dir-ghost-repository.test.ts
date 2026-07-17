/**
 * Unit tests for migration v43 (CM_ROOT_DIR ghost repository row, Issue #1339).
 *
 * Most of these tests are about what the migration must NOT delete. Deleting a
 * legitimate env-managed row is not a harmless mistake: a missing row is
 * recreated by ensureEnvRepositoriesRegistered() with `enabled: true`
 * (db-repository.ts:469), so a wrong delete silently re-enables a repository the
 * user disabled. Every guard is pinned here.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import {
  runMigrations,
  rollbackMigrations,
  getCurrentVersion,
  CURRENT_SCHEMA_VERSION,
} from '@/lib/db/db-migrations';

const GHOST_PATH = '/tmp/cm-1339/repos';
const REAL_REPO_PATH = '/tmp/cm-1339/repos/my-project';

interface RepoOptions {
  path: string;
  isEnvManaged: boolean;
  enabled?: boolean;
  visible?: boolean;
  displayName?: string | null;
}

function insertRepository(db: Database.Database, opts: RepoOptions): void {
  db.prepare(
    `INSERT INTO repositories
       (id, name, display_name, path, enabled, visible, clone_source, is_env_managed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'local', ?, 0, 0)`
  ).run(
    `id-${opts.path}`,
    path.basename(opts.path),
    opts.displayName ?? null,
    opts.path,
    opts.enabled === false ? 0 : 1,
    opts.visible === false ? 0 : 1,
    opts.isEnvManaged ? 1 : 0
  );
}

function insertWorktree(db: Database.Database, repositoryPath: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    `wt-${repositoryPath}`,
    'main',
    `${repositoryPath}/main`,
    repositoryPath,
    path.basename(repositoryPath)
  );
}

function repoAt(db: Database.Database, repoPath: string) {
  return db
    .prepare('SELECT path, enabled, visible, display_name, is_env_managed FROM repositories WHERE path = ?')
    .get(repoPath) as
    | { path: string; enabled: number; visible: number; display_name: string | null; is_env_managed: number }
    | undefined;
}

/**
 * Bring a database up to v42 only, so a v42-era row can be seeded and v43 then
 * run against it — the actual upgrade path a user takes.
 */
function migrateToV42(db: Database.Database): void {
  runMigrations(db);
  rollbackMigrations(db, 42);
}

describe('migration v43: CM_ROOT_DIR ghost repository row (Issue #1339)', () => {
  let db: Database.Database;
  const envBackup = { ...process.env };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    delete process.env.CM_ROOT_DIR;
    delete process.env.MCBD_ROOT_DIR;
    delete process.env.WORKTREE_REPOS;
  });

  afterEach(() => {
    db.close();
    process.env = { ...envBackup };
  });

  it('deletes the env-managed CM_ROOT_DIR row that has no worktrees', () => {
    process.env.CM_ROOT_DIR = GHOST_PATH;
    migrateToV42(db);
    insertRepository(db, { path: GHOST_PATH, isEnvManaged: true });

    runMigrations(db);

    expect(repoAt(db, GHOST_PATH)).toBeUndefined();
  });

  it('leaves a real repository under CM_ROOT_DIR untouched', () => {
    process.env.CM_ROOT_DIR = GHOST_PATH;
    migrateToV42(db);
    insertRepository(db, { path: GHOST_PATH, isEnvManaged: true });
    insertRepository(db, { path: REAL_REPO_PATH, isEnvManaged: false });
    insertWorktree(db, REAL_REPO_PATH);

    runMigrations(db);

    expect(repoAt(db, GHOST_PATH)).toBeUndefined();
    expect(repoAt(db, REAL_REPO_PATH)).toBeDefined();
  });

  it('resolves CM_ROOT_DIR the way the ghost row was written, so a trailing slash still matches', () => {
    process.env.CM_ROOT_DIR = `${GHOST_PATH}/`;
    migrateToV42(db);
    insertRepository(db, { path: GHOST_PATH, isEnvManaged: true });

    runMigrations(db);

    expect(repoAt(db, GHOST_PATH)).toBeUndefined();
  });

  it('honours the legacy MCBD_ROOT_DIR name', () => {
    process.env.MCBD_ROOT_DIR = GHOST_PATH;
    migrateToV42(db);
    insertRepository(db, { path: GHOST_PATH, isEnvManaged: true });

    runMigrations(db);

    expect(repoAt(db, GHOST_PATH)).toBeUndefined();
  });

  it('reaches the current schema version', () => {
    process.env.CM_ROOT_DIR = GHOST_PATH;
    runMigrations(db);

    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(43);
  });

  it('is a no-op on a database that has no ghost row', () => {
    process.env.CM_ROOT_DIR = GHOST_PATH;
    migrateToV42(db);
    insertRepository(db, { path: REAL_REPO_PATH, isEnvManaged: false });
    insertWorktree(db, REAL_REPO_PATH);

    runMigrations(db);

    expect(repoAt(db, REAL_REPO_PATH)).toBeDefined();
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  describe('guards against deleting a legitimate row', () => {
    it('keeps CM_ROOT_DIR when it is also a WORKTREE_REPOS entry, preserving a user-disabled state', () => {
      // The regression this guard prevents: ensureEnvRepositoriesRegistered()
      // recreates a missing WORKTREE_REPOS row with enabled=true, so deleting
      // this row would un-disable a repository the user deliberately turned off.
      process.env.CM_ROOT_DIR = GHOST_PATH;
      process.env.WORKTREE_REPOS = GHOST_PATH;
      migrateToV42(db);
      insertRepository(db, {
        path: GHOST_PATH,
        isEnvManaged: true,
        enabled: false,
        visible: false,
        displayName: 'My Repo',
      });

      runMigrations(db);

      const row = repoAt(db, GHOST_PATH);
      expect(row).toBeDefined();
      expect(row!.enabled).toBe(0);
      expect(row!.visible).toBe(0);
      expect(row!.display_name).toBe('My Repo');
    });

    it('keeps CM_ROOT_DIR when it is one of several WORKTREE_REPOS entries', () => {
      process.env.CM_ROOT_DIR = GHOST_PATH;
      process.env.WORKTREE_REPOS = `${REAL_REPO_PATH}, ${GHOST_PATH}`;
      migrateToV42(db);
      insertRepository(db, { path: GHOST_PATH, isEnvManaged: true });

      runMigrations(db);

      expect(repoAt(db, GHOST_PATH)).toBeDefined();
    });

    it('keeps CM_ROOT_DIR when worktrees exist under it, even though the env calls it a container', () => {
      // A user who pointed CM_ROOT_DIR at an actual git repository has a row
      // that is doing real work; worktree rows prove it is not a ghost.
      process.env.CM_ROOT_DIR = GHOST_PATH;
      migrateToV42(db);
      insertRepository(db, { path: GHOST_PATH, isEnvManaged: true, enabled: false });
      insertWorktree(db, GHOST_PATH);

      runMigrations(db);

      const row = repoAt(db, GHOST_PATH);
      expect(row).toBeDefined();
      expect(row!.enabled).toBe(0);
    });

    it('keeps an is_env_managed=0 row at CM_ROOT_DIR (that is #1346, not this issue)', () => {
      // disableRepository() writes is_env_managed=0 rows. They are a separate
      // defect with a separate fix; this migration must not absorb them.
      process.env.CM_ROOT_DIR = GHOST_PATH;
      migrateToV42(db);
      insertRepository(db, { path: GHOST_PATH, isEnvManaged: false, enabled: false });

      runMigrations(db);

      const row = repoAt(db, GHOST_PATH);
      expect(row).toBeDefined();
      expect(row!.enabled).toBe(0);
    });

    it('deletes nothing when CM_ROOT_DIR is unset, and never falls back to cwd', () => {
      // getEnv() resolves an unset CM_ROOT_DIR to process.cwd() (env.ts:218).
      // If the migration went through getEnv(), this row — a repository that
      // merely happens to sit at the server's working directory — would be
      // deleted. Unset must mean skip.
      migrateToV42(db);
      insertRepository(db, { path: process.cwd(), isEnvManaged: true });

      runMigrations(db);

      expect(repoAt(db, process.cwd())).toBeDefined();
    });

    it('deletes nothing when CM_ROOT_DIR is blank', () => {
      process.env.CM_ROOT_DIR = '   ';
      migrateToV42(db);
      insertRepository(db, { path: process.cwd(), isEnvManaged: true });

      runMigrations(db);

      expect(repoAt(db, process.cwd())).toBeDefined();
    });

    it('keeps env-managed rows at other paths', () => {
      process.env.CM_ROOT_DIR = GHOST_PATH;
      process.env.WORKTREE_REPOS = REAL_REPO_PATH;
      migrateToV42(db);
      insertRepository(db, { path: GHOST_PATH, isEnvManaged: true });
      insertRepository(db, { path: REAL_REPO_PATH, isEnvManaged: true, enabled: false });

      runMigrations(db);

      expect(repoAt(db, GHOST_PATH)).toBeUndefined();
      const kept = repoAt(db, REAL_REPO_PATH);
      expect(kept).toBeDefined();
      expect(kept!.enabled).toBe(0);
    });
  });

  describe('down', () => {
    it('rewinds to 42 without resurrecting the ghost row', () => {
      process.env.CM_ROOT_DIR = GHOST_PATH;
      migrateToV42(db);
      insertRepository(db, { path: GHOST_PATH, isEnvManaged: true });
      runMigrations(db);
      expect(repoAt(db, GHOST_PATH)).toBeUndefined();

      rollbackMigrations(db, 42);

      expect(getCurrentVersion(db)).toBe(42);
      expect(repoAt(db, GHOST_PATH)).toBeUndefined();
    });

    it('survives a full down/up round trip', () => {
      process.env.CM_ROOT_DIR = GHOST_PATH;
      runMigrations(db);
      rollbackMigrations(db, 42);
      runMigrations(db);

      expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    });
  });
});
