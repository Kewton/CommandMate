/**
 * A worktree ID move stops the Auto-Yes poller with `worktree-id-migrated`, and
 * carries a restart notice to the new ID without starting anything
 * (Issue #3730).
 *
 * The real reconcile over an in-memory database and a fake tmux, the same
 * shape `worktree-session-reconcile.test.ts` uses; the logger is captured so
 * the `poller:stopped` line the real poller writes can be read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logged: Array<{ module: string; action: string; data?: Record<string, unknown> }> = [];
vi.mock('@/lib/logger', () => {
  const make = (module: string) => {
    const record = (action: string, data?: Record<string, unknown>) => {
      logged.push({ module, action, data });
    };
    const logger = { debug: record, info: record, warn: record, error: record, withContext: () => logger };
    return logger;
  };
  return { createLogger: make, generateRequestId: () => 'req' };
});

import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { reconcileWorktreeSessions, type ReconcileTmuxDeps } from '@/lib/session/worktree-session-reconcile';
import {
  clearAllAutoYesStates,
  getAutoYesPollerCompositeKeys,
  getAutoYesState,
  setAutoYesEnabled,
  startAutoYesPolling,
  stopAllAutoYesPolling,
} from '@/lib/polling/auto-yes-manager';
import { seedServerRestartNotice } from '@/lib/auto-yes-state';
import type { Worktree } from '@/types/models';

function emptyTmux(): ReconcileTmuxDeps {
  return {
    listSessions: async () => [],
    isSessionOwnedBy: () => true,
    renameSession: async () => false,
  };
}

function worktree(id: string): Worktree {
  return {
    id,
    name: 'develop',
    branch: 'develop',
    path: `/repos/anvil/${id}`,
    repositoryPath: '/repos/anvil',
    repositoryName: 'anvil',
  };
}

describe('worktree ID move and Auto-Yes (Issue #3730)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    clearAllAutoYesStates();
    stopAllAutoYesPolling();
    logged.length = 0;
  });

  afterEach(() => {
    stopAllAutoYesPolling();
    clearAllAutoYesStates();
    db.close();
  });

  it('stops the old poller with worktree-id-migrated and keeps the grant under the new id', async () => {
    upsertWorktree(db, worktree('alpha'));
    setAutoYesEnabled('alpha', 'claude', true);
    expect(startAutoYesPolling('alpha', 'claude').started).toBe(true);

    await reconcileWorktreeSessions(db, 'alpha', 'beta', { tmux: emptyTmux() });

    const stopped = logged.filter((e) => e.action === 'poller:stopped');
    expect(stopped.map((e) => e.data)).toEqual([{ compositeKey: 'alpha:claude', reason: 'worktree-id-migrated' }]);
    expect(getAutoYesState('beta', 'claude')?.enabled).toBe(true);
    expect(getAutoYesPollerCompositeKeys()).toEqual(['beta:claude']);
  });

  it('moves a restart notice to the new id and starts no poller for it', async () => {
    upsertWorktree(db, worktree('alpha'));
    seedServerRestartNotice({
      worktreeId: 'alpha',
      cliToolId: 'claude',
      instanceId: 'claude',
      enabledAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });

    await reconcileWorktreeSessions(db, 'alpha', 'beta', { tmux: emptyTmux() });

    expect(getAutoYesState('alpha', 'claude')).toBeNull();
    expect(getAutoYesState('beta', 'claude')).toMatchObject({ enabled: false, stopReason: 'server-restart' });
    expect(getAutoYesPollerCompositeKeys()).toEqual([]);
    expect(logged.filter((e) => e.action === 'poller:stopped')).toEqual([]);
  });
});
