/**
 * `kill-session` は成功した kill を session-kill ledger に書く（Issue #3993）。
 *
 * env-clean は、隣の worktree のセッションが消えたとき、この記録で「ワーカー以外が止めた」を
 * 見分ける。UI（同一オリジンのブラウザ要求）は `browser`、それ以外（CLI の POST・curl）は
 * 呼び出し元を名乗らない `http`。kill が起きなかった要求は何も書かない（陰性）。
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

vi.mock('@/lib/tmux/tmux', () => ({
  killSession: vi.fn(() => Promise.resolve(true)),
  hasSession: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@/lib/ws-server', () => ({ broadcast: vi.fn() }));

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
    setMockDb: (db: Database.Database) => { mockDb = db; },
    closeDbInstance: () => { mockDb?.close(); mockDb = null; },
  };
});

import { POST } from '@/app/api/worktrees/[id]/kill-session/route';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import { readSessionKillRecords, SESSION_KILL_LEDGER_ROOT_ENV } from '@/lib/verification/session-kill-ledger';

const WT = 'wt-ledger';

function call(query: string, headers: Record<string, string> = {}) {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${WT}/kill-session${query}`,
    { method: 'POST', headers }
  );
  return POST(request, { params: Promise.resolve({ id: WT }) });
}

function setRunning(running: boolean): void {
  const manager = CLIToolManager.getInstance();
  for (const tool of CLI_TOOL_IDS) {
    const impl = manager.getTool(tool);
    vi.spyOn(impl, 'isRunning').mockImplementation(async () => running);
    vi.spyOn(impl, 'killSession').mockImplementation(async () => {});
  }
}

describe('POST /api/worktrees/:id/kill-session — session-kill ledger (Issue #3993)', () => {
  let db: Database.Database;
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cm-kill-session-ledger-3993-'));
    vi.stubEnv(SESSION_KILL_LEDGER_ROOT_ENV, root);
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    const worktree: Worktree = {
      id: WT,
      name: 'Ledger',
      path: `/path/to/${WT}`,
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const recorded = () => readSessionKillRecords(0, Date.now() + 1000, root);

  it('records a UI kill as `browser` (same-origin browser request)', async () => {
    setRunning(true);
    const before = Date.now();
    const response = await call('?instance=claude', { 'sec-fetch-site': 'same-origin' });

    expect(response.status).toBe(200);
    const records = recorded();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      version: 1,
      api: 'kill-session',
      origin: 'browser',
      worktreeId: WT,
      instanceId: 'claude',
      callerCwd: null,
      callerSession: null,
    });
    expect(records[0].at).toBeGreaterThanOrEqual(before);
  });

  it('records any other request as `http` with no caller (the CLI POST, curl)', async () => {
    setRunning(true);
    // undici's fetch (the CLI) sends sec-fetch-mode but never sec-fetch-site.
    expect((await call('', { 'sec-fetch-mode': 'cors' })).status).toBe(200);
    expect((await call('?cliTool=codex', { 'sec-fetch-site': 'cross-site' })).status).toBe(200);

    expect(recorded().map((r) => [r.origin, r.instanceId, r.callerCwd])).toEqual([
      ['http', null, null],
      ['http', null, null],
    ]);
  });

  it('records the exact tmux session names it stopped (its `killedSessions`)', async () => {
    setRunning(true);
    const response = await call('?instance=claude');
    const body = await response.json();

    expect(body.killedSessions.length).toBeGreaterThan(0);
    expect(recorded().map((r) => r.sessionNames)).toEqual([body.killedSessions]);
  });

  it('records nothing when no session was running (negative)', async () => {
    setRunning(false);
    const response = await call('?instance=claude', { 'sec-fetch-site': 'same-origin' });

    expect(response.status).toBe(404);
    expect(recorded()).toEqual([]);
  });

  it('records nothing when every kill failed (negative)', async () => {
    setRunning(true);
    for (const tool of CLI_TOOL_IDS) {
      vi.spyOn(CLIToolManager.getInstance().getTool(tool), 'killSession').mockRejectedValue(new Error('boom'));
    }
    const response = await call('?instance=claude', { 'sec-fetch-site': 'same-origin' });

    expect(response.status).toBe(500);
    expect(recorded()).toEqual([]);
  });
});
