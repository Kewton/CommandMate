/**
 * The refused send never reaches tmux (Issue #2491).
 *
 * The integration suite for this Issue proves the status code and the payload
 * with every CLI tool stood in for, which is the right shape for a resolution
 * matrix and the wrong shape for the acceptance sentence "tmux セッションは立たない":
 * with the tool classes faked, tmux is unreachable whatever the route decides,
 * so "no session was created" would be true of a route that answered 201.
 *
 * So this file fakes tmux instead and keeps the tools real — the same division
 * as the #2433 suite next door. `AntigravityTool` and `CommandCodeTool` are the
 * ones from `src/lib/cli-tools/`, reached through the real `CLIToolManager`;
 * only the tmux module, the database and the send service are stood in for.
 * The conflict then has somewhere it could have gone, and the control below
 * proves it is somewhere requests actually go.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import type { NextRequest } from 'next/server';

const hasSession = vi.fn(async (_sessionName: string) => false);
const createSession = vi.fn(async () => {});
const sendKeys = vi.fn(async () => {});
const capturePane = vi.fn(async () => '');
const killSession = vi.fn(async () => true);

vi.mock('@/lib/tmux/tmux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux')>();
  return {
    ...actual,
    hasSession: (...args: [string]) => hasSession(...args),
    createSession: (...args: unknown[]) => createSession(...(args as [])),
    sendKeys: (...args: unknown[]) => sendKeys(...(args as [])),
    capturePane: (...args: unknown[]) => capturePane(...(args as [])),
    killSession: (...args: unknown[]) => killSession(...(args as [])),
    listSessions: vi.fn(async () => []),
    reconcileSessionGeometry: vi.fn(async () => false),
  };
});

/**
 * The send itself is not this file's subject and it is the one step that would
 * otherwise pull the detection graph in. Stubbing it also makes "did the route
 * decide to send at all?" a single assertion.
 */
const sendUserMessage = vi.fn();
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
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
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      mockDb = null;
    },
  };
});

import { POST as sendMessage } from '@/app/api/worktrees/[id]/send/route';

const WORKTREE_ID = 'wt-2491-send';

function post(body: unknown) {
  const request = new Request(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return sendMessage(request as unknown as NextRequest, {
    params: Promise.resolve({ id: WORKTREE_ID }),
  });
}

/** Let the route's fire-and-forget hook-URL probe settle before asserting. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('POST /send: a contradicted target never reaches tmux (Issue #2491)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    vi.clearAllMocks();
    hasSession.mockResolvedValue(false);
    capturePane.mockResolvedValue('');
    sendUserMessage.mockResolvedValue({
      ok: true,
      message: { id: 1, worktreeId: WORKTREE_ID, role: 'user', content: 'hi' },
    });

    // Deliberately neither of the two tools in play, so a silent fallback to the
    // worktree default would show up as `codex` rather than as a plausible answer.
    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Send conflict',
      path: '/path/to/wt-2491-send',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'codex',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('answers 400 and touches no tmux session for `--instance antigravity --agent command-code`', async () => {
    const response = await post({
      content: 'hello',
      instanceId: 'antigravity',
      cliToolId: 'command-code',
    });
    await settle();

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('instance_tool_conflict');

    // Not "no session was created" but "nothing asked tmux anything": the route
    // returns before `CLIToolManager.getTool`, so the mispointed
    // `mcbd-command-code-wt-2491-send-antigravity` is never even looked up.
    expect(hasSession).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('control: the same instance without the contradicting agent does reach tmux', async () => {
    // Anti-vacuity for the assertions above. `hasSession` answering true keeps
    // the route on its already-running branch, so the control needs no launch.
    hasSession.mockResolvedValue(true);

    const response = await post({ content: 'hello', instanceId: 'antigravity' });
    await settle();

    expect(response.status).toBe(201);
    // The #868 anchor, through the real AntigravityTool: the primary instance's
    // session carries no suffix, and the tool is the id's, not the worktree's.
    expect(hasSession).toHaveBeenCalledWith(`mcbd-antigravity-${WORKTREE_ID}`);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cliToolId: 'antigravity', instanceId: 'antigravity' })
    );
  });
});
