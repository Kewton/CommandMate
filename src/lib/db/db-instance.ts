/**
 * Database instance singleton
 * Provides a shared database connection for API routes
 *
 * Issue #135: DB path resolution fix
 * Uses getEnv().CM_DB_PATH for consistent path handling across all install types
 */

import Database from 'better-sqlite3';
import path from 'path';
import { runMigrations } from './db-migrations';
import { openDatabaseWithAbiRecovery } from './abi-recovery';
import { startAgentSessionCostSampler, stopAgentSessionCostSampler } from './agent-session-cost-sampler';
import { getEnv } from '@/lib/env';
import { isPathWithin } from '@/config/system-directories';

declare global {
  // Issue #4086: closers of the connections getDbInstance() opened under
  // Vitest, so tests/setup.ts can close them after each file without importing
  // this module (which would load it ahead of the file's vi.mock calls).
  // eslint-disable-next-line no-var
  var __commandmateTestDbClosers: Set<() => void> | undefined;
}

let dbInstance: Database.Database | null = null;

/**
 * `fs` / `os` are required lazily, as getDbInstance() always did for `fs`: a
 * test that mocks either module must not change how the real database is
 * opened or which directory counts as temp.
 */
function nodeFs(): typeof import('fs') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('fs') as typeof import('fs');
}

function nodeTmpdir(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('os') as typeof import('os')).tmpdir();
}

type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Issue #4086: is this code running inside a Vitest worker?
 *
 * Read off the worker state Vitest itself installs on `globalThis` (its
 * `getWorkerState()` reads the same `__vitest_worker__` global, in the forks
 * and threads pools alike), not off environment variables: the environment is
 * both inherited and editable. A test may swap `NODE_ENV` to `production`
 * mid-run (tests/unit/pwa/ServiceWorkerRegistrar.test.tsx does) and must stay
 * guarded, while a child process started outside Vitest inherits `VITEST` and
 * must not be taken for a test run.
 */
export function isInsideVitestWorker(): boolean {
  const state = (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__;
  return typeof state === 'object' && state !== null;
}

/**
 * Issue #4086: is this a test run (the guard's on-switch)?
 *
 * Inside a Vitest worker: always, whatever `NODE_ENV` says right now.
 * Outside one: only with `NODE_ENV=test` (a test's own child process, which
 * also inherits the per-process CM_DB_PATH). `VITEST` alone never counts —
 * the daemon spreads `process.env` into the server it starts
 * (src/cli/utils/daemon.ts buildChildEnv), so a `NODE_ENV=production` server
 * started from a shell where `VITEST` was left behind opens its real database.
 */
function isUnderTest(env: EnvLike, inVitestWorker: boolean): boolean {
  if (inVitestWorker) return true;
  return (env.NODE_ENV ?? '').trim() === 'test';
}

/** realpath of the nearest existing ancestor, with the missing tail re-joined. */
function physicalPath(target: string): string {
  const fs = nodeFs();
  let existing = path.resolve(target);
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync(existing), ...tail);
  } catch {
    return path.resolve(target);
  }
}

/** Set by tests/setup.ts: the gitignored directory that holds per-process test databases. */
export const TEST_DB_ROOT_ENV = 'CM_TEST_DB_ROOT';

/**
 * Issue #4086: under Vitest, refuse any database the test run does not own.
 *
 * A worker's shell inherits the server's `CM_DB_PATH=<production db>`, and a
 * test that reached this function opened that file, switched it to WAL and ran
 * the checkout's migrations on it (production went to v63 under a v62 server).
 * tests/setup.ts repoints the variables per process; this is the backstop for
 * a path that still escapes (a test that deletes `CM_DB_PATH` and falls to the
 * install default, a child process that inherited a real path).
 *
 * Owned = inside the OS temp directory (tests that mock `getEnv` and create
 * their own `mkdtemp` database) or inside `$CM_TEST_DB_ROOT` (the per-process
 * databases tests/setup.ts hands out — not under the temp dir, because
 * `validateDbPath` rejects /tmp and /var, where every OS temp dir lives). Not
 * only the one setup path, so tests that name their own database keep working.
 * Active inside a Vitest worker (even while a test has swapped `NODE_ENV`) and
 * in a process with `NODE_ENV=test`; a no-op otherwise, so a real server is
 * never affected — including one that inherited `VITEST` but runs with
 * `NODE_ENV=production`.
 *
 * @param inVitestWorker - defaults to {@link isInsideVitestWorker}; a test
 *   passes `false` to ask how a process outside Vitest would be judged
 * @throws Error when under test and `dbPath` is in neither directory
 */
