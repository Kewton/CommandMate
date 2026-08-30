/**
 * `GET /api/worktrees` over a real SQLite database: the list without the status
 * (Issue #2060).
 *
 * The unit suite mocks the database and proves the route SKIPS the tmux work.
 * This one keeps the database real and answers the other half — what the list
 * half actually costs once the tmux half is gone — because "under 200ms" is a
 * claim about SQLite and JSON serialisation, and a mocked `getWorktrees` cannot
 * make it.
 *
 * The tmux module is mocked so the measurement is not competing with whatever
 * tmux sessions happen to exist on the machine running the suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => { mockDb = db; },
    closeDbInstance: () => { mockDb?.close(); mockDb = null; },
  };
});

const listSessions = vi.hoisted(() => vi.fn(async () => [] as Array<{ name: string }>));
vi.mock('@/lib/tmux/tmux', () => ({ listSessions }));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/worktrees/route';

/** The acceptance budget from Issue #2060 for the list-only response. */
const LIST_ONLY_BUDGET_MS = 200;

/** How many rows the measurement runs against. */
const SEEDED_WORKTREES = 60;

const STATUS_KEYS = [
  'sessionStatusByCli',
  'sessionStatusByInstance',
  'isSessionRunning',
  'isWaitingForResponse',
  'isProcessing',
] as const;

async function get(query = '') {
  const res = await GET(new NextRequest(new Request(`http://localhost:3000/api/worktrees${query}`)));
  return { res, body: await res.json() };
}

describe('[#2060] GET /api/worktrees list/status split over a real DB', () => {
  let db: Database.Database;

  beforeEach(async () => {
    listSessions.mockClear();
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    for (let i = 0; i < SEEDED_WORKTREES; i++) {
      const worktree: Worktree = {
        id: `wt-${i}`,
        name: `feature/branch-${i}`,
        path: `/path/to/wt-${i}`,
        repositoryPath: `/path/to/repo-${i % 5}`,
        repositoryName: `Repo${i % 5}`,
        description: `worktree number ${i}`,
        updatedAt: new Date(Date.now() - i * 1000),
      };
      upsertWorktree(db, worktree);
    }
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
  });

  it('answers the list-only request in well under the 200ms budget', async () => {
    // Warm the statement cache / page cache the way a running server's would be:
    // the budget is about the steady state, not about first-touch.
    await get('?includeStatus=0');

    const started = performance.now();
    const { res, body } = await get('?includeStatus=0');
    const elapsed = performance.now() - started;

    expect(res.status).toBe(200);
    expect(body.worktrees).toHaveLength(SEEDED_WORKTREES);
    expect(elapsed).toBeLessThan(LIST_ONLY_BUDGET_MS);
  });

  it('reaches that budget by NOT doing the tmux work, not by hiding it', async () => {
    // The deterministic half of the claim above. A timing assertion alone would
    // still pass on a route that computed the status and threw the keys away.
    await get('?includeStatus=0');
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('returns every row and every non-status field it always returned', async () => {
    const { body } = await get('?includeStatus=0');

    expect(body.worktrees).toHaveLength(SEEDED_WORKTREES);
    const row = body.worktrees[0];
    expect(row.id).toBe('wt-0');
    expect(row.name).toBe('feature/branch-0');
    expect(row.description).toBe('worktree number 0');
    expect(row.agentInstances).toBeInstanceOf(Array);
    for (const key of STATUS_KEYS) expect(row).not.toHaveProperty(key);
    expect(body.statusIncluded).toBe(false);
  });

  it('leaves the default call exactly as it was: status computed, no new key', async () => {
    const { res, body } = await get();

    expect(res.status).toBe(200);
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(Object.keys(body).sort()).toEqual(['repositories', 'worktrees']);
    for (const key of STATUS_KEYS) expect(body.worktrees[0]).toHaveProperty(key);
  });

  it('returns the same rows, in the same order, both ways', async () => {
    const full = await get();
    const listOnly = await get('?includeStatus=0');

    expect(listOnly.body.worktrees.map((w: { id: string }) => w.id))
      .toEqual(full.body.worktrees.map((w: { id: string }) => w.id));
    expect(listOnly.body.repositories).toEqual(full.body.repositories);

    // The list-only row is the full row minus exactly the status keys.
    const stripped = { ...full.body.worktrees[0] };
    for (const key of STATUS_KEYS) delete stripped[key];
    expect(listOnly.body.worktrees[0]).toEqual(stripped);
  });

  it('honours ?repository= alongside ?includeStatus=0', async () => {
    const { body } = await get('?repository=/path/to/repo-0&includeStatus=0');
    expect(body.worktrees.length).toBeGreaterThan(0);
    expect(body.worktrees.every((w: { repositoryPath: string }) => w.repositoryPath === '/path/to/repo-0')).toBe(true);
    expect(listSessions).not.toHaveBeenCalled();
  });
});
