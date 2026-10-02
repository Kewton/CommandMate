/**
 * POST /api/repositories/sync with nothing registered (Issue #3093).
 *
 * The 400 used to tell the reader to set CM_ROOT_DIR — a variable the sync
 * never reads — so a first-time user who already had it set was sent the wrong
 * way. The wording must name the ways a repository actually gets registered.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let testDb: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => testDb,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/session-cleanup', () => ({
  syncWorktreesAndCleanup: vi.fn(),
}));

import { POST } from '@/app/api/repositories/sync/route';

describe('POST /api/repositories/sync — no repositories registered (#3093)', () => {
  const savedRepos = process.env.WORKTREE_REPOS;
  const savedRoot = process.env.CM_ROOT_DIR;

  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
    delete process.env.WORKTREE_REPOS;
    // The reported case: CM_ROOT_DIR is set, and still nothing is registered.
    process.env.CM_ROOT_DIR = '/tmp/some-root';
  });

  afterEach(() => {
    testDb.close();
    if (savedRepos === undefined) delete process.env.WORKTREE_REPOS;
    else process.env.WORKTREE_REPOS = savedRepos;
    if (savedRoot === undefined) delete process.env.CM_ROOT_DIR;
    else process.env.CM_ROOT_DIR = savedRoot;
  });

  it('answers 400 with how to register a repository, not "set CM_ROOT_DIR"', async () => {
    const res = await POST();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('No repositories are registered yet');
    expect(body.error).toContain('Repositories → Add Repository');
    expect(body.error).toContain('WORKTREE_REPOS');
    expect(body.error).not.toContain('CM_ROOT_DIR');
  });
});
