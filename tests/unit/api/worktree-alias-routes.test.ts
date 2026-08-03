/**
 * Issue #1621 / #1644 Phase 2: an API request that names a worktree by a
 * HISTORICAL ID must behave exactly like one that names it by its current ID.
 *
 * The interesting failure mode is not the 404 — it is the half-fix. A route
 * resolves the worktree through one lookup and then keeps using the raw URL
 * segment for everything else: child tables (`getMessages(db, id)`), tmux
 * session names (`cliTool.getSessionName(id)`), poller and Auto-Yes keys, WS
 * broadcasts. Translating only the existence check turns a clean 404 into a
 * request that finds the worktree and then reads an empty history, or starts a
 * SECOND agent session under the retired name. So these tests assert on the
 * downstream data, not just on the status code.
 *
 * Real routes against a real in-memory SQLite database; only the DB singleton is
 * mocked, exactly as tests/integration/api-worktrees.test.ts does it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  upsertWorktree,
  createMessage,
  createMemo,
  recordWorktreeAlias,
} from '@/lib/db';
import { resolveWorktreeOr404, canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import type { NextRequest } from 'next/server';
import type { Worktree } from '@/types/models';

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      mockDb = null;
    },
  };
});

import { GET as getMessagesRoute } from '@/app/api/worktrees/[id]/messages/route';
import { GET as getMemosRoute } from '@/app/api/worktrees/[id]/memos/route';
import { PATCH as patchWorktreeRoute } from '@/app/api/worktrees/[id]/route';

/** The ID this worktree used to be called, before #1645 renumbers it. */
const OLD_ID = 'anvil-feature-1644-worktree-id';
/** The ID it answers to now (directory basename). */
const NEW_ID = 'commandmate-issue-1644';

const WORKTREE: Worktree = {
  id: NEW_ID,
  name: 'feature/1644-worktree-id',
  branch: 'feature/1644-worktree-id',
  path: '/repos/commandmate-issue-1644',
  repositoryPath: '/repos/commandmate',
  repositoryName: 'commandmate',
};

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function req(url: string): NextRequest {
  return new Request(url) as unknown as NextRequest;
}

describe('API routes accept a historical worktree ID', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    db.pragma('foreign_keys = ON');
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    upsertWorktree(db, WORKTREE);
    recordWorktreeAlias(db, OLD_ID, NEW_ID);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('returns the worktree’s messages, not an empty list, for the old ID', async () => {
    createMessage(db, {
      worktreeId: NEW_ID,
      role: 'user',
      content: 'still my history',
      timestamp: new Date(),
      messageType: 'normal',
    });

    const response = await getMessagesRoute(
      req(`http://localhost/api/worktrees/${OLD_ID}/messages`),
      params(OLD_ID)
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    // The whole point: a route that only translated the existence check would
    // answer 200 with `[]` here.
    expect(body).toHaveLength(1);
    expect(body[0].content).toBe('still my history');
  });

  it('returns the worktree’s memos for the old ID', async () => {
    createMemo(db, NEW_ID, { title: 'note', content: 'kept', position: 0 });

    const response = await getMemosRoute(
      req(`http://localhost/api/worktrees/${OLD_ID}/memos`),
      params(OLD_ID)
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.memos ?? body).toHaveLength(1);
  });

  it('writes through the old ID to the current row', async () => {
    const response = await patchWorktreeRoute(
      new Request(`http://localhost/api/worktrees/${OLD_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ description: 'set via the old id' }),
      }) as unknown as NextRequest,
      params(OLD_ID)
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    // The response reports the CURRENT identity, so a client that stores it
    // stops using the retired ID from here on.
    expect(body.id).toBe(NEW_ID);

    const row = db
      .prepare('SELECT description FROM worktrees WHERE id = ?')
      .get(NEW_ID) as { description: string };
    expect(row.description).toBe('set via the old id');
  });

  it('still 404s an ID that is neither live nor aliased, naming what was asked', async () => {
    const response = await getMessagesRoute(
      req('http://localhost/api/worktrees/never-existed/messages'),
      params('never-existed')
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toContain('never-existed');
  });

  it('leaves a malformed ID to the route’s own 400, unmodified', async () => {
    expect(canonicalWorktreeId('../etc/passwd')).toBe('../etc/passwd');
    expect(canonicalWorktreeId('')).toBe('');
  });
});

describe('resolveWorktreeOr404 accepts a historical worktree ID', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    db.pragma('foreign_keys = ON');
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    upsertWorktree(db, WORKTREE);
    recordWorktreeAlias(db, OLD_ID, NEW_ID);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('resolves the old ID and reports the CURRENT id on the worktree', () => {
    const resolved = resolveWorktreeOr404(OLD_ID);
    expect('id' in resolved).toBe(true);
    const worktree = resolved as Worktree;
    expect(worktree.id).toBe(NEW_ID);
    expect(worktree.path).toBe(WORKTREE.path);
  });

  it('keeps 400 for a malformed ID and 404 for an unknown one', async () => {
    const bad = resolveWorktreeOr404('not a valid id');
    expect('status' in bad && bad.status).toBe(400);

    const missing = resolveWorktreeOr404('never-existed');
    expect('status' in missing && missing.status).toBe(404);
  });
});

describe('canonicalWorktreeId degrades instead of throwing', () => {
  it('returns the requested ID when the database is unusable', async () => {
    const { setMockDb, closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    // getDbInstance now throws ('Mock database not initialized'). A route must
    // still be able to answer with its own 404 rather than a 500.
    expect(canonicalWorktreeId('some-id')).toBe('some-id');

    const db = new Database(':memory:');
    // A database with no worktree_aliases table at all (pre-v53 file).
    db.exec('CREATE TABLE worktrees (id TEXT PRIMARY KEY, path TEXT)');
    db.prepare('INSERT INTO worktrees (id, path) VALUES (?, ?)').run('live', '/p');
    setMockDb(db);
    expect(canonicalWorktreeId('live')).toBe('live');
    expect(canonicalWorktreeId('retired')).toBe('retired');
    closeDbInstance();
    db.close();
  });
});
