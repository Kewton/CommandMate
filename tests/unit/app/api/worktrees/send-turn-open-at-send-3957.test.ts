/**
 * The send route says whether the instance was mid-turn when the message went
 * out (Issue #3957): `turnOpenAtSend: true` on the 201 body when the
 * instance's turn record shows a turn opened and not closed just before the
 * send, and no key otherwise ("not open" or "not known").
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
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
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
    sendUserMessage.mockImplementation(async (_db: unknown, params: { content: string }) => ({
      ok: true,
      message: { id: 'm-1', worktreeId: WORKTREE_ID, role: 'user', content: params.content, cliToolId: 'codex', instanceId: 'codex' },
    }));
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
});
