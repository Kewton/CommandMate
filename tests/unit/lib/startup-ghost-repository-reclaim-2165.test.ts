/**
 * Startup reclaims ghost `repositories` rows before it builds the scan set
 * (Issue #2165).
 *
 * The symptom in the Issue is a boot symptom: three `[ERROR] repository:
 * scan-failed … spawn /bin/sh ENOENT` lines on every server start, from three
 * `enabled = 1` rows whose `/tmp` directories the OS collected months earlier.
 * `pruneStaleRepositoryWorktrees` never saw them (it prunes worktree rows, and
 * these rows own none) and it is wired into `POST /api/repositories/sync` only,
 * which a server that is merely restarted never reaches.
 *
 * These tests drive the REAL `initializeWorktrees()` from `server.ts` against a
 * real migrated database, for the same reason `startup-excluded-repository-
 * purge.test.ts` does: a suite that re-composes the startup sequence by hand
 * stays green while the line it is modelling sits somewhere else. Only the
 * process boundaries are stubbed — Next, the HTTP server, the tmux transport
 * and the reconcilers `initializeWorktrees()` loads dynamically.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, createMessage, getMessages, getWorktrees } from '@/lib/db';
import {
  createRepository,
  getRepositoryById,
  getRepositoryByPath,
} from '@/lib/db/db-repository';
import type { Worktree } from '@/types/models';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

const h = vi.hoisted(() => ({
  db: { current: null as unknown as import('better-sqlite3').Database },
  envRepoPaths: { current: [] as string[] },
  /** Worktrees each scanned repository yields, keyed by repository path. */
  worktreesByRepo: { current: new Map<string, unknown[]>() },
  scanCalls: [] as string[][],
  listenCallbacks: [] as Array<() => void | Promise<void>>,
  /** When set, `reclaimGhostRepositories` throws this instead of running. */
  reclaimError: { current: null as Error | null },
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

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => h.db.current,
  closeDbInstance: vi.fn(),
}));

/**
 * `reclaimGhostRepositories` stays REAL — it is the code under test. The
 * wrapper only exists so one test can make it throw; with `reclaimError` unset
 * (every other test) the original runs untouched. The other two seams are the
 * environment and git.
 */
vi.mock('@/lib/git/worktrees', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/git/worktrees')>();
  return {
    ...actual,
    getRepositoryPaths: () => [...h.envRepoPaths.current],
    scanMultipleRepositories: async (paths: string[]) => {
      h.scanCalls.push([...paths]);
      return paths.flatMap(p => h.worktreesByRepo.current.get(p) ?? []);
    },
    reclaimGhostRepositories: (
      ...args: Parameters<typeof actual.reclaimGhostRepositories>
    ) => {
      if (h.reclaimError.current) throw h.reclaimError.current;
      return actual.reclaimGhostRepositories(...args);
    },
  };
});

vi.mock('@/lib/tmux/tmux', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux')>()),
  hasSession: async () => false,
  killSession: vi.fn(async () => true),
}));

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

let sandbox: string;
let logSpy: { mock: { calls: unknown[][] }; mockRestore: () => void };

