/**
 * A worktree ID move drops `lastSend` and its order rather than moving them
 * (Issue #4065). The real reconcile over an in-memory database and a fake
 * tmux, the shape `worktree-session-reconcile-auto-yes-reason-3730.test.ts`
 * uses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => logger };
  return { createLogger: () => logger, generateRequestId: () => 'req' };
});

import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { reconcileWorktreeSessions, type ReconcileTmuxDeps } from '@/lib/session/worktree-session-reconcile';
import { clearSendAttempts, getLastSendAttempt, recordSendAttempt } from '@/lib/session/send-attempt-state';
import type { Worktree } from '@/types/models';

function emptyTmux(): ReconcileTmuxDeps {
  return { listSessions: async () => [], isSessionOwnedBy: () => true, renameSession: async () => false };
}

function worktree(id: string): Worktree {
  return { id, name: 'develop', branch: 'develop', path: `/repos/anvil/${id}`, repositoryPath: '/repos/anvil', repositoryName: 'anvil' };
}

const at = (worktreeId: string) => ({ worktreeId, cliToolId: 'claude', instanceId: 'claude' });

describe('worktree ID move and lastSend (Issue #4065)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    clearSendAttempts();
  });

  afterEach(() => {
    clearSendAttempts();
    db.close();
  });

  it('drops the old ID\'s record and maxG, moves nothing to the new ID, and leaves other worktrees alone', async () => {
    upsertWorktree(db, worktree('alpha'));
    recordSendAttempt(at('alpha'), { state: 'sent', reason: 'submitted', content: 'x', inputGeneration: 50 });
    recordSendAttempt(at('gamma'), { state: 'sent', reason: 'submitted', content: 'y', inputGeneration: 51 });

    await reconcileWorktreeSessions(db, 'alpha', 'beta', { tmux: emptyTmux() });

    expect(getLastSendAttempt(at('alpha'))).toBeNull();
    expect(getLastSendAttempt(at('beta'))).toBeNull();
    expect(getLastSendAttempt(at('gamma'))).not.toBeNull();
    // The old request finishing late under the old ID is a first record there.
    expect(recordSendAttempt(at('alpha'), { state: 'indeterminate', reason: 'send-error', content: 'x', inputGeneration: 1 })).toBe(true);
  });
});
