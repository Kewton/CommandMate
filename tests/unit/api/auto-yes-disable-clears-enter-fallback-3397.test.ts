/**
 * Turning Auto-Yes off drops the Enter record (Issue #3397, review finding 3).
 *
 * A record that outlived its grant would read `currentPrompt: true` against the
 * same question later, and the prompt window would say "Auto-Yes sent Enter"
 * with Auto-Yes off. The disable route stops the poller through
 * `stopAutoYesPolling` / `stopAutoYesPollingByWorktree`, which now forget the
 * record — also for an instance whose poller had already stopped.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
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
    setMockDb: (db: Database.Database) => { mockDb = db; },
    closeDbInstance: () => { mockDb?.close(); mockDb = null; },
  };
});

vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);

// Only the start is replaced (no 2s timer against tmux); the stops are real.
vi.mock('@/lib/polling/auto-yes-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/polling/auto-yes-manager')>();
  return { ...actual, startAutoYesPolling: vi.fn(() => ({ started: true })) };
});

vi.mock('@/lib/hooks/pending-decision-recheck', () => ({
  recheckPendingDecisions: vi.fn(async () => ({ examined: 0, delivered: 0, skipped: 0, reason: 'no-pending' })),
}));

import { POST } from '@/app/api/worktrees/[id]/auto-yes/route';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/polling/auto-yes-manager';
import {
  clearEnterFallbacks,
  getLastEnterFallback,
  recordEnterFallbackSent,
} from '@/lib/polling/auto-yes-enter-fallback';

const WT = 'wt-3397-ay';
const OTHER_WT = 'wt-3397-other';

function post(body: unknown): Promise<Response> {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WT}/auto-yes`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id: WT }) }) as Promise<Response>;
}

function record(worktreeId: string, cliToolId: 'claude' | 'codex', instanceId?: string): void {
  recordEnterFallbackSent(worktreeId, cliToolId, instanceId, {
    promptType: 'multiple_choice',
    refusalReason: 'unsupported_dialog_layout',
    screenKey: 'multiple_choice:Which one?',
  });
}

describe('[#3397] POST /auto-yes { enabled: false } forgets the Enter record', () => {
  beforeEach(async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    for (const id of [WT, OTHER_WT]) {
      const worktree: Worktree = {
        id,
        name: id,
        path: `/path/to/${id}`,
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
        cliToolId: 'claude',
      };
      upsertWorktree(db, worktree);
    }
    clearAllAutoYesStates();
    clearEnterFallbacks();
    setAutoYesEnabled(WT, 'claude', true);
    setAutoYesEnabled(WT, 'codex', true);
    record(WT, 'claude');
    record(WT, 'codex');
    record(OTHER_WT, 'claude');
  });

  afterEach(async () => {
    clearAllAutoYesStates();
    clearEnterFallbacks();
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
  });

  it('for the named agent only (no poller was running)', async () => {
    expect(getLastEnterFallback(WT, 'claude')).not.toBeNull();
    const response = await post({ enabled: false, cliToolId: 'claude' });
    expect(response.status).toBe(200);

    expect(getLastEnterFallback(WT, 'claude')).toBeNull();
    // Negative controls: another agent, another worktree.
    expect(getLastEnterFallback(WT, 'codex')).not.toBeNull();
    expect(getLastEnterFallback(OTHER_WT, 'claude')).not.toBeNull();
  });

  it('for every instance of the worktree when no agent is named', async () => {
    const response = await post({ enabled: false });
    expect(response.status).toBe(200);

    expect(getLastEnterFallback(WT, 'claude')).toBeNull();
    expect(getLastEnterFallback(WT, 'codex')).toBeNull();
    expect(getLastEnterFallback(OTHER_WT, 'claude')).not.toBeNull();
  });
});
