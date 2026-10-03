/**
 * A start timeout whose pane is back at a shell is not called "still running"
 * (Issue #3093).
 *
 * The #1637 answer — "the tmux session and its process are still running, so
 * this is a slow start … nothing needs repairing" — was given for a Claude Code
 * that had already quit at its trust dialog, leaving the pane at zsh. The route
 * now reads the pane's bottom row before choosing the sentence.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import type { NextRequest } from 'next/server';
import {
  SESSION_STARTING_CODE,
  SESSION_START_FAILED_CODE,
  SessionStartTimeoutError,
} from '@/lib/session/session-start-error';

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

const WORKTREE_ID = 'wt-3093-send';
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

describe('POST /send: start timeout vs. an agent that exited to the shell (Issue #3093)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    vi.clearAllMocks();
    isRunning.mockResolvedValue(false);
    isPaneBackAtShell.mockResolvedValue(false);
    startSession.mockRejectedValue(new SessionStartTimeoutError('Codex CLI', SESSION, 60000));
    upsertWorktree(db, {
      id: WORKTREE_ID,
      name: 'Exited',
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
  });

  it('says the agent exited — not "still running" — when the pane is back at the shell', async () => {
    isPaneBackAtShell.mockResolvedValue(true);

    const response = await post();
    const body = (await response.json()) as { error: string; code: string };

    expect(isPaneBackAtShell).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex' }), WORKTREE_ID, undefined);
    expect(response.status).toBe(503);
    expect(body.code).toBe(SESSION_START_FAILED_CODE);
    expect(body.error).toContain('exited before reaching its input prompt');
    expect(body.error).toContain(`'${SESSION}' is back at a shell`);
    expect(body.error).not.toContain('still running');
    expect(body.error).not.toContain('nothing needs repairing');
  });

  it('keeps the slow-start answer while the agent still draws the pane', async () => {
    isPaneBackAtShell.mockResolvedValue(false);

    const response = await post();
    const body = (await response.json()) as { error: string; code: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe(SESSION_STARTING_CODE);
    expect(body.error).toContain('still running');
  });

  it('applies the same check to a SESSION_STARTING from the send step (#3006 path)', async () => {
    isRunning.mockResolvedValue(true);
    isPaneBackAtShell.mockResolvedValue(true);
    sendUserMessage.mockResolvedValue({
      ok: false,
      stage: 'send',
      error: new SessionStartTimeoutError('Codex CLI', SESSION, 60000).message,
      code: SESSION_STARTING_CODE,
    });

    const response = await post();
    const body = (await response.json()) as { error: string; code: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe(SESSION_START_FAILED_CODE);
    expect(body.error).not.toContain('still running');
  });
});
