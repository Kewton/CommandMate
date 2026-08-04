/**
 * Startup must not purge the worktrees of a disabled repository (Issue #1666).
 *
 * #1658 made "disable" non-destructive: `UPDATE repositories SET enabled = 0`
 * and nothing else. `server.ts`'s `initializeWorktrees()` then undid that on the
 * next boot — for every path in `excludedPaths` it killed the tmux sessions and
 * deleted the worktree rows (and, by cascade, chat history, tasks and
 * verification runs). So the non-destructive disable was only non-destructive
 * until the next restart.
 *
 * Only repositories listed in `WORKTREE_REPOS` were exposed: a DB-only
 * repository drops out of `allPaths` when it is disabled and therefore never
 * reaches `excludedPaths`, while an env-listed one stays in `allPaths`, falls
 * out during filtering, and lands in `excludedPaths`.
 *
 * These tests drive the REAL `initializeWorktrees()` from `server.ts` against a
 * real migrated database. Nothing here re-implements the startup sequence: the
 * previous suite (`server-startup-exclusion-filter.test.ts`) composes the same
 * primitives by hand, which is exactly why it stayed green while the purge loop
 * sat two lines below the code it modelled. Only the process boundaries are
 * stubbed — Next, the HTTP server, the tmux transport and the four fail-open
 * reconcilers `initializeWorktrees()` loads dynamically.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, createMessage } from '@/lib/db';
import { createVerificationRun } from '@/lib/db/verification-db';
import {
  ensureEnvRepositoriesRegistered,
  getRepositoryByPath,
  setRepositoryEnabled,
  createRepository,
} from '@/lib/db/db-repository';
import type { Worktree } from '@/types/models';

const REPO_ENABLED = '/repos/CommandAgent';
const REPO_DISABLED = '/repos/CommandAgent-develop';
const WT_ENABLED = 'wt-enabled-0001';
const WT_DISABLED = 'wt-disabled-0001';

/**
 * Shared state the hoisted `vi.mock` factories close over. `vi.hoisted` is the
 * only way to hand a mock factory something the test file also owns.
 */
const h = vi.hoisted(() => ({
  /** The database `getDbInstance()` hands to `initializeWorktrees()`. */
  db: { current: null as unknown as import('better-sqlite3').Database },
  /** Repository paths `getRepositoryPaths()` reports, i.e. `WORKTREE_REPOS`. */
  envRepoPaths: { current: [] as string[] },
  /** Worktrees each scanned repository yields, keyed by repository path. */
  worktreesByRepo: { current: new Map<string, unknown[]>() },
  /** Every argument list `scanMultipleRepositories()` was called with. */
  scanCalls: [] as string[][],
  /** The `server.listen(port, host, cb)` callback — one "server startup". */
  listenCallbacks: [] as Array<() => void | Promise<void>>,
  killSession: vi.fn(async (_sessionName: string) => true),
  cleanupMultipleWorktrees: vi.fn(async (_worktreeIds: string[]) => ({
    results: [],
    warnings: [],
  })),
  killWorktreeSession: vi.fn(async (_worktreeId: string) => false),
}));

// --- process boundaries -----------------------------------------------------

vi.mock('next', () => ({
  default: () => ({
    prepare: () => Promise.resolve(),
    getRequestHandler: () => async () => {},
  }),
}));

const fakeServer = {
  on: vi.fn(),
  listen: vi.fn((_port: number, _host: string, cb: () => void | Promise<void>) => {
    h.listenCallbacks.push(cb);
    return fakeServer;
  }),
  close: vi.fn(),
};

vi.mock('http', () => ({ createServer: () => fakeServer }));
vi.mock('https', () => ({ createServer: () => fakeServer }));
vi.mock('@/lib/ws-server', () => ({
  setupWebSocket: vi.fn(),
  closeWebSocket: vi.fn(),
}));

// --- the seams `initializeWorktrees()` reads ---------------------------------

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => h.db.current,
  closeDbInstance: vi.fn(),
}));

vi.mock('@/lib/git/worktrees', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/git/worktrees')>();
  return {
    ...actual,
    getRepositoryPaths: () => [...h.envRepoPaths.current],
    scanMultipleRepositories: async (paths: string[]) => {
      h.scanCalls.push([...paths]);
      return paths.flatMap(p => h.worktreesByRepo.current.get(p) ?? []);
    },
  };
});

