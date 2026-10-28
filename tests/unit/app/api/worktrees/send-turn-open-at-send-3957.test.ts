/**
 * The send route says whether the instance was mid-turn when the message went
 * out (Issue #3957): `turnOpenAtSend: true` on the 201 body when the
 * instance's turn record shows a turn opened and not closed just before the
 * send, and no key otherwise ("not open" or "not known").
 *
 * The turn is judged at the moment the body started going in (the send
 * service's `onInputStart`, #3953's stamp), not when the route read it: a
 * turn that ended while the send queued, a relaunch inside the send and a
 * sender that reports no input start are all "no key".
 *
 * Positive: an open turn → the key. Negative: a closed turn, no record at all
 * (a tool whose hooks report no turn start), another instance's open turn →
 * no key.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import type { NextRequest } from 'next/server';

const startSession = vi.fn();
const isRunning = vi.fn(async () => false);

vi.mock('@/lib/cli-tools/codex', () => ({
  CodexTool: class {
    id = 'codex';
    name = 'Codex CLI';
    command = 'codex';
    async isInstalled() { return true; }
    async isRunning() { return isRunning(); }
    async startSession(...args: unknown[]) { return startSession(...args); }
    async sendMessage() {}
    async killSession() {}
    getSessionName(id: string) { return `mcbd-codex-${id}`; }
  },
}));

vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'absent' })),
}));

const isPaneBackAtShell = vi.fn(async (..._args: unknown[]): Promise<boolean> => false);
vi.mock('@/app/api/worktrees/[id]/send/pane-shell', () => ({
  isPaneBackAtShell: (...args: unknown[]) => isPaneBackAtShell(...args),
}));

const sendUserMessage = vi.fn();
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));

vi.mock('@/lib/git/git-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/git/git-utils')>()),
  getGitStatus: vi.fn(async () => {
    throw new Error('not a repository');
  }),
}));
vi.mock('@/lib/realtime/terminal-broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime/terminal-broadcast')>()),
  broadcastSessionStatus: vi.fn(),
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
import { beginAgentEventGeneration, clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import type { AgentEventRecord } from '@/lib/session/agent-event-record';

const WORKTREE_ID = 'wt-3957-send';

function post(extra: Record<string, unknown> = {}): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hello', cliToolId: 'codex', ...extra }),
  });
  return sendMessage(request as unknown as NextRequest, {
    params: Promise.resolve({ id: WORKTREE_ID }),
  }) as unknown as Promise<Response>;
}

function event(name: AgentEventRecord['event'], at: number): AgentEventRecord {
  return { event: name, at, detail: null, sessionId: 's-3957' };
}

interface SendParams {
  content: string;
  onInputStart?: (at: Date) => void;
}

/**
 * A send service that runs `beforeInput` (what happens while the send queues
 * for the lock, waits out a mark or relaunches), then reports the input start
 * the way the real one does and succeeds.
 */
function sendsAfter(beforeInput: () => void, reportsInputStart = true): void {
  sendUserMessage.mockImplementation(async (_db: unknown, params: SendParams) => {
    beforeInput();
    if (reportsInputStart) params.onInputStart?.(new Date());
    return {
      ok: true,
      message: { id: 'm-1', worktreeId: WORKTREE_ID, role: 'user', content: params.content, cliToolId: 'codex', instanceId: 'codex' },
    };
  });
}

