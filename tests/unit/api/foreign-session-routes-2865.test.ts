/**
 * Issue #2865: the worktree API routes neither read, type into, start over,
 * nor kill a same-named tmux session another CommandMate server created.
 *
 * Worktree ids come from directory names, so two servers with different DBs
 * resolve the same `mcbd-<cli>-<id>` session. The routes now compare the
 * session's `#{session_path}` with the worktree's path. The ownership check,
 * the CLI tools and the manager are real here; only the tmux module, the
 * database handle and the send service are stood in for.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import { NextRequest } from 'next/server';

const hasSession = vi.fn(async (_sessionName: string) => true);
const getSessionWorkingDirectory = vi.fn(async (_sessionName: string): Promise<string | null> => null);
const createSession = vi.fn(async () => {});
const sendKeys = vi.fn(async () => {});
const capturePane = vi.fn(async () => 'captured');
const killSession = vi.fn(async () => true);

vi.mock('@/lib/tmux/tmux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux')>();
  return {
    ...actual,
    hasSession: (...args: [string]) => hasSession(...args),
    getSessionWorkingDirectory: (...args: [string]) => getSessionWorkingDirectory(...args),
    createSession: (...args: unknown[]) => createSession(...(args as [])),
    sendKeys: (...args: unknown[]) => sendKeys(...(args as [])),
    capturePane: (...args: unknown[]) => capturePane(...(args as [])),
    killSession: (...args: unknown[]) => killSession(...(args as [])),
    listSessions: vi.fn(async () => []),
    reconcileSessionGeometry: vi.fn(async () => false),
    sendSpecialKey: vi.fn(async () => {}),
    sendSpecialKeys: vi.fn(async () => {}),
  };
});

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

import { POST as capture } from '@/app/api/worktrees/[id]/capture/route';
import { POST as send } from '@/app/api/worktrees/[id]/send/route';
import { POST as killSessionRoute } from '@/app/api/worktrees/[id]/kill-session/route';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { resetForeignSessionWarningsForTesting } from '@/lib/tmux/session-ownership';

const WORKTREE_ID = 'wt-2865';
const WORKTREE_PATH = '/nonexistent-2865/this-server/wt-2865';
const OTHER_SERVER_PATH = '/nonexistent-2865/other-server/wt-2865';
const CLAUDE_SESSION = `mcbd-claude-${WORKTREE_ID}`;
const CODEX_SESSION = `mcbd-codex-${WORKTREE_ID}`;

function request(route: string, body: unknown, query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/${route}${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = () => ({ params: Promise.resolve({ id: WORKTREE_ID }) });

/** Let fire-and-forget probes settle before asserting on tmux. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** `#{session_path}` per session name; anything unlisted is this worktree's. */
function sessionPaths(paths: Record<string, string>): void {
  getSessionWorkingDirectory.mockImplementation(async (name: string) => paths[name] ?? WORKTREE_PATH);
}

let db: Database.Database;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  vi.clearAllMocks();
  vi.restoreAllMocks();
  resetForeignSessionWarningsForTesting();
  hasSession.mockResolvedValue(true);
  sessionPaths({});
  capturePane.mockResolvedValue('captured');
  sendUserMessage.mockResolvedValue({
    ok: true,
    message: { id: 1, worktreeId: WORKTREE_ID, role: 'user', content: 'hi' },
  });

  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'develop',
    path: WORKTREE_PATH,
    repositoryPath: '/nonexistent-2865/this-server',
    repositoryName: 'this-server',
    cliToolId: 'claude',
  };
  upsertWorktree(db, worktree);
});

afterEach(async () => {
  await settle();
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  db.close();
});

describe('[#2865] POST /capture', () => {
  it('answers 409 with the ownership code and reads nothing from a foreign session', async () => {
    sessionPaths({ [CLAUDE_SESSION]: OTHER_SERVER_PATH });

    const res = await capture(request('capture', { cliToolId: 'claude' }), params());

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'session_owned_by_other_server',
      sessionName: CLAUDE_SESSION,
      sessionPath: OTHER_SERVER_PATH,
    });
    expect(capturePane).not.toHaveBeenCalled();
  });

  it('captures its own session (control)', async () => {
    const res = await capture(request('capture', { cliToolId: 'claude' }), params());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ output: 'captured' });
  });
});

describe('[#2865] POST /send', () => {
  it('answers 409 and neither starts a session nor sends into a foreign one', async () => {
    sessionPaths({ [CLAUDE_SESSION]: OTHER_SERVER_PATH });
    const tool = CLIToolManager.getInstance().getTool('claude');
    const startSession = vi.spyOn(tool, 'startSession');
    const sendMessage = vi.spyOn(tool, 'sendMessage');

    const res = await send(request('send', { content: 'hello', cliToolId: 'claude' }), params());
    await settle();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'session_owned_by_other_server',
      sessionName: CLAUDE_SESSION,
      sessionPath: OTHER_SERVER_PATH,
    });
    expect(startSession).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('answers 409 when the foreign session_path cannot be read (fail safe)', async () => {
    getSessionWorkingDirectory.mockResolvedValue(null);

    const res = await send(request('send', { content: 'hello', cliToolId: 'claude' }), params());

    expect(res.status).toBe(409);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('sends into its own running session (control)', async () => {
    const res = await send(request('send', { content: 'hello', cliToolId: 'claude' }), params());
    await settle();

    expect(res.status).toBe(201);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ worktreeId: WORKTREE_ID, cliToolId: 'claude' })
    );
  });
});

describe('[#2865] POST /kill-session', () => {
  it('kills only the owned sessions and reports the foreign ones it skipped', async () => {
    // Only claude and codex are "live"; the other tools' sessions do not exist.
    hasSession.mockImplementation(async (name: string) => name === CLAUDE_SESSION || name === CODEX_SESSION);
    sessionPaths({ [CODEX_SESSION]: OTHER_SERVER_PATH });
    const manager = CLIToolManager.getInstance();
    const claudeKill = vi.spyOn(manager.getTool('claude'), 'killSession').mockResolvedValue();
    const codexKill = vi.spyOn(manager.getTool('codex'), 'killSession').mockResolvedValue();

    const res = await killSessionRoute(request('kill-session', {}), params());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.killedSessions).toEqual([CLAUDE_SESSION]);
    expect(body.skippedForeignSessions).toEqual([CODEX_SESSION]);
    expect(claudeKill).toHaveBeenCalledTimes(1);
    expect(codexKill).not.toHaveBeenCalled();
  });

  it('answers 409 when every live target is foreign', async () => {
    hasSession.mockImplementation(async (name: string) => name === CODEX_SESSION);
    sessionPaths({ [CODEX_SESSION]: OTHER_SERVER_PATH });
    const codexKill = vi.spyOn(CLIToolManager.getInstance().getTool('codex'), 'killSession').mockResolvedValue();

    const res = await killSessionRoute(request('kill-session', {}, '?cliTool=codex'), params());

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'session_owned_by_other_server',
      sessionName: CODEX_SESSION,
      skippedForeignSessions: [CODEX_SESSION],
    });
    expect(codexKill).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
  });
});
