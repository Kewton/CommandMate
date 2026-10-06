/**
 * Stopping a session drops its Enter record (Issue #3397, review finding 3).
 *
 * Without it, a session restarted on the same instance that shows the same
 * question would read the old record as `currentPrompt: true`: the window
 * would say "Auto-Yes sent Enter" and `wait` would say so too. The route
 * releases Auto-Yes through `releaseAutoYes('session-killed', …)`, which stops
 * the poller with `stopAutoYesPolling`, which now forgets the record.
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
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import {
  clearEnterFallbacks,
  getLastEnterFallback,
  recordEnterFallbackSent,
} from '@/lib/polling/auto-yes-enter-fallback';

const WT = 'wt-3397-kill';

function call(query: string) {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WT}/kill-session${query}`, {
    method: 'POST',
  });
  return POST(request, { params: Promise.resolve({ id: WT }) });
}

function allRunning(): void {
  const manager = CLIToolManager.getInstance();
  for (const tool of CLI_TOOL_IDS) {
    const impl = manager.getTool(tool);
    vi.spyOn(impl, 'isRunning').mockImplementation(async () => true);
    vi.spyOn(impl, 'killSession').mockImplementation(async () => {});
  }
}

function record(instanceId: string): void {
  recordEnterFallbackSent(WT, 'codex', instanceId, {
    promptType: 'multiple_choice',
    refusalReason: 'prompt_no_longer_active',
    screenKey: 'multiple_choice:Which one?',
  });
}

describe('[#3397] POST /kill-session forgets the Enter record', () => {
  beforeEach(async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    const worktree: Worktree = {
      id: WT,
      name: 'kill',
      path: `/path/to/${WT}`,
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'codex',
    };
    upsertWorktree(db, worktree);
    setAgentInstances(db, WT, [
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
      { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 1 },
    ]);
    clearAllAutoYesStates();
    clearEnterFallbacks();
    setAutoYesEnabled(WT, 'codex', true, undefined, undefined, 'codex');
    setAutoYesEnabled(WT, 'codex', true, undefined, undefined, 'codex-2');
    record('codex');
    record('codex-2');
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    vi.restoreAllMocks();
    clearAllAutoYesStates();
    clearEnterFallbacks();
  });

  it('for the killed instance only', async () => {
    allRunning();
    const response = await call('?instance=codex-2');
    expect(response.status).toBe(200);

    expect(getLastEnterFallback(WT, 'codex', 'codex-2')).toBeNull();
    expect(getLastEnterFallback(WT, 'codex', 'codex')).not.toBeNull();
  });

  it('for every instance when the whole worktree is killed', async () => {
    allRunning();
    const response = await call('');
    expect(response.status).toBe(200);

    expect(getLastEnterFallback(WT, 'codex', 'codex-2')).toBeNull();
    expect(getLastEnterFallback(WT, 'codex', 'codex')).toBeNull();
  });
});
