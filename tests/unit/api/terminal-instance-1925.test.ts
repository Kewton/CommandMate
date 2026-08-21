/**
 * terminal route: instance targeting (Issue #1925, design §4 D5 決定 3).
 * @vitest-environment node
 *
 * This route took a `cliToolId` and nothing else, so it derived the session name
 * from `getSessionName(id)` — always the primary instance. Every non-primary
 * session was unreachable from it (#1906): a worktree running `codex` and
 * `codex-2` could only ever be typed into on `codex`.
 *
 * Sending is a side effect, so the contradiction rule here is the strict one:
 * a caller naming an agent the roster disagrees with is refused rather than
 * resolved to a guess. Text typed into the wrong session cannot be taken back.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import type { Worktree } from '@/types/models';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
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
    closeDbInstance: () => { mockDb?.close(); mockDb = null; },
  };
});

import { POST } from '@/app/api/worktrees/[id]/terminal/route';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';

const WORKTREE_ID = 'wt-terminal';

function call(body: Record<string, unknown>) {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${WORKTREE_ID}/terminal`,
    { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
  );
  return POST(request, { params: Promise.resolve({ id: WORKTREE_ID }) });
}

describe('POST /api/worktrees/:id/terminal — instance targeting', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Terminal',
      path: '/path/to/wt',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 0 },
    ]);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
  });

  it('addresses the named instance instead of the primary one', async () => {
    const response = await call({ cliToolId: 'codex', command: 'hello', instanceId: 'codex-2' });

    expect(response.status).toBe(200);
    const [call0] = vi.mocked(sendMessageWithSubmitVerification).mock.calls;
    expect(call0[0]).toMatchObject({ cliToolId: 'codex', message: 'hello' });
    // #868 names the primary session after the tool alone and appends the
    // instance's suffix for the rest, so "not the primary one" is the assertion
    // that actually distinguishes them.
    expect(call0[0].sessionName).toContain('codex');
    expect(call0[0].sessionName).toMatch(/-2$/);
    expect(call0[0].sessionName).not.toBe(`mcbd-codex-${WORKTREE_ID}`);
  });

  /** The pre-#1925 shape stays exactly as it was: no instance means primary. */
  it('addresses the primary instance when no instance is named', async () => {
    const response = await call({ cliToolId: 'claude', command: 'hello' });

    expect(response.status).toBe(200);
    const { sessionName } = vi.mocked(sendMessageWithSubmitVerification).mock.calls[0][0];
    expect(sessionName).toContain('claude');
    expect(sessionName).not.toContain('codex');
  });

  it('refuses a cliToolId that contradicts the roster, without typing anything', async () => {
    const response = await call({ cliToolId: 'claude', command: 'hello', instanceId: 'codex-2' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'instance_tool_conflict',
      instanceId: 'codex-2',
      rosterCliTool: 'codex',
      requestedCliTool: 'claude',
    });
    expect(sendMessageWithSubmitVerification).not.toHaveBeenCalled();
  });

  /** The id lands in a tmux session name, so it gets the same check as everywhere else. */
  it('rejects a malformed instanceId', async () => {
    const response = await call({ cliToolId: 'claude', command: 'hello', instanceId: 'bad id!' });
    expect(response.status).toBe(400);
    expect(sendMessageWithSubmitVerification).not.toHaveBeenCalled();
  });

  it('rejects a non-string instanceId', async () => {
    const response = await call({ cliToolId: 'claude', command: 'hello', instanceId: 42 });
    expect(response.status).toBe(400);
  });
});