/**
 * `killSession` is the tmux boundary: whatever route a purge takes, it has to
 * cross this to end a running agent. `hasSession` stays false so the global
 * session sweep inside `syncWorktreesAndCleanup` finds nothing to kill and the
 * spy records only what the code under test initiated.
 */
vi.mock('@/lib/tmux/tmux', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux')>();
  return {
    ...actual,
    hasSession: async () => false,
    killSession: h.killSession,
  };
});

/**
 * The two symbols the purge loop used. `syncWorktreesAndCleanup` stays real —
 * it owns the *other* deletion path at startup (the per-repository prune inside
 * `syncWorktreesToDB`), and that is exactly what must be observed, not stubbed.
 */
vi.mock('@/lib/session-cleanup', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/session-cleanup')>();
  return {
    ...actual,
    cleanupMultipleWorktrees: h.cleanupMultipleWorktrees,
    killWorktreeSession: h.killWorktreeSession,
  };
});

// --- fail-open reconcilers loaded via `await import()` ------------------------

vi.mock('@/lib/skills/startup-reconcile', () => ({
  runSkillStartupReconciliation: () => ({
    scanned: 0,
    converged: 0,
    failed: 0,
    pruned: 0,
    orphanLocksReleased: [],
  }),
}));
vi.mock('@/lib/session/worktree-session-reconcile', () => ({
  reconcileWorktreeSessionsFromAliases: async () => ({
    renamedSessions: [],
    planSources: { predicted: 0, discovered: 0 },
    unaccountedSessions: [],
    errors: [],
  }),
}));
vi.mock('@/lib/verification/verification-reconciler', () => ({
  reconcileOrphanVerificationRuns: () => ({ runs: 0, gates: 0 }),
}));
vi.mock('@/lib/tmux/read-mode', () => ({
  initReadMode: async () => ({ installed: false, key: 'g' }),
}));

// --- managers started after the worktree sync --------------------------------

vi.mock('@/lib/schedule-manager', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/schedule-manager')>()),
  initScheduleManager: vi.fn(),
  stopAllSchedules: vi.fn(),
}));
vi.mock('@/lib/timer-manager', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/timer-manager')>()),
  initTimerManager: vi.fn(),
  stopAllTimers: vi.fn(),
}));
vi.mock('@/lib/resource-cleanup', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/resource-cleanup')>()),
  initResourceCleanup: vi.fn(),
  stopResourceCleanup: vi.fn(),
}));

// ============================================================================

function worktree(id: string, repoPath: string, dirName: string): Worktree {
  return {
    id,
    name: dirName,
    branch: dirName,
    path: path.join(repoPath, dirName),
    repositoryPath: repoPath,
    repositoryName: path.basename(repoPath),
  };
}

/** Seed a worktree plus one row in every child table the purge cascade wiped. */
function seedWorktreeWithHistory(
  db: import('better-sqlite3').Database,
  repoPath: string,
  worktreeId: string,
  dirName: string
): void {
  upsertWorktree(db, worktree(worktreeId, repoPath, dirName));

  createMessage(db, {
    worktreeId,
    role: 'user',
    content: 'said before the repository was disabled',
    timestamp: new Date(1_700_000_000_000),
    messageType: 'normal',
  });

  db.prepare(
    `INSERT INTO tasks (
       id, worktree_id, cli_tool_id, instance_id, title, goal, contract_path,
       contract_json, status, last_verification_run_id, created_at, updated_at,
       started_at, finished_at
     ) VALUES (?, ?, 'claude', NULL, 'task title', 'task goal', NULL, '{}', 'pending', NULL, ?, ?, NULL, NULL)`
  ).run(`task-${worktreeId}`, worktreeId, 1_700_000_000_000, 1_700_000_000_000);

  createVerificationRun(db, { worktreeId, trigger: 'manual' });
}

