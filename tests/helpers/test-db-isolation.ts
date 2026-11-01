/**
 * Keep the Vitest suite off whatever database the calling shell names (Issue #4086).
 *
 * A worker's tmux session — and every verification the server runs for it —
 * inherits the server's environment, and on the machine that runs this repo
 * that environment carries `CM_DB_PATH=<the production database>`. A test that
 * reached the real `getDbInstance()` therefore opened that file, switched it to
 * WAL and ran this checkout's migrations against it: on 2026-11-01 a worker
 * whose branch added schema v63 left the production database at v63 while the
 * server was still a v62 build.
 *
 * `tests/setup.ts` calls {@link isolateTestDatabaseEnv} once per test file.
 * Unlike the `CM_OPENCODE_*` defaults next to it, this one is applied *even
 * when the environment already has a value*: an inherited value is exactly the
 * hazard, so "fill only a gap" would leave it in place. The deprecated aliases
 * (`MCBD_DB_PATH`, `DATABASE_PATH`) are removed rather than repointed, so they
 * cannot name the protected file and nothing prints their deprecation warning
 * on behalf of the shell. With `CM_DB_PATH` always set, the install-dependent
 * default of `getDefaultDbPath()` (`~/.commandmate/data/cm.db` or
 * `<cwd>/data/cm.db`) is never consulted either.
 *
 * Where: `<repo>/data/test-db/<pid>/cm.db`, not `os.tmpdir()`. The real
 * `getEnv()` runs every path through `validateDbPath`, which rejects `/tmp` and
 * `/var` (and their `/private` forms) as system directories — and every OS
 * temp dir lives in one of them (macOS: `/var/folders/…`). A temp-dir
 * `CM_DB_PATH` would make every test that calls the real `getEnv()` throw
 * `Invalid CM_DB_PATH`. `/data/` is gitignored and is where a local install
 * keeps its database anyway; the `test-db` subdirectory is never a server's.
 *
 * A test that names its own database (`vi.stubEnv('CM_DB_PATH', …)`, a mocked
 * `getEnv`) still wins: it runs after this. `getDbInstance()` additionally
 * refuses, under Vitest, any path outside the OS temp directory and outside
 * `$CM_TEST_DB_ROOT` — see `assertTestDatabasePathIsolated` in
 * `src/lib/db/db-instance.ts`.
 *
 * Scope: only processes that load `tests/setup.ts` (the Vitest suite). Other
 * steps of `commandmate verify` are not covered by this file.
 */

import { rmdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The environment variables `getEnv()` reads the database path from. */
export const TEST_DB_ENV_KEYS = ['CM_DB_PATH', 'MCBD_DB_PATH', 'DATABASE_PATH'] as const;

/** Environment variable that names the owned root (read by `getDbInstance()`'s guard). */
export const TEST_DB_ROOT_ENV = 'CM_TEST_DB_ROOT';

/** Parent directory of every per-process test database (gitignored `/data/`). */
export const DEFAULT_TEST_DB_ROOT = resolve(__dirname, '..', '..', 'data', 'test-db');

/** File name of the database inside a per-process directory. */
export const TEST_DB_FILE_NAME = 'cm.db';

export interface TestDatabaseLocation {
  /** Per-process directory that holds the database and its -wal/-shm/backups. */
  dir: string;
  /** Absolute path assigned to `CM_DB_PATH`. */
  dbPath: string;
}

/**
 * Where the database of the test process `pid` lives.
 *
 * Scoped by pid for the same reason as `CM_OPENCODE_PORT_FILE`: Vitest's fork
 * workers, and several checkouts running the suite at once, must not share one
 * file — two processes migrating the same file is the collision this exists to
 * prevent.
 */
export function testDatabaseLocationFor(
  pid: number = process.pid,
  root: string = DEFAULT_TEST_DB_ROOT
): TestDatabaseLocation {
  const dir = join(root, String(pid));
  return { dir, dbPath: join(dir, TEST_DB_FILE_NAME) };
}

/**
 * Point the database variables of `env` at this process's temp database.
 *
 * Overwrites `CM_DB_PATH` unconditionally, deletes the deprecated aliases and
 * records the owned root in `CM_TEST_DB_ROOT`.
 */
export function isolateTestDatabaseEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { pid?: number; root?: string } = {}
): TestDatabaseLocation {
  const root = options.root ?? DEFAULT_TEST_DB_ROOT;
  const location = testDatabaseLocationFor(options.pid, root);
  env[TEST_DB_ROOT_ENV] = root;
  env.CM_DB_PATH = location.dbPath;
  delete env.MCBD_DB_PATH;
  delete env.DATABASE_PATH;
  return location;
}

/**
 * Close every connection `getDbInstance()` opened in this process.
 *
 * `getDbInstance()` registers its `closeDbInstance` here while under Vitest
 * (every module graph that `vi.resetModules()` produced registers its own), so
 * the setup file can close what a test file left open without importing the
 * database module itself — importing it from the setup file would load it
 * ahead of the test file's `vi.mock` calls.
 */
export function closeOpenTestDatabases(): void {
  const closers = globalThis.__commandmateTestDbClosers;
  if (!closers) return;
  for (const close of [...closers]) {
    try {
      close();
    } catch {
      // A connection a test already tore down by hand is not a reason to fail
      // the file after its assertions passed.
    }
  }
  closers.clear();
}

/**
 * Remove a per-process test database directory (the db and its -wal/-shm/
 * backups), and its parent when that leaves it empty.
 */
export function removeTestDatabaseDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  try {
    rmdirSync(resolve(dir, '..'));
  } catch {
    // Another process's database is still there (or it is already gone).
  }
}