export function assertTestDatabasePathIsolated(
  dbPath: string,
  env: EnvLike = process.env,
  tmpRoot: string = nodeTmpdir(),
  inVitestWorker: boolean = isInsideVitestWorker()
): void {
  if (!isUnderTest(env, inVitestWorker)) return;
  const resolved = path.resolve(dbPath);
  const roots = [tmpRoot, env[TEST_DB_ROOT_ENV]]
    .filter((root): root is string => typeof root === 'string' && root.trim() !== '');
  // Compared physically: macOS's /var -> /private/var (the temp dir lives
  // there) must not reject a temp path, and a symlink under an owned directory
  // must not let a real database through.
  const physical = physicalPath(resolved);
  if (!roots.some((root) => isPathWithin(physical, physicalPath(root)))) {
    throw new Error(
      `[Issue #4086] Refusing to open database ${resolved} under test: it is outside the temp directory `
      + `and outside ${TEST_DB_ROOT_ENV} (${roots.join(', ')}). tests/setup.ts points CM_DB_PATH at a `
      + 'per-process test database; a test that names its own database must create it under os.tmpdir().'
    );
  }
}

/**
 * Get or create the database instance
 *
 * Issue #135: Now uses getEnv().CM_DB_PATH instead of direct DATABASE_PATH access
 * This ensures consistent DB path resolution for both global and local installs.
 *
 * @returns Singleton database instance
 *
 * @example
 * ```typescript
 * const db = getDbInstance();
 * const worktrees = getWorktrees(db);
 * ```
 */
export function getDbInstance(): Database.Database {
  if (!dbInstance) {
    // Issue #135: Use getEnv() for consistent DB path resolution
    const env = getEnv();
    const dbPath = env.CM_DB_PATH;

    // Issue #4086: before anything touches the path (mkdir, open, WAL, migrations).
    assertTestDatabasePathIsolated(dbPath);

    // Ensure the database directory exists
    const fs = nodeFs();
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      // SEC-003: Set directory permissions to 0o700 (owner only)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Issue #1263: recover from a better-sqlite3 ABI mismatch (Node.js version switch)
    const db = openDatabaseWithAbiRecovery(dbPath);
    // Issue #294: Enable foreign key enforcement BEFORE migrations
    // This ensures ON DELETE CASCADE works correctly for all tables
    db.pragma('foreign_keys = ON');

    // Issue #1360: harden against SQLITE_BUSY when the same DB file is opened by
    // more than one process (e.g. a misconfigured worktree server sharing
    // CM_DB_PATH). WAL lets readers and a single writer coexist instead of
    // taking an exclusive lock, and busy_timeout makes a contended write wait
    // for the lock (up to 5s) rather than failing immediately with the default
    // busy_timeout of 0. Set before migrations so migration writes benefit too.
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');

    // Issue #1353: only publish the connection once its schema is verified.
    // Assigning before runMigrations() cached a database whose migrations had
    // thrown, so every later caller was handed it back without the failure —
    // the guard would fire once and be bypassed for the rest of the process.
    try {
      runMigrations(db);
    } catch (error) {
      db.close();
      throw error;
    }
    dbInstance = db;
    if (isUnderTest(process.env, isInsideVitestWorker())) {
      (globalThis.__commandmateTestDbClosers ??= new Set()).add(closeDbInstance);
    }

    // Issue #2044: the agent cost ledger needs somebody to copy the in-memory
    // telemetry in before the pane that holds it is killed. This is the one
    // place that runs once per process, after the schema is verified, in every
    // process that has a database — and the sampler is a no-op wherever the
    // telemetry map is empty. It refuses to start under Vitest and unrefs its
    // timer, so nothing here holds a test or the CLI open.
    startAgentSessionCostSampler(db);
  }

  return dbInstance;
}

/**
 * Close the database connection
 * Mainly used for testing cleanup
 */
export function closeDbInstance(): void {
  if (dbInstance) {
    // Issue #2044: stop the sampler before the handle it writes through goes
    // away, or the next tick throws `The database connection is not open`.
    stopAgentSessionCostSampler();
    dbInstance.close();
    dbInstance = null;
  }
}