function countRows(
  db: import('better-sqlite3').Database,
  table: string,
  worktreeId: string
): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE worktree_id = ?`)
    .get(worktreeId) as { count: number };
  return Number(row.count) || 0;
}

/** Every child table the acceptance criteria name, plus the worktree itself. */
function snapshot(db: import('better-sqlite3').Database, worktreeId: string) {
  return {
    worktrees: countWorktreeById(db, worktreeId),
    chatMessages: countRows(db, 'chat_messages', worktreeId),
    tasks: countRows(db, 'tasks', worktreeId),
    verificationRuns: countRows(db, 'verification_runs', worktreeId),
  };
}

function countWorktreeById(
  db: import('better-sqlite3').Database,
  worktreeId: string
): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM worktrees WHERE id = ?')
    .get(worktreeId) as { count: number };
  return Number(row.count) || 0;
}

let logSpy: {
  mock: { calls: unknown[][] };
  mockRestore: () => void;
};

/** Run one full server startup: the `server.listen()` callback, awaited. */
async function startServer(): Promise<void> {
  const cb = h.listenCallbacks[0];
  expect(cb, 'server.listen() callback was never registered').toBeTypeOf('function');
  await cb();
}

/** Log lines `initializeWorktrees()` emitted since the last reset. */
function loggedLines(): string[] {
  return logSpy.mock.calls.map(args => args.map(String).join(' '));
}

beforeAll(async () => {
  // `server.ts` is imported once: it registers SIGTERM/SIGINT/uncaughtException
  // handlers at module scope, and re-importing would stack them. The startup
  // path itself is re-runnable — `initializeWorktrees()` re-reads the database
  // through `getDbInstance()` on every call, which is what makes "restart the
  // server" expressible as "call the listen callback again".
  const db = new Database(':memory:');
  runMigrations(db);
  h.db.current = db;
  await import('../../../server');
  // `app.prepare().then(...)` builds the server on a microtask.
  await new Promise(resolve => setImmediate(resolve));
  expect(h.listenCallbacks).toHaveLength(1);
  db.close();
});

beforeEach(() => {
  const db = new Database(':memory:');
  runMigrations(db);
  h.db.current = db;

  h.scanCalls.length = 0;
  h.killSession.mockClear();
  h.cleanupMultipleWorktrees.mockClear();
  h.killWorktreeSession.mockClear();
  h.envRepoPaths.current = [];
  h.worktreesByRepo.current = new Map();

  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  h.db.current?.close();
});

// ============================================================================
// The regression: a WORKTREE_REPOS repository disabled through #1658's toggle
// ============================================================================

describe('startup with a disabled WORKTREE_REPOS repository (Issue #1666)', () => {
  beforeEach(() => {
    const db = h.db.current;

    // Both repositories come from `WORKTREE_REPOS`, the shape #1659 started
    // from: one git repository visible through two scan roots.
    h.envRepoPaths.current = [REPO_ENABLED, REPO_DISABLED];
    ensureEnvRepositoriesRegistered(db, [REPO_ENABLED, REPO_DISABLED]);

    seedWorktreeWithHistory(db, REPO_ENABLED, WT_ENABLED, 'main');
    seedWorktreeWithHistory(db, REPO_DISABLED, WT_DISABLED, 'develop');

    // A previous scan of the enabled repository still reports its own worktree,
    // so the per-repository prune inside syncWorktreesToDB has nothing to do.
    h.worktreesByRepo.current.set(REPO_ENABLED, [
      worktree(WT_ENABLED, REPO_ENABLED, 'main'),
    ]);
    h.worktreesByRepo.current.set(REPO_DISABLED, [
      worktree(WT_DISABLED, REPO_DISABLED, 'develop'),
    ]);

    // The user flips the Scan toggle #1658 added.
    const disabled = getRepositoryByPath(db, REPO_DISABLED)!;
    setRepositoryEnabled(db, disabled.id, false);
  });

  it('keeps every worktree row and child row across a restart', async () => {
    const db = h.db.current;
    const before = snapshot(db, WT_DISABLED);
    expect(before).toEqual({
      worktrees: 1,
      chatMessages: 1,
      tasks: 1,
      verificationRuns: 1,
    });

    await startServer();

    expect(snapshot(db, WT_DISABLED)).toEqual(before);
    // The enabled repository is untouched too — the fix must not work by
    // skipping the sync altogether.
    expect(snapshot(db, WT_ENABLED)).toEqual(before);
  });

  it('keeps them across repeated restarts', async () => {
    const db = h.db.current;

    await startServer();
    await startServer();
    await startServer();

    expect(snapshot(db, WT_DISABLED)).toEqual({
      worktrees: 1,
      chatMessages: 1,
      tasks: 1,
      verificationRuns: 1,
    });
  });

  it('does not kill the tmux sessions of the disabled repository', async () => {
    await startServer();

    expect(h.cleanupMultipleWorktrees).not.toHaveBeenCalled();
    expect(h.killWorktreeSession).not.toHaveBeenCalled();
    // Nothing reached the tmux transport under either worktree's name.
    const killed = h.killSession.mock.calls.map(args => String(args[0]));
    expect(killed.filter(name => name.includes(WT_DISABLED))).toEqual([]);
    expect(killed.filter(name => name.includes(WT_ENABLED))).toEqual([]);
  });

  it('still logs the excluded repository for audit (SF-SEC-003)', async () => {
    await startServer();

    const lines = loggedLines();
    expect(lines).toContain(`  [excluded] ${REPO_DISABLED}`);
    expect(
      lines.some(l => l.startsWith('Excluded repositories: 1,'))
    ).toBe(true);
  });

  it('does not scan the disabled repository', async () => {
    await startServer();

    expect(h.scanCalls).toHaveLength(1);
    expect(h.scanCalls[0]).toEqual([REPO_ENABLED]);
  });

  it('leaves the repository row disabled — startup does not re-enable it', async () => {
    const db = h.db.current;

    await startServer();

    expect(getRepositoryByPath(db, REPO_DISABLED)!.enabled).toBe(false);
    expect(getRepositoryByPath(db, REPO_ENABLED)!.enabled).toBe(true);
  });
});

// ============================================================================
// The already-safe half of the table in the Issue, pinned so it stays safe
// ============================================================================

describe('startup with a disabled DB-only repository (Issue #1666)', () => {
  beforeEach(() => {
    const db = h.db.current;

    // Nothing in WORKTREE_REPOS: this repository exists only as a DB row, the
    // shape a clone produces.
    h.envRepoPaths.current = [REPO_ENABLED];
    ensureEnvRepositoriesRegistered(db, [REPO_ENABLED]);
    createRepository(db, {
      name: 'cloned',
      path: REPO_DISABLED,
      cloneSource: 'https',
      enabled: true,
    });

    seedWorktreeWithHistory(db, REPO_ENABLED, WT_ENABLED, 'main');
    seedWorktreeWithHistory(db, REPO_DISABLED, WT_DISABLED, 'develop');
    h.worktreesByRepo.current.set(REPO_ENABLED, [
      worktree(WT_ENABLED, REPO_ENABLED, 'main'),
    ]);

    const disabled = getRepositoryByPath(db, REPO_DISABLED)!;
    setRepositoryEnabled(db, disabled.id, false);
  });

  it('keeps every row and never reaches the exclusion branch', async () => {
    const db = h.db.current;

    await startServer();

    expect(snapshot(db, WT_DISABLED)).toEqual({
      worktrees: 1,
      chatMessages: 1,
      tasks: 1,
      verificationRuns: 1,
    });
    // A DB-only path never enters `allPaths`, so it is not "excluded" either —
    // there is nothing to log and nothing to purge.
    expect(loggedLines().some(l => l.includes('[excluded]'))).toBe(false);
    expect(h.scanCalls[0]).toEqual([REPO_ENABLED]);
  });
});

// ============================================================================
// The surviving deletion path at startup still works
// ============================================================================

describe('startup still prunes worktrees that really went away (Issue #1666)', () => {
  it('deletes rows of an enabled repository whose worktree vanished from disk', async () => {
    const db = h.db.current;

    h.envRepoPaths.current = [REPO_ENABLED];
    ensureEnvRepositoriesRegistered(db, [REPO_ENABLED]);
    seedWorktreeWithHistory(db, REPO_ENABLED, WT_ENABLED, 'main');
    seedWorktreeWithHistory(db, REPO_ENABLED, 'wt-removed-0001', 'feature');

    // The scan of the still-enabled repository no longer reports `feature/`.
    h.worktreesByRepo.current.set(REPO_ENABLED, [
      worktree(WT_ENABLED, REPO_ENABLED, 'main'),
    ]);

    await startServer();

    expect(countWorktreeById(db, 'wt-removed-0001')).toBe(0);
    expect(countWorktreeById(db, WT_ENABLED)).toBe(1);
  });
});
