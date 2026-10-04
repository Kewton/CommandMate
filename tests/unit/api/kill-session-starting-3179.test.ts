/**
 * `kill-session` は止めたインスタンスの「起動中」の記録を消す（Issue #3179 UAT TC-21）。
 *
 * 起動待ちの途中で止めると、`startSession` の `finally` が走るまで記録が残り、
 * 止まったセッションに「起動中…」が出続けていた。止めた集合（route の targets）だけが
 * 消え、止めていない別インスタンス・別 worktree の記録は残ることを固定する。
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);
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
import {
  getSessionStartingSince,
  markSessionStarting,
  resetSessionStartingState,
} from '@/lib/session/session-starting-state';

const WT = 'wt-st';
const OTHER_WT = 'wt-st-other';

function call(query: string) {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${WT}/kill-session${query}`,
    { method: 'POST' }
  );
  return POST(request, { params: Promise.resolve({ id: WT }) });
}

/** Every session is live and every kill succeeds. */
function allRunning(): void {
  const manager = CLIToolManager.getInstance();
  for (const tool of CLI_TOOL_IDS) {
    const impl = manager.getTool(tool);
    vi.spyOn(impl, 'isRunning').mockImplementation(async () => true);
    vi.spyOn(impl, 'killSession').mockImplementation(async () => {});
  }
}

const starting = (wt: string, tool: 'antigravity' | 'claude', instance?: string) =>
  getSessionStartingSince(wt, tool, instance) !== null;

describe('POST /api/worktrees/:id/kill-session — starting record (Issue #3179)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    for (const [id, name] of [[WT, 'ST'], [OTHER_WT, 'ST other']] as const) {
      const worktree: Worktree = {
        id,
        name,
        path: `/path/to/${id}`,
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
        cliToolId: 'claude',
      };
      upsertWorktree(db, worktree);
    }
    setAgentInstances(db, WT, [
      { id: 'antigravity', cliTool: 'antigravity', alias: 'Agy', order: 0 },
      { id: 'antigravity-2', cliTool: 'antigravity', alias: 'Agy 2', order: 1 },
    ]);
    resetSessionStartingState();
    markSessionStarting(WT, 'antigravity', 'antigravity');
    markSessionStarting(WT, 'antigravity', 'antigravity-2');
    markSessionStarting(WT, 'claude');
    markSessionStarting(OTHER_WT, 'antigravity', 'antigravity-2');
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    vi.restoreAllMocks();
    resetSessionStartingState();
  });

  it('clears only the killed instance (?instance=)', async () => {
    allRunning();
    const response = await call('?instance=antigravity-2');

    expect(response.status).toBe(200);
    expect(starting(WT, 'antigravity', 'antigravity-2')).toBe(false);
    // negative controls: sibling instance, other tool, same-named instance of another worktree
    expect(starting(WT, 'antigravity', 'antigravity')).toBe(true);
    expect(starting(WT, 'claude')).toBe(true);
    expect(starting(OTHER_WT, 'antigravity', 'antigravity-2')).toBe(true);
  });

  it('clears every instance of the tool for ?cliTool=', async () => {
    allRunning();
    const response = await call('?cliTool=antigravity');

    expect(response.status).toBe(200);
    expect(starting(WT, 'antigravity', 'antigravity')).toBe(false);
    expect(starting(WT, 'antigravity', 'antigravity-2')).toBe(false);
    expect(starting(WT, 'claude')).toBe(true);
    expect(starting(OTHER_WT, 'antigravity', 'antigravity-2')).toBe(true);
  });

  it('clears every instance of the worktree when neither is given', async () => {
    allRunning();
    const response = await call('');

    expect(response.status).toBe(200);
    expect(starting(WT, 'antigravity', 'antigravity')).toBe(false);
    expect(starting(WT, 'antigravity', 'antigravity-2')).toBe(false);
    expect(starting(WT, 'claude')).toBe(false);
    expect(starting(OTHER_WT, 'antigravity', 'antigravity-2')).toBe(true);
  });
});
