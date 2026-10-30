/**
 * Issue #3981, PR review P3-1 / P3-2, at `POST /send`.
 *
 * - P3-1: a launch of the same session that outlives its start budget is no
 *   longer waited out for ever: the send is recorded not-sent and answered
 *   503 SESSION_STARTING, with nothing sent. Negative: a launch that finishes
 *   inside the budget is waited out and the send goes on.
 * - P3-2: `--model` on a send that would join a launch starting another model
 *   is a 400, as `--model` to a running session is (#989 / #2771), and the
 *   launch is not run again. Negative: the same model joins and the send goes on.
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

const antigravityStart = vi.fn();
const antigravityIsRunning = vi.fn(async () => false);
vi.mock('@/lib/cli-tools/antigravity', async () => {
  const flight = await import('@/lib/session/session-launch-flight');
  return {
    AntigravityTool: class {
      id = 'antigravity';
      name = 'Antigravity';
      command = 'agy';
      async isInstalled() { return true; }
      async isRunning() { return antigravityIsRunning(); }
      // As BaseCLITool.startSession: the launch is run as the session's one launch, with its model.
      startSession(id: string, _path: string, _instance?: string, model?: string) {
        return flight.runSessionLaunch(`mcbd-antigravity-${id}`, 'Antigravity', async () => antigravityStart(model), {
          cliToolId: 'antigravity',
          model,
        });
      }
      async sendMessage() {}
      async killSession() {}
      getSessionName(id: string) { return `mcbd-antigravity-${id}`; }
    },
  };
});

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
import { getSessionStartingMaxMs } from '@/config/session-starting-config';
import { getLastSendAttempt } from '@/lib/session/send-attempt-state';

const WORKTREE_ID = 'wt-3981-bounds';
const CODEX_SESSION = `mcbd-codex-${WORKTREE_ID}`;

function post(body: Record<string, unknown>): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hello', ...body }),
  });
  return sendMessage(request as unknown as NextRequest, {
    params: Promise.resolve({ id: WORKTREE_ID }),
  }) as unknown as Promise<Response>;
}

describe('POST /send meets another request’s launch (Issue #3981 review P3-1 / P3-2)', () => {
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
      name: 'Bounds',
      path: `/path/to/${WORKTREE_ID}`,
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'codex',
    } as Worktree);
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetSessionLaunchFlightsForTest();
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('P3-1 positive: a launch past its start budget → 503 SESSION_STARTING, not-sent, nothing sent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let finish!: () => void;
    void runSessionLaunch(CODEX_SESSION, 'Codex CLI', () => new Promise<void>((r) => (finish = r)), { cliToolId: 'codex' });
    const response = post({ cliToolId: 'codex' });
    await vi.advanceTimersByTimeAsync(getSessionStartingMaxMs('codex'));
    const answered = await response;
    const body = (await answered.json()) as { code: string; error: string };
    expect(answered.status).toBe(503);
    expect(body.code).toBe('SESSION_STARTING');
    expect(body.error).toMatch(/being started by another request/);
    expect(isRunning).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getLastSendAttempt({ worktreeId: WORKTREE_ID, cliToolId: 'codex', instanceId: 'codex' })).toMatchObject({
      state: 'not-sent',
      reason: 'session-starting',
    });
    finish();
  });

  it('P3-1 negative: a launch that finishes inside the budget is waited out and the send goes on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let finish!: () => void;
    void runSessionLaunch(CODEX_SESSION, 'Codex CLI', () => new Promise<void>((r) => (finish = r)), { cliToolId: 'codex' });
    const response = post({ cliToolId: 'codex' });
    await vi.advanceTimersByTimeAsync(getSessionStartingMaxMs('codex') - 1_000);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    await response;
    expect(isRunning).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  /** Another request's launch registers while this send reads `isRunning` (after its settle). */
  function launchBeganDuringIsRunning(model: string): { finish: () => void; launch: () => Promise<void> | null } {
    let finish!: () => void;
    let launch: Promise<void> | null = null;
    antigravityIsRunning.mockImplementationOnce(async () => {
      launch = runSessionLaunch(`mcbd-antigravity-${WORKTREE_ID}`, 'Antigravity', () => new Promise<void>((r) => (finish = r)), {
        cliToolId: 'antigravity',
        model,
      });
      return false;
    });
    return { finish: () => finish(), launch: () => launch };
  }

  it('P3-2 positive: --model that differs from the launch in progress → 400, the launch not run again, nothing sent', async () => {
    const other = launchBeganDuringIsRunning('model-a');
    const answered = await post({ cliToolId: 'antigravity', model: 'model-b' });
    const body = (await answered.json()) as { error: string; code?: string };
    expect(answered.status).toBe(400);
    expect(body.error).toMatch(/model 'model-a', not 'model-b'/);
    expect(antigravityStart).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    other.finish();
    await other.launch();
  });

  it('P3-2 negative: --model the launch in progress is starting with joins it, and the send goes on', async () => {
    const other = launchBeganDuringIsRunning('model-a');
    const response = post({ cliToolId: 'antigravity', model: 'model-a' });
    await new Promise((r) => setTimeout(r, 50));
    expect(sendUserMessage).not.toHaveBeenCalled();
    other.finish();
    await response;
    expect(antigravityStart).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });
});
