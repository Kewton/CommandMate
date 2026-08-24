/**
 * kill-session: roster-first resolution and refused contradictions (Issue #1925,
 * DR2-009).
 *
 * This route used to inline its own resolution:
 *
 *   (targetCliTool ?? null) ?? (known ? known.cliTool : null) ?? (isCliToolType(instanceParam) ? instanceParam : null)
 *
 * — the reverse of #1629's order, with an explicit `?cliTool` ahead of the
 * roster and no contradiction check. So `?instance=codex&cliTool=claude` on a
 * worktree whose roster calls `codex` a codex instance would look for
 * `mcbd-claude-<wt>-codex`, find nothing running, and answer "no active
 * sessions" — while the codex session it was asked about kept running.
 *
 * Since #1925 the shared resolver answers, which means the roster wins and the
 * contradiction is refused. Killing is destructive and irreversible from the
 * caller's side, so guessing which of the two declarations was meant is the one
 * thing this route must not do.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
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

const WORKTREE_ID = 'wt-kill';

/**
 * Session names the route asked the gateway to kill, in call order.
 *
 * Issue #1905 moved the kill off `lib/tmux`'s `killSession` and onto
 * `ICLITool.killSession`, so the pane the route acted on is now read from the
 * gateway call rather than from the tmux mock. The resolution being pinned here
 * is unchanged by that.
 */
let killedSessions: string[];

function call(query: string) {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${WORKTREE_ID}/kill-session${query}`,
    { method: 'POST' }
  );
  return POST(request, { params: Promise.resolve({ id: WORKTREE_ID }) });
}

/**
 * Report exactly one (tool, instance) pair as live, so the kill has a target,
 * and record what the route hands to the gateway instead of ending a session.
 */
function onlyRunning(cliToolId: string, instanceId: string): void {
  const manager = CLIToolManager.getInstance();
  for (const tool of CLI_TOOL_IDS) {
    const impl = manager.getTool(tool);
    vi.spyOn(impl, 'isRunning').mockImplementation(
      async (_worktreeId: string, instance?: string) =>
        tool === cliToolId && (instance ?? tool) === instanceId
    );
    vi.spyOn(impl, 'killSession').mockImplementation(
      async (worktreeId: string, instance?: string) => {
        killedSessions.push(impl.getSessionName(worktreeId, instance));
      }
    );
  }
}

describe('POST /api/worktrees/:id/kill-session — instance resolution', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Kill',
      path: '/path/to/wt',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
    ]);
    killedSessions = [];
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    vi.restoreAllMocks();
  });

  /**
   * The behaviour change of #1925, stated as the symptom it fixes: the session
   * that gets killed is the roster's, not the query string's.
   */
  it('kills the roster\'s session, not the one the explicit cliTool names', async () => {
    onlyRunning('codex', 'codex');
    const response = await call('?instance=codex');

    expect(response.status).toBe(200);
    expect(killedSessions).toEqual([expect.stringContaining('codex')]);
  });

  it('refuses an explicit cliTool that contradicts the roster', async () => {
    onlyRunning('codex', 'codex');
    const response = await call('?instance=codex&cliTool=claude');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'instance_tool_conflict',
      instanceId: 'codex',
      rosterCliTool: 'codex',
      requestedCliTool: 'claude',
    });
    expect(killedSessions).toEqual([]);
  });

  it('accepts an explicit cliTool that agrees with the roster', async () => {
    onlyRunning('codex', 'codex');
    const response = await call('?instance=codex&cliTool=codex');
    expect(response.status).toBe(200);
  });

  /**
   * #868's primary anchor, which the old inline chain did have — pinned so the
   * move to the shared resolver did not quietly drop it.
   */
  it('anchors an unregistered tool-named instance to that tool', async () => {
    onlyRunning('opencode', 'opencode');
    const response = await call('?instance=opencode');
    expect(response.status).toBe(200);
    expect(killedSessions).toEqual([expect.stringContaining('opencode')]);
  });

  /**
   * Also a behaviour change. The inline chain answered 400 "Provide cliTool" for
   * an instance nothing could name, which made an ad-hoc worker impossible to
   * kill by the id it was started under. It now resolves the way `send` and
   * `capture` already resolved it — the worktree's own agent — and the only 404
   * left is the honest one: nothing is running there.
   */
  it('falls back to the worktree agent for an instance nothing names', async () => {
    onlyRunning('claude', 'worker-1');
    const response = await call('?instance=worker-1');
    expect(response.status).toBe(200);
    expect(killedSessions).toEqual([expect.stringContaining('worker-1')]);
  });
});
