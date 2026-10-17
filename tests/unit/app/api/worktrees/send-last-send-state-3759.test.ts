/**
 * The send route's failure says how the attempt left the message (Issue #3759),
 * and the attempts the route refuses before the send service are recorded for
 * `lastSend` too.
 *
 * Positive: a `prompt not ready` failure carries `[send state: not-sent …]` and
 * a start timeout is recorded as not-sent. Negative: a failure with no state (a
 * send service that returned none) keeps its error text exactly.
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
import { clearSendAttempts, getLastSendAttempt, recordSendAttempt } from '@/lib/session/send-attempt-state';
import type { SendAttemptReason, SendAttemptState } from '@/lib/session/send-attempt-types';

const WORKTREE_ID = 'wt-3759-send';
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
const NOT_READY = 'Failed to send message to Codex: Codex prompt not ready: timed out waiting for the input prompt before sending';

/** A send service that fails with `error` after recording `state` for the message it was given. */
function failsAfterRecording(error: string, state: SendAttemptState, reason: SendAttemptReason, recordedContent?: string) {
  sendUserMessage.mockImplementation(async (_db: unknown, params: { content: string }) => {
    recordSendAttempt(INSTANCE, { state, reason, content: recordedContent ?? params.content });
    return { ok: false, stage: 'send', error };
  });
}

describe('POST /send: the send state of a failed send (Issue #3759)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    vi.clearAllMocks();
    clearSendAttempts();
    isRunning.mockResolvedValue(true);
    isPaneBackAtShell.mockResolvedValue(false);
    upsertWorktree(db, {
      id: WORKTREE_ID,
      name: 'State',
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
  });

  it('writes not-sent into a prompt-not-ready failure, and that nothing resends it', async () => {
    failsAfterRecording(NOT_READY, 'not-sent', 'prompt-not-ready');

    const response = await post();
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(500);
    expect(body.error).toContain('prompt not ready');
    expect(body.error).toContain('[send state: not-sent (prompt-not-ready)');
    expect(body.error).toContain('does not resend');
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('writes indeterminate with the advice not to resend', async () => {
    failsAfterRecording('boom', 'indeterminate', 'send-error');

    const body = (await (await post()).json()) as { error: string };

    expect(body.error).toContain('[send state: indeterminate (send-error)');
    expect(body.error).toContain('do not resend before checking the pane');
  });

  it('keeps the error text as it was when no record was made for this request (negative)', async () => {
    sendUserMessage.mockResolvedValue({ ok: false, stage: 'send', error: 'boom' });

    const body = (await (await post()).json()) as { error: string };

    expect(body.error).toBe('Failed to send message to Codex CLI: boom');
  });

  it('does not borrow the state of another message\'s record (negative)', async () => {
    failsAfterRecording('boom', 'not-sent', 'prompt-not-ready', 'some other message');

    const body = (await (await post()).json()) as { error: string };

    expect(body.error).toBe('Failed to send message to Codex CLI: boom');
  });

  it('records a start timeout as not-sent session-starting', async () => {
    isRunning.mockResolvedValue(false);
    startSession.mockRejectedValue(new SessionStartTimeoutError('Codex CLI', SESSION, 60000));

    const response = await post();

    expect(response.status).toBe(503);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ state: 'not-sent', reason: 'session-starting' });
  });

  it('records any other start failure as not-sent session-start-failed', async () => {
    isRunning.mockResolvedValue(false);
    startSession.mockRejectedValue(new Error('tmux refused'));

    const response = await post();

    expect(response.status).toBe(500);
    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ state: 'not-sent', reason: 'session-start-failed' });
  });
});
