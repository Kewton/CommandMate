/**
 * The auto-yes routes and the server restart (Issue #3730).
 *
 * - The single-worktree `GET .../auto-yes` (both the `?cliToolId` answer and
 *   the per-instance map `commandmate instances` and the browser read) and the
 *   worktree list say `server-restart` for an instance the last restart
 *   released — and nothing for any other disabled instance.
 * - An enable that is still awaiting its ownership check when the shutdown
 *   begins is refused once it returns, so it can never become a grant the
 *   shutdown record did not see.
 * - A manual disable stops the poller with `manual`.
 *
 * Real SQLite (in memory) and real Auto-Yes state; the poller entry points are
 * spied so no poller timer runs.
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

import { GET, POST } from '@/app/api/worktrees/[id]/auto-yes/route';
import { GET as getWorktrees } from '@/app/api/worktrees/route';
import {
  startAutoYesPolling,
  stopAutoYesPolling,
  stopAutoYesPollingByWorktree,
} from '@/lib/polling/auto-yes-manager';
import {
  clearAllAutoYesStates,
  getAutoYesState,
  resetAutoYesShutdownForTesting,
  seedServerRestartNotice,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';
import { recordAutoYesShutdown } from '@/lib/auto-yes-shutdown-record';

const WT = 'wt-3730-route';
const HOUR = 3_600_000;

function post(body: unknown): Promise<Response> {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WT}/auto-yes`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id: WT }) }) as Promise<Response>;
}

function get(query = ''): Promise<Response> {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WT}/auto-yes${query}`);
  return GET(request, { params: Promise.resolve({ id: WT }) }) as Promise<Response>;
}

async function listRow(): Promise<Record<string, unknown>> {
  const url = new URL('http://localhost:3000/api/worktrees?includeStatus=0');
  const request = new Request(url) as unknown as Parameters<typeof getWorktrees>[0];
  Object.defineProperty(request, 'nextUrl', { value: url, configurable: true });
  const body = (await (await getWorktrees(request)).json()) as { worktrees: Array<Record<string, unknown>> };
  return body.worktrees.find((row) => row.id === WT)!;
}

/** What the next process holds after a restart released the primary claude grant. */
function seedRestartNotice(instanceId = 'claude'): void {
  expect(
    seedServerRestartNotice({
      worktreeId: WT,
      cliToolId: 'claude',
      instanceId,
      enabledAt: Date.now() - 60_000,
      expiresAt: Date.now() + HOUR,
    }),
  ).toBe(true);
}

let recordDir: string;

beforeEach(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  recordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-yes-route-3730-'));
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
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  const fs = await import('node:fs');
  fs.rmSync(recordDir, { recursive: true, force: true });
});

describe('GET reports the restart release (Issue #3730)', () => {
  it('the ?cliToolId answer and the per-instance map carry stopReason: server-restart', async () => {
    seedRestartNotice('claude-2');

    const single = await (await get('?cliToolId=claude&instanceId=claude-2')).json();
    expect(single).toMatchObject({ enabled: false, expiresAt: null, stopReason: 'server-restart' });

    const map = await (await get()).json();
    expect(map.instances['claude-2']).toEqual({ enabled: false, expiresAt: null, stopReason: 'server-restart' });
  });

  it('negative control: a manually disabled instance answers exactly the shape it did', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    setAutoYesEnabled(WT, 'claude', false);

    const single = await (await get('?cliToolId=claude')).json();
    expect(single).not.toHaveProperty('stopReason');
    const map = await (await get()).json();
    expect(map.instances.claude).toEqual({ enabled: false, expiresAt: null });
  });

  it('the worktree list names it beside autoYesByInstance, not in it', async () => {
    seedRestartNotice('claude-2');
    setAutoYesEnabled(WT, 'claude', true);

    const row = await listRow();
    expect(Object.keys(row.autoYesByInstance as object)).toEqual(['claude']);
    expect(row.autoYesStopReasonByInstance).toEqual({ 'claude-2': 'server-restart' });
  });

  it('negative control: a row with no restart release has no such key', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    setAutoYesEnabled(WT, 'claude', false);
    expect(await listRow()).not.toHaveProperty('autoYesStopReasonByInstance');
  });

  it('re-enabling clears it on every surface', async () => {
    seedRestartNotice();
    const response = await post({ enabled: true, cliToolId: 'claude' });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('stopReason');
    expect((await (await get()).json()).instances.claude).not.toHaveProperty('stopReason');
    expect(await listRow()).not.toHaveProperty('autoYesStopReasonByInstance');
  });
});

describe('the shutdown boundary (Issue #3730)', () => {
  it('positive: an enable still awaiting ownership when the shutdown begins is refused with 503', async () => {
    let answer!: (value: unknown) => void;
    checkSessionOwnership.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));

    const pending = post({ enabled: true, cliToolId: 'claude' });
    await vi.waitFor(() => expect(checkSessionOwnership).toHaveBeenCalled());
    const recordPath = `${recordDir}/cm.db.auto-yes-shutdown.json`;
    recordAutoYesShutdown({ path: recordPath });
    answer({ verdict: 'absent', sessionPath: null });

    const response = await pending;
    expect(response.status).toBe(503);
    expect(getAutoYesState(WT, 'claude')).toBeNull();
    expect(startAutoYesPolling).not.toHaveBeenCalled();
  });

  it('negative: an enable that completed before the shutdown is recorded', async () => {
    const response = await post({ enabled: true, cliToolId: 'claude' });
    expect(response.status).toBe(200);
    const recordPath = `${recordDir}/cm.db.auto-yes-shutdown.json`;
    expect(recordAutoYesShutdown({ path: recordPath })).toEqual({ recorded: 1 });
  });

  it('a disable is still answered during the shutdown (it withdraws, never adds)', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    recordAutoYesShutdown({ path: `${recordDir}/cm.db.auto-yes-shutdown.json` });
    const response = await post({ enabled: false, cliToolId: 'claude' });
    expect(response.status).toBe(200);
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(false);
  });
});

describe('a manual disable stops the poller with `manual` (Issue #3730)', () => {
  it('one instance', async () => {
    await post({ enabled: false, cliToolId: 'claude', instanceId: 'claude-2' });
    expect(stopAutoYesPolling).toHaveBeenCalledWith(`${WT}:claude:claude-2`, 'manual');
  });

  it('one tool', async () => {
    await post({ enabled: false, cliToolId: 'claude' });
    expect(stopAutoYesPolling).toHaveBeenCalledWith(`${WT}:claude`, 'manual');
  });

  it('every agent of the worktree (partial answers kept, as #3713)', async () => {
    await post({ enabled: false });
    expect(stopAutoYesPollingByWorktree).toHaveBeenCalledWith(WT, { keepPartialAnswers: true, reason: 'manual' });
  });
});
