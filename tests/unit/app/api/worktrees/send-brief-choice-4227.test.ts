/**
 * Issue #4227 (S-B, design `docs/design/mem-ui-4227.md` §3.2): the send route takes the
 * screen's choice (`brief: 'decline'`, `briefDetail`, `briefBoundary`), validates it before
 * anything is resolved, hands it to the send service, and answers the service's
 * `brief_choice` stop as 409 `boundary_changed`. The service's own behaviour is
 * `tests/unit/lib/session/session-brief-choice-4227.test.ts`.
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
import { validateBriefChoice } from '@/app/api/worktrees/[id]/send/send-request';

const WORKTREE_ID = 'wt-4227-send';

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

describe('[#4227 S-B] the send body’s brief choice (validation, before anything is resolved)', () => {
  it.each([
    [{}],
    [{ brief: 'skip' }],
    [{ brief: 'force' }],
    [{ brief: 'decline', briefBoundary: 'b-1' }],
    [{ briefDetail: 'short' }],
    [{ briefDetail: 'short', briefBoundary: 'b-1' }],
    [{ briefDetail: 'full', briefBoundary: 'b-1' }],
  ])('accepts %j', (body) => {
    expect(validateBriefChoice(body as never)).toBeNull();
  });

  it.each([
    [{ brief: 'decline' }, "brief 'decline' and briefDetail 'full' need briefBoundary"],
    [{ briefDetail: 'full' }, "brief 'decline' and briefDetail 'full' need briefBoundary"],
    [{ briefDetail: 'long' }, "briefDetail must be 'short' or 'full'"],
    [{ brief: 'skip', briefDetail: 'full', briefBoundary: 'b' }, 'briefDetail is only for a send without brief'],
    [{ brief: 'force', briefBoundary: 'b' }, "briefBoundary is not for brief 'skip' or 'force'"],
    [{ briefDetail: 'full', briefBoundary: '' }, 'briefBoundary must be a boundary id'],
    [{ briefDetail: 'full', briefBoundary: 'x'.repeat(129) }, 'briefBoundary must be a boundary id'],
    [{ briefDetail: 'full', briefBoundary: 7 }, 'briefBoundary must be a boundary id'],
    [{ brief: 'auto' }, "brief must be 'skip' or 'force'"],
  ])('refuses %j', (body, error) => {
    expect(validateBriefChoice(body as never)).toBe(error);
  });
});

describe('[#4227 S-B] POST /send: the choice reaches the service, its abort is 409', () => {
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
    sendUserMessage.mockResolvedValue({ ok: true, message: { id: 1, worktreeId: WORKTREE_ID, role: 'user', content: 'hi' } });
    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Send 4227',
      path: '/path/to/wt-4227-send',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'antigravity',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('a decline names its boundary to the service', async () => {
    await post({ content: 'hello', brief: 'decline', briefBoundary: 'b-1' });
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const params = sendUserMessage.mock.calls[0][1] as Record<string, unknown>;
    expect(params.brief).toBe('decline');
    expect(params.briefBoundary).toBe('b-1');
  });

  it('full is `auto` with briefDetail full', async () => {
    await post({ content: 'hello', briefDetail: 'full', briefBoundary: 'b-1' });
    const params = sendUserMessage.mock.calls[0][1] as Record<string, unknown>;
    expect(params.brief).toBe('auto');
    expect(params.briefDetail).toBe('full');
  });

  it('negative: a send with no choice hands no choice', async () => {
    await post({ content: 'hello' });
    const params = sendUserMessage.mock.calls[0][1] as Record<string, unknown>;
    expect(params.brief).toBe('auto');
    expect(params.briefDetail).toBeUndefined();
    expect(params.briefBoundary).toBeUndefined();
  });

  it('the service’s brief_choice is 409 boundary_changed with the reason and the boundary', async () => {
    sendUserMessage.mockResolvedValueOnce({
      ok: false,
      stage: 'brief_choice',
      code: 'boundary_changed',
      reason: 'superseded',
      boundary: { id: 'b-1', state: 'superseded' },
      error: 'brief choice aborted (superseded); nothing was typed',
    });
    const response = await post({ content: 'hello', brief: 'decline', briefBoundary: 'b-1' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'boundary_changed', reason: 'superseded', boundary: { id: 'b-1', state: 'superseded' } });
  });

  it('negative: a send failure is not 409 boundary_changed', async () => {
    sendUserMessage.mockResolvedValueOnce({ ok: false, stage: 'send', error: 'Command failed: tmux send-keys' });
    const response = await post({ content: 'hello' });
    expect(response.status).not.toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain('boundary_changed');
  });
});
