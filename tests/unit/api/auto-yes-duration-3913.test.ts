/**
 * `POST .../auto-yes` accepts 1〜24 whole hours (Issue #3913).
 *
 * - Every whole hour from 1 to 24 is accepted and `expiresAt = now + duration`.
 * - Anything else (0, negative, 25h, 1.5h, 1 ms off, NaN-ish JSON, ±Infinity
 *   overflow, null, boolean, array, object, numeric string) is a 400 that
 *   writes no state and starts no poller.
 * - Omitted is 1h; disabling ignores `duration` as before.
 *
 * Real SQLite (in memory) and real Auto-Yes state; the poller entry points are
 * spied so no poller timer runs. Harness copied from
 * `auto-yes-restart-reason-3730.test.ts`.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
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
      mockDb?.close();
      mockDb = null;
    },
  };
});

vi.mock('@/lib/tmux/tmux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux')>();
  return { ...actual, listSessions: vi.fn(async () => []), hasSession: vi.fn(async () => false) };
});

/** The ownership check the enable awaits; each test decides when it answers. */
const checkSessionOwnership = vi.fn();
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>();
  return { ...actual, checkSessionOwnership: (...args: unknown[]) => checkSessionOwnership(...args) };
});

vi.mock('@/lib/polling/auto-yes-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/polling/auto-yes-manager')>();
  return {
    ...actual,
    startAutoYesPolling: vi.fn(() => ({ started: true })),
    stopAutoYesPolling: vi.fn(),
    stopAutoYesPollingByWorktree: vi.fn(),
  };
});

vi.mock('@/lib/hooks/pending-decision-recheck', () => ({
  recheckPendingDecisions: vi.fn(async () => ({ examined: 0, delivered: 0, skipped: 0, reason: 'no-pending' })),
}));

import { POST } from '@/app/api/worktrees/[id]/auto-yes/route';
import { startAutoYesPolling, stopAutoYesPolling } from '@/lib/polling/auto-yes-manager';
import { clearAllAutoYesStates, getAutoYesState, resetAutoYesShutdownForTesting, setAutoYesEnabled } from '@/lib/auto-yes-state';

const WT = 'wt-3913-route';
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

function postRaw(raw: string): Promise<Response> {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WT}/auto-yes`, {
    method: 'POST',
    body: raw,
  });
  return POST(request, { params: Promise.resolve({ id: WT }) }) as Promise<Response>;
}

function post(body: unknown): Promise<Response> {
  return postRaw(JSON.stringify(body));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  upsertWorktree(db, {
    id: WT,
    name: WT,
    path: `/tmp/${WT}`,
    repositoryPath: '/tmp/repo',
    repositoryName: 'repo',
    cliToolId: 'claude',
  } as Worktree);
  setAgentInstances(db, WT, [
    { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
    { id: 'claude-2', cliTool: 'claude', alias: '', order: 1 },
  ]);
  clearAllAutoYesStates();
  resetAutoYesShutdownForTesting();
  vi.clearAllMocks();
  checkSessionOwnership.mockResolvedValue({ verdict: 'absent', sessionPath: null });
});

afterEach(async () => {
  clearAllAutoYesStates();
  resetAutoYesShutdownForTesting();
  vi.useRealTimers();
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
});

describe('[#3913] POST auto-yes duration', () => {
  it.each(Array.from({ length: 24 }, (_, i) => i + 1))('accepts %ih and sets expiresAt = now + duration', async (hours) => {
    const response = await post({ enabled: true, cliToolId: 'claude', duration: hours * HOUR });

    expect(response.status).toBe(200);
    expect((await response.json()).expiresAt).toBe(NOW + hours * HOUR);
    expect(getAutoYesState(WT, 'claude')).toMatchObject({ enabled: true, enabledAt: NOW, expiresAt: NOW + hours * HOUR });
    expect(startAutoYesPolling).toHaveBeenCalledTimes(1);
  });

  it('defaults to 1h when duration is omitted (negative control)', async () => {
    const response = await post({ enabled: true, cliToolId: 'claude' });

    expect(response.status).toBe(200);
    expect(getAutoYesState(WT, 'claude')?.expiresAt).toBe(NOW + HOUR);
  });

  const INVALID: Array<[string, unknown]> = [
    ['0', 0],
    ['negative', -HOUR],
    ['25h', 25 * HOUR],
    ['1.5h', 1.5 * HOUR],
    ['1 ms over 1h', HOUR + 1],
    ['1 ms short of 24h', 24 * HOUR - 1],
    ['null', null],
    ['boolean', true],
    ['array', [HOUR]],
    ['object', { hours: 1 }],
    ['numeric string', '3600000'],
  ];

  it.each(INVALID)('rejects %s with 400, no state and no poller', async (_label, duration) => {
    const response = await post({ enabled: true, cliToolId: 'claude', duration });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('1-24 hours');
    expect(getAutoYesState(WT, 'claude')).toBeNull();
    expect(startAutoYesPolling).not.toHaveBeenCalled();
  });

  it('rejects a JSON number that overflows to Infinity (1e999)', async () => {
    const response = await postRaw('{"enabled":true,"cliToolId":"claude","duration":1e999}');

    expect(response.status).toBe(400);
    expect(getAutoYesState(WT, 'claude')).toBeNull();
    expect(startAutoYesPolling).not.toHaveBeenCalled();
  });

  it('leaves a live grant untouched when an invalid enable is refused', async () => {
    setAutoYesEnabled(WT, 'claude', true, 18_000_000);
    const before = getAutoYesState(WT, 'claude');

    const response = await post({ enabled: true, cliToolId: 'claude', duration: 25 * HOUR });

    expect(response.status).toBe(400);
    expect(getAutoYesState(WT, 'claude')).toEqual(before);
  });

  it.each(INVALID)('disabling ignores a %s duration as before', async (_label, duration) => {
    setAutoYesEnabled(WT, 'claude', true, 86_400_000);

    const response = await post({ enabled: false, cliToolId: 'claude', duration });

    expect(response.status).toBe(200);
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(false);
    expect(stopAutoYesPolling).toHaveBeenCalledTimes(1);
  });

  it('a 24h grant on one instance leaves the other instance alone', async () => {
    setAutoYesEnabled(WT, 'claude', true, 10_800_000, undefined, 'claude-2');

    const response = await post({ enabled: true, cliToolId: 'claude', instanceId: 'claude', duration: 24 * HOUR });

    expect(response.status).toBe(200);
    expect(getAutoYesState(WT, 'claude', 'claude')?.expiresAt).toBe(NOW + 24 * HOUR);
    expect(getAutoYesState(WT, 'claude', 'claude-2')?.expiresAt).toBe(NOW + 3 * HOUR);
  });
});
