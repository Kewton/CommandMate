/**
 * `kill-session` は止めたインスタンスの Auto-Yes を無効にする（Issue #3182）。
 *
 * 止めた集合（route の targets）と無効化する集合が一致すること、
 * 止めていない別インスタンス・別 worktree の同名インスタンスは残ることを固定する。
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
import { getAutoYesState, setAutoYesEnabled, clearAllAutoYesStates } from '@/lib/auto-yes-state';

const WT = 'wt-ay';
const OTHER_WT = 'wt-ay-other';

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

const enabled = (wt: string, tool: 'claude' | 'codex', instance?: string) =>
  getAutoYesState(wt, tool, instance)?.enabled === true;

describe('POST /api/worktrees/:id/kill-session — Auto-Yes (Issue #3182)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    for (const [id, name] of [[WT, 'AY'], [OTHER_WT, 'AY other']] as const) {
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
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
      { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 1 },
    ]);
    clearAllAutoYesStates();
    setAutoYesEnabled(WT, 'codex', true, undefined, undefined, 'codex');
    setAutoYesEnabled(WT, 'codex', true, undefined, undefined, 'codex-2');
    setAutoYesEnabled(WT, 'claude', true);
    setAutoYesEnabled(OTHER_WT, 'codex', true, undefined, undefined, 'codex-2');
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    vi.restoreAllMocks();
    clearAllAutoYesStates();
  });

  it('disables only the killed instance (?instance=)', async () => {
    allRunning();
    const response = await call('?instance=codex-2');

    expect(response.status).toBe(200);
    expect(enabled(WT, 'codex', 'codex-2')).toBe(false);
    // negative controls: sibling instance, other tool, same-named instance of another worktree
    expect(enabled(WT, 'codex', 'codex')).toBe(true);
    expect(enabled(WT, 'claude')).toBe(true);
    expect(enabled(OTHER_WT, 'codex', 'codex-2')).toBe(true);
  });

  it('disables every instance of the tool for ?cliTool=', async () => {
    allRunning();
    const response = await call('?cliTool=codex');

    expect(response.status).toBe(200);
    expect(enabled(WT, 'codex', 'codex')).toBe(false);
    expect(enabled(WT, 'codex', 'codex-2')).toBe(false);
    expect(enabled(WT, 'claude')).toBe(true);
    expect(enabled(OTHER_WT, 'codex', 'codex-2')).toBe(true);
  });

  it('disables every instance of the worktree when neither is given', async () => {
    allRunning();
    const response = await call('');

    expect(response.status).toBe(200);
    expect(enabled(WT, 'codex', 'codex')).toBe(false);
    expect(enabled(WT, 'codex', 'codex-2')).toBe(false);
    expect(enabled(WT, 'claude')).toBe(false);
    expect(enabled(OTHER_WT, 'codex', 'codex-2')).toBe(true);
  });

  it('disables Auto-Yes even when the kill itself fails', async () => {
    const manager = CLIToolManager.getInstance();
    for (const tool of CLI_TOOL_IDS) {
      const impl = manager.getTool(tool);
      vi.spyOn(impl, 'isRunning').mockImplementation(async () => true);
      vi.spyOn(impl, 'killSession').mockImplementation(async () => {
        throw new Error('boom');
      });
    }
    const response = await call('?instance=codex-2');

    expect(response.status).toBe(500);
    expect(enabled(WT, 'codex', 'codex-2')).toBe(false);
    expect(enabled(WT, 'codex', 'codex')).toBe(true);
  });
});
