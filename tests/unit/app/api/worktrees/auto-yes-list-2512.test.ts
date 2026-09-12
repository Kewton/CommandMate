/**
 * `GET /api/worktrees` carries each row's armed Auto-Yes (Issue #2512).
 *
 * Method b of the Issue: the `/sessions` tiles read their toggle from the list
 * every client already polls, instead of each tile asking
 * `GET /api/worktrees/:id/auto-yes`. What the list promises, pinned here over a
 * real in-memory SQLite and the real Auto-Yes map:
 *
 *  - `autoYesByInstance` is per INSTANCE (#896) — a primary and an alias of the
 *    same tool are two entries, and one worktree's arming never shows on another;
 *  - it is `{}` rather than absent when nothing is armed, on BOTH the status
 *    path and `?includeStatus=0` (it is server memory, not a tmux reading);
 *  - a disabled or expired arming is absent, and the expiry is resolved at read
 *    time exactly as `GET /auto-yes` resolves it — the two routes agree;
 *  - the values are the ones `POST /auto-yes` stored.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import {
  clearAllAutoYesStates,
  getAutoYesState,
  getEnabledAutoYesByWorktree,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';
import type { Worktree } from '@/types/models';
import type { NextRequest } from 'next/server';

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
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

// No tmux on the machine running the suite is consulted: every session reads
// as not running, which is all the status half needs to complete.
vi.mock('@/lib/tmux/tmux', () => ({ listSessions: vi.fn(async () => []) }));

import { GET as getWorktrees } from '@/app/api/worktrees/route';
import { GET as getAutoYes } from '@/app/api/worktrees/[id]/auto-yes/route';

const WT_A = 'wt-2512-a';
const WT_B = 'wt-2512-b';
const HOUR_MS = 3_600_000;
const THREE_HOURS_MS = 10_800_000;

/** The list route reads `request.nextUrl.searchParams`, so hand it one. */
function listRequest(query = ''): NextRequest {
  const url = new URL(`http://localhost:3000/api/worktrees${query}`);
  const request = new Request(url) as unknown as NextRequest;
  Object.defineProperty(request, 'nextUrl', { value: url, configurable: true });
  return request;
}

async function listRows(query = ''): Promise<Map<string, Worktree>> {
  const response = await getWorktrees(listRequest(query));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { worktrees: Worktree[] };
  return new Map(body.worktrees.map((row) => [row.id, row]));
}

function seed(db: Database.Database, id: string): void {
  upsertWorktree(db, {
    id,
    name: id,
    path: `/tmp/${id}`,
    repositoryPath: '/tmp/repo',
    repositoryName: 'repo',
    cliToolId: 'claude',
  } as Worktree);
}

describe('GET /api/worktrees autoYesByInstance (Issue #2512)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    clearAllAutoYesStates();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    seed(db, WT_A);
    seed(db, WT_B);
    setAgentInstances(db, WT_A, [
      { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
      { id: 'claude-2', cliTool: 'claude', alias: '実装担当', order: 1 },
    ]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    clearAllAutoYesStates();
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
  });

  it.each([
    ['the status path', ''],
    ['?includeStatus=0', '?includeStatus=0'],
  ])('is {} on every row when nothing is armed (%s)', async (_label, query) => {
    const rows = await listRows(query);

    expect(rows.get(WT_A)?.autoYesByInstance).toEqual({});
    expect(rows.get(WT_B)?.autoYesByInstance).toEqual({});
  });

  it.each([
    ['the status path', ''],
    ['?includeStatus=0', '?includeStatus=0'],
  ])('carries each armed instance with the stored expiry, and only on its own row (%s)', async (_label, query) => {
    const primary = setAutoYesEnabled(WT_A, 'claude', true, HOUR_MS);
    const alias = setAutoYesEnabled(WT_A, 'claude', true, THREE_HOURS_MS, undefined, 'claude-2');

    const rows = await listRows(query);

    expect(rows.get(WT_A)?.autoYesByInstance).toEqual({
      claude: { enabled: true, expiresAt: primary.expiresAt },
      'claude-2': { enabled: true, expiresAt: alias.expiresAt },
    });
    expect(rows.get(WT_B)?.autoYesByInstance).toEqual({});
  });

  it('leaves a turned-off instance out', async () => {
    setAutoYesEnabled(WT_A, 'claude', true, HOUR_MS);
    setAutoYesEnabled(WT_A, 'claude', true, HOUR_MS, undefined, 'claude-2');
    setAutoYesEnabled(WT_A, 'claude', false, undefined, undefined, 'claude-2');

    const rows = await listRows();

    expect(Object.keys(rows.get(WT_A)?.autoYesByInstance ?? {})).toEqual(['claude']);
  });

  it('resolves an expired arming to off at read time, as GET /auto-yes does', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    setAutoYesEnabled(WT_A, 'claude', true, HOUR_MS);
    vi.setSystemTime(new Date('2026-09-13T01:00:00Z'));

    const rows = await listRows('?includeStatus=0');

    expect(rows.get(WT_A)?.autoYesByInstance).toEqual({});
    // The read disabled it, with the reason the single-worktree route records.
    expect(getAutoYesState(WT_A, 'claude')).toMatchObject({ enabled: false, stopReason: 'expired' });
  });

  it('agrees with GET /api/worktrees/:id/auto-yes, instance for instance', async () => {
    setAutoYesEnabled(WT_A, 'claude', true, HOUR_MS);
    setAutoYesEnabled(WT_A, 'claude', true, THREE_HOURS_MS, undefined, 'claude-2');

    const rows = await listRows();
    const single = await getAutoYes(
      new Request(`http://localhost:3000/api/worktrees/${WT_A}/auto-yes`) as unknown as NextRequest,
      { params: Promise.resolve({ id: WT_A }) },
    );
    const { instances } = (await single.json()) as {
      instances: Record<string, { enabled: boolean; expiresAt: number | null }>;
    };

    expect(rows.get(WT_A)?.autoYesByInstance).toEqual({
      claude: { enabled: instances.claude.enabled, expiresAt: instances.claude.expiresAt },
      'claude-2': { enabled: instances['claude-2'].enabled, expiresAt: instances['claude-2'].expiresAt },
    });
  });
});

describe('getEnabledAutoYesByWorktree (Issue #2512)', () => {
  beforeEach(() => clearAllAutoYesStates());
  afterEach(() => {
    vi.useRealTimers();
    clearAllAutoYesStates();
  });

  it('groups every enabled state by worktree and instance in one pass', () => {
    const a = setAutoYesEnabled('wt-a', 'claude', true, HOUR_MS);
    const b = setAutoYesEnabled('wt-b', 'codex', true, HOUR_MS, undefined, 'codex-2');
    setAutoYesEnabled('wt-c', 'claude', true, HOUR_MS);
    setAutoYesEnabled('wt-c', 'claude', false);

    const byWorktree = getEnabledAutoYesByWorktree();

    expect(Object.fromEntries(byWorktree)).toEqual({
      'wt-a': { claude: { enabled: true, expiresAt: a.expiresAt } },
      'wt-b': { 'codex-2': { enabled: true, expiresAt: b.expiresAt } },
    });
  });

  it('is empty when nothing is armed', () => {
    expect(getEnabledAutoYesByWorktree().size).toBe(0);
  });
});
