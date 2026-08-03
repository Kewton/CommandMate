/**
 * API Routes Integration Tests - Auto-Yes instance/CLI-tool pairing (Issue #1629)
 *
 * Auto-yes state and its poller are keyed on `worktreeId:cliToolId:instanceId`,
 * and the poller derives the tmux session name from cliToolId. The route used to
 * take `body.cliToolId ?? 'claude'` without consulting the roster, so enabling
 * auto-yes for a codex instance with `--instance codex` alone armed the poller
 * against a Claude session that does not exist.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST as setAutoYes } from '@/app/api/worktrees/[id]/auto-yes/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, setAgentInstances } from '@/lib/db';
import type { Worktree } from '@/types/models';

const setAutoYesEnabledMock = vi.fn(() => ({ enabled: true, enabledAt: 0, expiresAt: 1 }));
const startAutoYesPollingMock = vi.fn(() => ({ started: true }));

vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => null),
  setAutoYesEnabled: (...args: unknown[]) => setAutoYesEnabledMock(...(args as [])),
  startAutoYesPolling: (...args: unknown[]) => startAutoYesPollingMock(...(args as [])),
  stopAutoYesPolling: vi.fn(),
  stopAutoYesPollingByWorktree: vi.fn(),
  buildCompositeKey: (...parts: string[]) => parts.join(':'),
  getCompositeKeysByWorktree: vi.fn(() => []),
  extractCliToolId: vi.fn(() => null),
  extractInstanceId: vi.fn(() => null),
}));

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
    closeDbInstance: () => {
      if (mockDb) { mockDb.close(); mockDb = null; }
    },
  };
});

const WORKTREE_ID = 'demo-app-feature-greet-codex';

function callAutoYes(body: Record<string, unknown>) {
  const request = new Request(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/auto-yes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
  return setAutoYes(request, { params: Promise.resolve({ id: WORKTREE_ID }) });
}

describe('POST /api/worktrees/:id/auto-yes - instance-driven CLI tool resolution (Issue #1629)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    vi.clearAllMocks();

    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Greet (codex)',
      path: '/path/to/demo-app',
      repositoryPath: '/path/to/repo',
      repositoryName: 'demo-app',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('arms the poller against the roster instance\'s CLI tool', async () => {
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
    ]);

    const response = await callAutoYes({ enabled: true, instanceId: 'codex' });
    expect(response.status).toBe(200);

    expect(startAutoYesPollingMock).toHaveBeenCalledWith(WORKTREE_ID, 'codex', 'codex');
    expect(setAutoYesEnabledMock).toHaveBeenCalledWith(
      WORKTREE_ID, 'codex', true, expect.any(Number), undefined, 'codex'
    );
  });

  it('rejects an explicit cliToolId that contradicts the roster', async () => {
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
    ]);

    const response = await callAutoYes({ enabled: true, cliToolId: 'claude', instanceId: 'codex' });
    expect(response.status).toBe(400);
    expect(startAutoYesPollingMock).not.toHaveBeenCalled();
  });

  it('still defaults to claude when nothing names a CLI tool', async () => {
    const response = await callAutoYes({ enabled: true });
    expect(response.status).toBe(200);
    expect(startAutoYesPollingMock).toHaveBeenCalledWith(WORKTREE_ID, 'claude', 'claude');
  });

  it('treats an unregistered instance id that names a CLI tool as that tool', async () => {
    const response = await callAutoYes({ enabled: true, instanceId: 'codex' });
    expect(response.status).toBe(200);
    expect(startAutoYesPollingMock).toHaveBeenCalledWith(WORKTREE_ID, 'codex', 'codex');
  });
});
