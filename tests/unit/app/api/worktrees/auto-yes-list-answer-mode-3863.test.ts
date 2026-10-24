/**
 * `GET /api/worktrees` carries each armed instance's Auto-Yes answer mode
 * (Issue #3863), so a `/sessions` tile can label its toggle and restore the
 * mode on a re-read, as the worktree screen does.
 *
 * Beside `autoYesByInstance` rather than in it (its `{ enabled, expiresAt }`
 * entries are pinned, #2512), and omitted from a row with nothing armed so
 * that row is the shape it was. Over a real in-memory SQLite and the real
 * Auto-Yes map.
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
  getEnabledAutoYesAnswerModeByWorktree,
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

const WT_A = 'wt-3863-a';
const WT_B = 'wt-3863-b';
const HOUR_MS = 3_600_000;

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

describe('[#3863] GET /api/worktrees autoYesAnswerModeByInstance', () => {
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
  ])('names each armed instance’s mode, only on its own row (%s)', async (_label, query) => {
    setAutoYesEnabled(WT_A, 'claude', true, HOUR_MS, undefined, undefined, 'careful');
    setAutoYesEnabled(WT_A, 'claude', true, HOUR_MS, undefined, 'claude-2');

    const rows = await listRows(query);

    expect(rows.get(WT_A)?.autoYesAnswerModeByInstance).toEqual({ claude: 'careful', 'claude-2': 'recommended' });
    expect(rows.get(WT_B)).not.toHaveProperty('autoYesAnswerModeByInstance');
  });

  it('leaves the key off a row with nothing armed (the row is the shape it was)', async () => {
    const rows = await listRows();

    expect(rows.get(WT_A)).not.toHaveProperty('autoYesAnswerModeByInstance');
    expect(rows.get(WT_A)?.autoYesByInstance).toEqual({});
  });

  it('leaves a turned-off instance out, and keeps the armed entries’ shape', async () => {
    setAutoYesEnabled(WT_A, 'claude', true, HOUR_MS, undefined, undefined, 'careful');
    setAutoYesEnabled(WT_A, 'claude', true, HOUR_MS, undefined, 'claude-2', 'careful');
    setAutoYesEnabled(WT_A, 'claude', false, undefined, undefined, 'claude-2');

    const rows = await listRows();

    expect(rows.get(WT_A)?.autoYesAnswerModeByInstance).toEqual({ claude: 'careful' });
    expect(Object.keys(rows.get(WT_A)?.autoYesByInstance?.claude ?? {}).sort()).toEqual(['enabled', 'expiresAt']);
  });

  it('follows a change of mode (another tab turned it on again in a new mode)', async () => {
    setAutoYesEnabled(WT_A, 'claude', true, HOUR_MS, undefined, undefined, 'careful');
    expect((await listRows()).get(WT_A)?.autoYesAnswerModeByInstance).toEqual({ claude: 'careful' });

    setAutoYesEnabled(WT_A, 'claude', true, HOUR_MS, undefined, undefined, 'recommended');
    expect((await listRows()).get(WT_A)?.autoYesAnswerModeByInstance).toEqual({ claude: 'recommended' });
  });

  it('drops an expired arming at read time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
    setAutoYesEnabled(WT_A, 'claude', true, HOUR_MS, undefined, undefined, 'careful');
    vi.setSystemTime(new Date('2026-10-24T01:00:00Z'));

    const rows = await listRows('?includeStatus=0');

    expect(rows.get(WT_A)).not.toHaveProperty('autoYesAnswerModeByInstance');
  });
});

describe('[#3863] getEnabledAutoYesAnswerModeByWorktree', () => {
  beforeEach(() => clearAllAutoYesStates());
  afterEach(() => clearAllAutoYesStates());

  it('groups every armed instance’s mode by worktree', () => {
    setAutoYesEnabled('wt-a', 'claude', true, HOUR_MS, undefined, undefined, 'careful');
    setAutoYesEnabled('wt-b', 'codex', true, HOUR_MS, undefined, 'codex-2');
    setAutoYesEnabled('wt-c', 'claude', true, HOUR_MS, undefined, undefined, 'careful');
    setAutoYesEnabled('wt-c', 'claude', false);

    expect(Object.fromEntries(getEnabledAutoYesAnswerModeByWorktree())).toEqual({
      'wt-a': { claude: 'careful' },
      'wt-b': { 'codex-2': 'recommended' },
    });
  });

  it('is empty when nothing is armed', () => {
    expect(getEnabledAutoYesAnswerModeByWorktree().size).toBe(0);
  });
});