describe('POST /send: turnOpenAtSend (Issue #3957)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    vi.clearAllMocks();
    clearAgentStopEvents();
    isRunning.mockResolvedValue(true);
    sendsAfter(() => {});
    upsertWorktree(db, {
      id: WORKTREE_ID,
      name: 'Turn',
      path: `/path/to/${WORKTREE_ID}`,
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'codex',
    } as Worktree);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
    clearAgentStopEvents();
  });

  it('positive: a turn opened and not closed before the send → turnOpenAtSend: true', async () => {
    recordAgentEvent(WORKTREE_ID, 'codex', undefined, event('user_prompt_submit', Date.now() - 2_000));

    const response = await post();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ id: 'm-1', content: 'hello', turnOpenAtSend: true });
  });

  it('negative: a turn that closed before the send → no key', async () => {
    recordAgentEvent(WORKTREE_ID, 'codex', undefined, event('user_prompt_submit', Date.now() - 2_000));
    recordAgentEvent(WORKTREE_ID, 'codex', undefined, event('stop', Date.now() - 1_000));

    const response = await post();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body).not.toHaveProperty('turnOpenAtSend');
    expect(body).toMatchObject({ id: 'm-1', content: 'hello' });
  });

  it('negative: no turn record (no turn-start hooks) → no key', async () => {
    const response = await post();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body).not.toHaveProperty('turnOpenAtSend');
  });

  it('negative: another instance being mid-turn does not mark this send', async () => {
    recordAgentEvent(WORKTREE_ID, 'codex', 'codex-2', event('user_prompt_submit', Date.now() - 2_000));

    const response = await post({ instanceId: 'codex' });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body).not.toHaveProperty('turnOpenAtSend');
  });

  it('(a) open when read, but closed before the input started → no key', async () => {
    recordAgentEvent(WORKTREE_ID, 'codex', undefined, event('user_prompt_submit', Date.now() - 2_000));
    // The previous turn ends while this send waits for the input lock.
    sendsAfter(() => {
      recordAgentEvent(WORKTREE_ID, 'codex', undefined, event('stop', Date.now() - 1));
    });

    const response = await post();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body).not.toHaveProperty('turnOpenAtSend');
  });

  it('(b) still open at the input start, closing after it → turnOpenAtSend: true', async () => {
    recordAgentEvent(WORKTREE_ID, 'codex', undefined, event('user_prompt_submit', Date.now() - 2_000));
    sendUserMessage.mockImplementation(async (_db: unknown, params: SendParams) => {
      const inputAt = new Date();
      params.onInputStart?.(inputAt);
      // The folded turn ends after the body went in.
      recordAgentEvent(WORKTREE_ID, 'codex', undefined, event('stop', inputAt.getTime() + 5));
      return { ok: true, message: { id: 'm-1', worktreeId: WORKTREE_ID, role: 'user', content: params.content } };
    });

    const response = await post();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ turnOpenAtSend: true });
  });

  it('the open turn replaced after the input start by the prompt of this message (a fold) → turnOpenAtSend: true', async () => {
    recordAgentEvent(WORKTREE_ID, 'codex', undefined, event('user_prompt_submit', Date.now() - 2_000));
    sendUserMessage.mockImplementation(async (_db: unknown, params: SendParams) => {
      const inputAt = new Date();
      params.onInputStart?.(inputAt);
      // Issue #3330's re-open: an unmarked prompt of the same session replaces the running turn.
      recordAgentEvent(WORKTREE_ID, 'codex', undefined, event('user_prompt_submit', inputAt.getTime() + 5));
      return { ok: true, message: { id: 'm-1', worktreeId: WORKTREE_ID, role: 'user', content: params.content } };
    });

    const response = await post();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ turnOpenAtSend: true });
  });

  it('(c) the send relaunched the session (a new generation) → no key', async () => {
    recordAgentEvent(WORKTREE_ID, 'codex', undefined, event('user_prompt_submit', Date.now() - 2_000));
    sendsAfter(() => {
      beginAgentEventGeneration(WORKTREE_ID, 'codex', undefined, Date.now());
    });

    const response = await post();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body).not.toHaveProperty('turnOpenAtSend');
  });

  it('a sender that reports no input start leaves it unknown → no key', async () => {
    recordAgentEvent(WORKTREE_ID, 'codex', undefined, event('user_prompt_submit', Date.now() - 2_000));
    sendsAfter(() => {}, false);

    const response = await post();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body).not.toHaveProperty('turnOpenAtSend');
  });
});
