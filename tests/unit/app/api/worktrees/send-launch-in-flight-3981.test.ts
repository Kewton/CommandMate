/**
 * Issue #3981 (R4): `POST /send` waits out a launch of the same session that
 * another request has in progress before it reads `isRunning`.
 *
 * Positive control: before #3981 the route read `isRunning` at once — for seven
 * tools `has-session`, true as soon as the first request's pane existed — and
 * went on to the send while that pane held only a shell. Negative control: with
 * no launch in progress `isRunning` is read once, at once, as before.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import type { NextRequest } from 'next/server';
import { resetSessionLaunchFlightsForTest, runSessionLaunch } from '@/lib/session/session-launch-flight';

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

const WORKTREE_ID = 'wt-3981-send';
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

describe('POST /send: a launch in progress is waited out before isRunning (Issue #3981)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    vi.clearAllMocks();
    resetSessionLaunchFlightsForTest();
    isRunning.mockResolvedValue(true);
    isPaneBackAtShell.mockResolvedValue(false);
    sendUserMessage.mockReset();
    sendUserMessage.mockResolvedValue({ ok: false, stage: 'send', error: 'stub' });
    upsertWorktree(db, {
      id: WORKTREE_ID,
      name: 'Flight',
      path: `/path/to/${WORKTREE_ID}`,
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'codex',
    } as Worktree);
  });

  afterEach(async () => {
    resetSessionLaunchFlightsForTest();
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('positive: isRunning is not read, and nothing is sent, until the other launch settles', async () => {
    let finish!: () => void;
    const launch = runSessionLaunch(SESSION, 'Codex CLI', () => new Promise<void>((r) => (finish = r)));
    const response = post();
    await new Promise((r) => setTimeout(r, 50));
    expect(isRunning).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();

    finish();
    await launch;
    await response;
    expect(isRunning).toHaveBeenCalledTimes(1);
    expect(startSession).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('positive: a launch that began while isRunning was read is waited out, and isRunning read again', async () => {
    let finish!: () => void;
    let launch: Promise<void> | null = null;
    isRunning.mockImplementationOnce(async () => {
      launch = runSessionLaunch(SESSION, 'Codex CLI', () => new Promise<void>((r) => (finish = r)));
      return true;
    });
    const response = post();
    await new Promise((r) => setTimeout(r, 50));
    expect(isRunning).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).not.toHaveBeenCalled();

    finish();
    await launch;
    await response;
    expect(isRunning).toHaveBeenCalledTimes(2);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('positive: a send refused because another launch is in progress is answered SESSION_STARTING, not "exited", though the pane is at the shell', async () => {
    let finish!: () => void;
    isPaneBackAtShell.mockResolvedValue(true);
    sendUserMessage.mockImplementation(async () => {
      // Another request's launch began after this request read isRunning; the
      // send service, holding the input lock, was refused (R1).
      void runSessionLaunch(SESSION, 'Codex CLI', () => new Promise<void>((r) => (finish = r)));
      return { ok: false, stage: 'send', error: 'Codex CLI is being started by another request', code: 'SESSION_STARTING' };
    });
    const response = await post();
    const body = (await response.json()) as { code: string };
    expect(response.status).toBe(503);
    expect(body.code).toBe('SESSION_STARTING');
    finish();
  });

  it('negative: the same answer with no launch in progress still checks the pane (#3093)', async () => {
    isPaneBackAtShell.mockResolvedValue(true);
    sendUserMessage.mockResolvedValue({ ok: false, stage: 'send', error: 'slow start', code: 'SESSION_STARTING' });
    const response = await post();
    const body = (await response.json()) as { code: string };
    expect(response.status).toBe(503);
    expect(body.code).toBe('SESSION_START_FAILED');
  });

  it('negative: with no launch in progress isRunning is read once and the send goes on', async () => {
    await post();
    expect(isRunning).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });
});
