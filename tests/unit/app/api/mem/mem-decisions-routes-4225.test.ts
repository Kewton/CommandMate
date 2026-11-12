/**
 * The promote routes as Next calls them (Issue #4225, design §4.2): every write route
 * answers 403 `screen_only` without the screen's mark (and writes nothing), the list
 * needs a branch, and a body that is not an object is refused. gh is never reached.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';

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
  };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));
vi.mock('child_process', async (original) => {
  const actual = await original<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn(() => {
      throw new Error('gh must not be reached');
    }),
  };
});

import { setMockDb } from '@/lib/db/db-instance';
import { GET as getDecisions } from '@/app/api/repositories/[id]/mem/decisions/route';
import { POST as postPreview } from '@/app/api/repositories/[id]/mem/decisions/[itemId]/preview/route';
import { POST as postApprove } from '@/app/api/repositories/[id]/mem/decisions/[itemId]/approve/route';
import { POST as postConfirm } from '@/app/api/repositories/[id]/mem/decisions/[itemId]/confirm-reflected/route';
import { POST as postReconcile } from '@/app/api/repositories/[id]/mem/decisions/operations/[opId]/reconcile/route';
import { POST as postAbandon } from '@/app/api/repositories/[id]/mem/decisions/operations/[opId]/abandon/route';
import { POST as postAcceptFound } from '@/app/api/repositories/[id]/mem/decisions/operations/[opId]/accept-found/route';
import { POST as postSettle } from '@/app/api/repositories/[id]/mem/decisions/operations/[opId]/settle-transition/route';

let db: Database.Database;

function req(url: string, init: RequestInit = {}): NextRequest {
  const request = new Request(url, init) as unknown as NextRequest;
  Object.defineProperty(request, 'nextUrl', { value: new URL(url), configurable: true });
  return request;
}
const post = (body: unknown) => req('http://localhost:3000/api/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const itemParams = { params: Promise.resolve({ id: 'r', itemId: 'i' }) };
const opParams = { params: Promise.resolve({ id: 'r', opId: 'o' }) };

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  setMockDb(db);
});
afterEach(() => db.close());

const promoteRows = () =>
  (db.prepare('SELECT (SELECT COUNT(*) FROM mem_promote_previews) + (SELECT COUNT(*) FROM mem_promote_operations) AS n').get() as { n: number }).n;

describe('the promote routes', () => {
  it.each([
    ['preview', () => postPreview(post({ worktreeId: 'w' }), itemParams)],
    ['approve', () => postApprove(post({ previewId: 'p' }), itemParams)],
    ['confirm-reflected', () => postConfirm(post({ worktreeId: 'w', ifVersion: 1 }), itemParams)],
    ['reconcile', () => postReconcile(post({}), opParams)],
    ['abandon', () => postAbandon(post({ ifState: 'unknown' }), opParams)],
    ['accept-found', () => postAcceptFound(post({ ifState: 'unknown', ifReason: 'body_differs' }), opParams)],
    ['settle-transition', () => postSettle(post({ worktreeId: 'w', ifVersion: 1 }), opParams)],
  ])('%s without the screen mark → 403 screen_only, nothing written', async (_name, call) => {
    const response = await call();
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('screen_only');
    expect(promoteRows()).toBe(0);
  });

  it('the list needs a branch', async () => {
    const response = await getDecisions(req('http://localhost:3000/api/repositories/r/mem/decisions'), { params: Promise.resolve({ id: 'r' }) });
    expect(response.status).toBe(400);
  });

  it('a body that is not an object is refused', async () => {
    const response = await postApprove(req('http://localhost:3000/api/x', { method: 'POST', body: '[1]' }), itemParams);
    expect(response.status).toBe(400);
  });
});