function makeRepoDir(name: string): string {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

function missingPath(name: string): string {
  return path.join(sandbox, name);
}

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

/** Run one full server startup: the `server.listen()` callback, awaited. */
async function startServer(): Promise<void> {
  const cb = h.listenCallbacks[0];
  expect(cb, 'server.listen() callback was never registered').toBeTypeOf('function');
  await cb();
}

function loggedLines(): string[] {
  return logSpy.mock.calls.map(args => args.map(String).join(' '));
}

/** Paths handed to `scanMultipleRepositories` during the last startup. */
function scannedPaths(): string[] {
  return h.scanCalls.flat();
}

beforeAll(async () => {
  // `server.ts` is imported once: it registers SIGTERM/SIGINT/uncaughtException
  // handlers at module scope. The startup path itself is re-runnable.
  const db = new Database(':memory:');
  runMigrations(db);
  h.db.current = db;
  await import('../../../server');
  await new Promise(resolve => setImmediate(resolve));
  expect(h.listenCallbacks).toHaveLength(1);
  db.close();
});

beforeEach(() => {
  const db = new Database(':memory:');
  runMigrations(db);
  h.db.current = db;

  sandbox = makeTempDir('startup-ghost-2165-');
  h.scanCalls.length = 0;
  h.envRepoPaths.current = [];
  h.worktreesByRepo.current = new Map();
  h.reclaimError.current = null;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  h.db.current?.close();
  removeTempDir(sandbox);
});

describe('startup reclaims the ghost rows (Issue #2165)', () => {
  it('demotes the ghost row and never hands its path to the scan', async () => {
    const db = h.db.current;
    const ghost = missingPath('tmp-repos/my-flask_app');
    const live = makeRepoDir('live');
    const ghostRow = createRepository(db, {
      name: 'my-flask_app',
      path: ghost,
      cloneSource: 'local',
    });
    createRepository(db, { name: 'live', path: live, cloneSource: 'local' });

    await startServer();

    expect(getRepositoryById(db, ghostRow.id)!.enabled).toBe(false);
    expect(scannedPaths()).toEqual([live]);
  });

  it('reclaims on the FIRST boot, so the ERROR does not get logged one last time', async () => {
    const db = h.db.current;
    const ghost = missingPath('gone');
    createRepository(db, { name: 'gone', path: ghost, cloneSource: 'local' });

    await startServer();

    // Reclamation runs before the scan set is built, so the path is already out.
    expect(scannedPaths()).toEqual([]);
  });

  it('says what it did, with the path and the fact that it is restorable', async () => {
    const db = h.db.current;
    const ghost = missingPath('gone');
    createRepository(db, { name: 'gone', path: ghost, cloneSource: 'local' });

    await startServer();

    const line = loggedLines().find(l => l.includes('ghost repository row'));
    expect(line).toBeDefined();
    expect(line).toContain(ghost);
    expect(line).toMatch(/restorable|Repositories screen/);
  });

  it('deletes nothing — the row is still there, disabled', async () => {
    const db = h.db.current;
    const ghost = missingPath('gone');
    createRepository(db, { name: 'gone', path: ghost, cloneSource: 'local' });

    await startServer();

    expect(getRepositoryByPath(db, ghost)).toMatchObject({
      path: ghost,
      enabled: false,
      visible: true,
    });
  });

  it('stays quiet on a boot with nothing to reclaim', async () => {
    const db = h.db.current;
    const live = makeRepoDir('live');
    createRepository(db, { name: 'live', path: live, cloneSource: 'local' });

    await startServer();

    expect(loggedLines().some(l => l.includes('ghost repository row'))).toBe(false);
    expect(scannedPaths()).toEqual([live]);
  });

  it('is stable across restarts — the row is reclaimed once and stays disabled', async () => {
    const db = h.db.current;
    const ghost = missingPath('gone');
    const ghostRow = createRepository(db, { name: 'gone', path: ghost, cloneSource: 'local' });

    await startServer();
    logSpy.mock.calls.length = 0;
    await startServer();

    expect(getRepositoryById(db, ghostRow.id)!.enabled).toBe(false);
    expect(loggedLines().some(l => l.includes('ghost repository row'))).toBe(false);
  });
});

describe('startup reclamation keeps its hands off everything else (Issue #2165)', () => {
  it('leaves a vanished repository that still owns history alone', async () => {
    const db = h.db.current;
    const ghost = missingPath('gone-but-remembered');
    const row = createRepository(db, {
      name: 'gone-but-remembered',
      path: ghost,
      cloneSource: 'local',
    });
    upsertWorktree(db, worktree('wt-remembered', ghost, 'main'));
    createMessage(db, {
      worktreeId: 'wt-remembered',
      role: 'user',
      content: 'said before the directory went away',
      timestamp: new Date(1_700_000_000_000),
      messageType: 'normal',
    });

    await startServer();

    expect(getRepositoryById(db, row.id)!.enabled).toBe(true);
    expect(getMessages(db, 'wt-remembered')).toHaveLength(1);
  });

  it('leaves a WORKTREE_REPOS path alone even when its directory is gone', async () => {
    const db = h.db.current;
    const ghost = missingPath('env-listed');
    h.envRepoPaths.current = [ghost];
    const row = createRepository(db, {
      name: 'env-listed',
      path: ghost,
      cloneSource: 'local',
      isEnvManaged: true,
    });

    await startServer();

    expect(getRepositoryById(db, row.id)!.enabled).toBe(true);
    expect(scannedPaths()).toEqual([ghost]);
  });
});

// ============================================================================
// Reclamation is a tidy-up pass; it must never cost the cycle its real work
// ============================================================================

describe('a failing reclamation does not take the startup cycle with it (Issue #2165)', () => {
  it('still scans and still syncs when reclamation throws', async () => {
    // The three reconcilers `initializeWorktrees()` runs before this one are
    // each wrapped in their own try/catch so one failure cannot cancel the
    // others. Reclamation is wrapped the same way: leaning on the outer catch
    // instead would abort the repository scan and the worktree sync below it.
    const db = h.db.current;
    const live = makeRepoDir('live');
    createRepository(db, { name: 'live', path: live, cloneSource: 'local' });
    h.worktreesByRepo.current.set(live, [worktree('wt-live', live, 'main')]);

    h.reclaimError.current = new Error('reclaim exploded');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await startServer();

      const errors = errorSpy.mock.calls.map(args => args.map(String).join(' '));
      // Reported at the reclamation's own boundary...
      expect(errors.some(l => l.includes('Error reclaiming ghost repository rows'))).toBe(true);
      // ...and NOT at the outer one, which is what aborting would look like.
      expect(errors.some(l => l.includes('Error initializing worktrees'))).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }

    // The scan ran, and its result reached the database through the sync.
    expect(h.scanCalls).toHaveLength(1);
    expect(scannedPaths()).toEqual([live]);
    expect(getWorktrees(db, live).map(w => w.id)).toEqual(['wt-live']);
  });

  it('leaves the ghost row alone when reclamation throws — no half-applied state', async () => {
    const db = h.db.current;
    const ghost = missingPath('gone');
    const ghostRow = createRepository(db, { name: 'gone', path: ghost, cloneSource: 'local' });

    h.reclaimError.current = new Error('reclaim exploded');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await startServer();
    } finally {
      errorSpy.mockRestore();
    }

    expect(getRepositoryById(db, ghostRow.id)!.enabled).toBe(true);
    // Still enabled, so it is still in the scan set — the next boot retries.
    expect(scannedPaths()).toEqual([ghost]);
  });
});
