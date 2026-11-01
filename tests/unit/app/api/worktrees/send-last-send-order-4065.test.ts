/**
 * Issue #4065 (b): the send route's own refusals — another server's session,
 * a session still starting, a failed start — carry the generation counter the
 * request read at its entry, so they do not replace the record of a send
 * granted while the request waited. The same observation is handed to the send
 * service. A refusal on its own is recorded as before; a 400 still records
 * nothing.
 *
 * The DB is in memory; tmux and the send service are mocked.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import type { NextRequest } from 'next/server';
import { SessionStartTimeoutError } from '@/lib/session/session-start-error';

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
import { clearSendAttempts, getLastSendAttempt, recordSendAttempt, sendMessageDigest } from '@/lib/session/send-attempt-state';
import {
  instanceInputGenerationMark,
  resetInstanceInputLocks,
  withInstanceInputLock,
} from '@/lib/session/instance-input-lock';
import { checkSessionOwnership } from '@/lib/cli-tools/session-ownership';

const WORKTREE_ID = 'wt-4065-send';
const SESSION = `mcbd-codex-${WORKTREE_ID}`;

function post(): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hello', cliToolId: 'codex' }),
  });
  return sendMessage(request as unknown as NextRequest, {
    params: Promise.resolve({ id: WORKTREE_ID }),
  }) as unknown as Promise<Response>;
}

const INSTANCE = { worktreeId: WORKTREE_ID, cliToolId: 'codex', instanceId: 'codex' };

type Ownership = Awaited<ReturnType<typeof checkSessionOwnership>>;

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
  expect(condition()).toBe(true);
}

/** Another request's send, granted the lock now and recorded as sent. */
async function sendGrantedNow(content: string): Promise<void> {
  await withInstanceInputLock(SESSION, async (ticket) => {
    recordSendAttempt(INSTANCE, { state: 'sent', reason: 'submitted', content, inputGeneration: ticket.generation });
  });
}

describe('POST /send: the route\'s refusals and the grant order (Issue #4065 (b))', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    vi.clearAllMocks();
    clearSendAttempts();
    resetInstanceInputLocks();
    isRunning.mockResolvedValue(true);
    isPaneBackAtShell.mockResolvedValue(false);
    vi.mocked(checkSessionOwnership).mockResolvedValue({ verdict: 'absent' } as Ownership);
    upsertWorktree(db, {
      id: WORKTREE_ID,
      name: 'Order',
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
    clearSendAttempts();
    resetInstanceInputLocks();
  });

  it('positive: another server\'s session — refused after a send granted while the route waited; that sent stays', async () => {
    const owner = gate<Ownership>();
    vi.mocked(checkSessionOwnership).mockReturnValueOnce(owner.promise);

    const response = post();
    await until(() => vi.mocked(checkSessionOwnership).mock.calls.length === 1);
    await sendGrantedNow('later');
    owner.resolve({ verdict: 'foreign', sessionPath: '/elsewhere' } as Ownership);

    expect((await response).status).toBe(409);
    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ state: 'sent', messageDigest: sendMessageDigest('later') });
  });

  it('positive: a session still starting — refused after a send granted while the route waited; that sent stays', async () => {
    const running = gate<boolean>();
    isRunning.mockReturnValueOnce(running.promise);

    const response = post();
    await until(() => isRunning.mock.calls.length === 1);
    await sendGrantedNow('later');
    running.reject(new SessionStartTimeoutError('Codex CLI', SESSION, 60000));

    expect((await response).status).toBe(503);
    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ state: 'sent', messageDigest: sendMessageDigest('later') });
  });

  it('positive: a failed start — refused after a send granted while it started; that sent stays', async () => {
    isRunning.mockResolvedValue(false);
    const started = gate<void>();
    startSession.mockReturnValueOnce(started.promise);

    const response = post();
    await until(() => startSession.mock.calls.length === 1);
    await sendGrantedNow('later');
    started.reject(new Error('tmux refused'));

    expect((await response).status).toBe(500);
    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ state: 'sent', messageDigest: sendMessageDigest('later') });
  });

  it('negative: a refusal on its own is recorded as before', async () => {
    vi.mocked(checkSessionOwnership).mockResolvedValueOnce({ verdict: 'foreign', sessionPath: '/elsewhere' } as Ownership);

    expect((await post()).status).toBe(409);
    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ state: 'not-sent', reason: 'foreign-session' });
  });

  it('negative: a refusal after a send that was granted before the request began is recorded', async () => {
    await sendGrantedNow('earlier');
    vi.mocked(checkSessionOwnership).mockResolvedValueOnce({ verdict: 'foreign', sessionPath: '/elsewhere' } as Ownership);

    await post();

    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ state: 'not-sent', reason: 'foreign-session' });
  });

  it('hands the send service the observation read at the entry, not one read after the waits', async () => {
    const owner = gate<Ownership>();
    vi.mocked(checkSessionOwnership).mockReturnValueOnce(owner.promise);
    sendUserMessage.mockResolvedValue({ ok: false, stage: 'send', error: 'boom' });
    const atEntry = instanceInputGenerationMark();

    const response = post();
    await until(() => vi.mocked(checkSessionOwnership).mock.calls.length === 1);
    await sendGrantedNow('later');
    owner.resolve({ verdict: 'absent' } as Ownership);
    await response;

    expect(instanceInputGenerationMark()).toBeGreaterThan(atEntry);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ observedInputGeneration: atEntry })
    );
  });

  it('negative: a 400 refusal still records nothing', async () => {
    const request = new Request(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '   ', cliToolId: 'codex' }),
    });
    const response = (await sendMessage(request as unknown as NextRequest, {
      params: Promise.resolve({ id: WORKTREE_ID }),
    })) as unknown as Response;

    expect(response.status).toBe(400);
    expect(getLastSendAttempt(INSTANCE)).toBeNull();
  });
});
