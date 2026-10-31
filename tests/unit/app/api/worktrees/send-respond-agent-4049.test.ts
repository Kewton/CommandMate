/**
 * Issue #4049 (item 1), at the send route: which tool the PROMPT_WAITING
 * refusal's `respond` names is decided here (`respondAgentFor`) and handed to
 * `sendUserMessage` as `respondAgent` — set only when the request named a tool
 * (`--agent`) and no instance, and that tool is not what a request naming
 * nothing resolves to (the worktree default). The refusal sentences themselves
 * are pinned in `tests/unit/lib/session/send-respond-agent-4049.test.ts`.
 *
 * tmux and the send service are stood in for; the DB is in memory.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Issue #2865: these cases are not about `#{session_path}` ownership, so the
// check decides by session name as before (see the helper's docblock).
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);
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

const WORKTREE_ID = 'wt-4049-send';

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

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('[#4049] POST /send: respondAgent', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    vi.clearAllMocks();
    hasSession.mockResolvedValue(true);
    capturePane.mockResolvedValue('');
    sendUserMessage.mockResolvedValue({
      ok: true,
      message: { id: 1, worktreeId: WORKTREE_ID, role: 'user', content: 'hi' },
    });
    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Send 4049',
      path: '/path/to/wt-4049-send',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      // antigravity and codex: the route's running branch for them completes on
      // the empty capture here; with claude it ran into the 5 s test timeout.
      cliToolId: 'antigravity',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  async function respondAgentOf(body: Record<string, unknown>): Promise<unknown> {
    await post({ content: 'hello', ...body });
    await settle();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    return (sendUserMessage.mock.calls[0][1] as { respondAgent?: unknown }).respondAgent;
  }

  it('positive: `--agent codex` on an antigravity worktree — respondAgent is codex', async () => {
    expect(await respondAgentOf({ cliToolId: 'codex' })).toBe('codex');
  });

  it('negative: nothing named — no respondAgent', async () => {
    expect(await respondAgentOf({})).toBeUndefined();
  });

  it('negative: the default tool named — no respondAgent', async () => {
    expect(await respondAgentOf({ cliToolId: 'antigravity' })).toBeUndefined();
  });

  it('negative: an instance named — no respondAgent (the instance carries it)', async () => {
    expect(await respondAgentOf({ instanceId: 'codex', cliToolId: 'codex' })).toBeUndefined();
  });
});
