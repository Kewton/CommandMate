/**
 * `GET` / `POST /api/worktrees/:id/opencode/session` (Issue #2038).
 *
 * Placed under `tests/unit/session/` rather than `tests/unit/api/` because what
 * it exercises is the `src/lib/session/opencode-session-*` trio; the route is
 * the thin shell that decides which instance and refuses when there is no server
 * to ask. It is driven through the route anyway, because two of the three
 * decisions live there: which ids count as this worktree's opencode instances,
 * and what a missing port means to a caller.
 *
 * The behaviours pinned:
 *
 *  - **`GET` answers for a stopped instance.** That is the interesting case —
 *    the session id it reports is the one the next launch will resume.
 *  - **`fork` forks, then navigates, then remembers.** Forking alone leaves the
 *    pane on the original conversation, so the operator sees nothing happen; and
 *    the branch has to become the resumed session or the next launch would undo
 *    the fork.
 *  - **`new` forgets.** Resuming the conversation the operator just walked away
 *    from would undo exactly what they asked for.
 *  - **No port is a 409, not a 500.** The instance exists; it just cannot be
 *    asked right now.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

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
    setMockDb: (db: Database.Database) => { mockDb = db; },
    closeDbInstance: () => { mockDb?.close(); mockDb = null; },
  };
});

import { GET, POST } from '@/app/api/worktrees/[id]/opencode/session/route';
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import { discardAgentEventState, recordAgentEvent } from '@/lib/session/agent-event-state';
import {
  getRememberedOpencodeSession,
  rememberOpencodeSession,
  resetOpencodeSessionMemories,
} from '@/lib/session/opencode-session-store';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';

const WORKTREE_ID = 'wt-route-2038';
const PORT = 4255;
const SESSION_ID = 'ses_fc9802f88ffeZzlE5mU5cYYEFs';
const FORK_ID = 'ses_fc97fcc64ffexwMzjZ3t5umRnf';

const target: AgentInstanceRef = { worktreeId: WORKTREE_ID, cliToolId: 'opencode' };

let sandbox: string;
let worktreePath: string;
let db: Database.Database;
const MANAGED_ENV = ['CM_OPENCODE_SESSION_FILE', 'CM_OPENCODE_PORT_FILE'] as const;
const savedEnv: Record<string, string | undefined> = {};
let requestedUrls: string[];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

function sessionBody(id: string, title: string) {
  return {
    id,
    slug: 'slug',
    projectID: 'global',
    directory: worktreePath,
    title,
    version: '1.18.22',
    time: { created: 1, updated: 2 },
  };
}

function get(query = ''): Promise<Response> {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${WORKTREE_ID}/opencode/session${query}`,
    { method: 'GET' }
  );
  return GET(request, { params: Promise.resolve({ id: WORKTREE_ID }) }) as Promise<Response>;
}

function post(body: unknown): Promise<Response> {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${WORKTREE_ID}/opencode/session`,
    { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
  );
  return POST(request, { params: Promise.resolve({ id: WORKTREE_ID }) }) as Promise<Response>;
}

beforeEach(async () => {
  sandbox = makeTempDir('opencode-route-2038-');
  worktreePath = join(sandbox, 'worktree');
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
  process.env.CM_OPENCODE_SESSION_FILE = join(sandbox, 'opencode-sessions.json');
  process.env.CM_OPENCODE_PORT_FILE = join(sandbox, 'opencode-ports.json');
  resetOpencodePortAssignments();
  resetOpencodeSessionMemories();
  discardAgentEventState(WORKTREE_ID, 'opencode');

  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'route 2038',
    path: worktreePath,
    repositoryPath: join(sandbox, 'repo'),
    repositoryName: 'repo',
    cliToolId: 'opencode',
  };
  upsertWorktree(db, worktree);

  requestedUrls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requestedUrls.push(url);
      const path = new URL(url).pathname;
      if (path === `/session/${SESSION_ID}`) return jsonResponse(sessionBody(SESSION_ID, 'Original'));
      if (path === `/session/${SESSION_ID}/fork`) {
        return jsonResponse(sessionBody(FORK_ID, 'Original (fork #1)'));
      }
      if (path === `/session/${FORK_ID}`) return jsonResponse(sessionBody(FORK_ID, 'Original (fork #1)'));
      if (path.startsWith('/tui/')) return jsonResponse(true);
      return jsonResponse({ name: 'NotFoundError' }, 404);
    })
  );
});

afterEach(async () => {
  for (const key of MANAGED_ENV) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  resetOpencodePortAssignments();
  resetOpencodeSessionMemories();
  discardAgentEventState(WORKTREE_ID, 'opencode');
  removeTempDir(sandbox);
});

describe('GET', () => {
  it('reports the session a stopped instance will resume', async () => {
    rememberOpencodeSession(target, {
      sessionId: SESSION_ID,
      title: 'Original',
      worktreePath,
    });

    const body = await (await get()).json();
    expect(body.instances).toEqual([
      {
        instanceId: 'opencode',
        sessionId: SESSION_ID,
        title: 'Original',
        worktreePath,
        updatedAt: expect.any(Number),
        live: false,
      },
    ]);
  });

  it('reports nulls when nothing has ever been recorded', async () => {
    const body = await (await get()).json();
    expect(body.instances[0]).toMatchObject({ sessionId: null, title: null, live: false });
  });

  it('never asks opencode for the HOME-wide session list', async () => {
    rememberOpencodePort(target, PORT, worktreePath);
    recordAgentEvent(WORKTREE_ID, 'opencode', undefined, {
      event: 'stop',
      at: Date.now(),
      detail: null,
      sessionId: SESSION_ID,
    });

    await get();

    expect(requestedUrls.map((url) => new URL(url).pathname)).not.toContain('/session');
  });

  it('refuses an instance parameter that is not an instance id', async () => {
    expect((await get('?instance=../../etc')).status).toBe(400);
  });
});

describe('POST', () => {
  beforeEach(() => {
    rememberOpencodePort(target, PORT, worktreePath);
  });

  it('opens opencode own session picker for `list`', async () => {
    const response = await post({ action: 'list' });
    expect(response.status).toBe(200);
    // "accepted", never "opened": measured, a headless server with no TUI at
    // all answers true.
    expect(await response.json()).toMatchObject({ action: 'list', accepted: true });
    expect(requestedUrls.some((url) => url.endsWith('/tui/open-sessions'))).toBe(true);
  });

  it('forgets the remembered session for `new`', async () => {
    rememberOpencodeSession(target, { sessionId: SESSION_ID, worktreePath });

    const response = await post({ action: 'new' });

    expect(response.status).toBe(200);
    expect(getRememberedOpencodeSession(target)).toBeNull();
  });

  it('forks, navigates the pane to the branch, and remembers it', async () => {
    rememberOpencodeSession(target, { sessionId: SESSION_ID, worktreePath });

    const body = await (await post({ action: 'fork' })).json();

    expect(body.session).toEqual({ id: FORK_ID, title: 'Original (fork #1)' });
    expect(body.selected).toBe(true);
    expect(requestedUrls.some((url) => url.endsWith(`/session/${SESSION_ID}/fork`))).toBe(true);
    expect(requestedUrls.some((url) => url.endsWith('/tui/select-session'))).toBe(true);
    expect(getRememberedOpencodeSession(target)?.sessionId).toBe(FORK_ID);
  });

  it('refuses a fork when nothing knows which session to branch', async () => {
    const response = await post({ action: 'fork' });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('NO_OPENCODE_SESSION');
  });

  it('refuses an unknown action', async () => {
    expect((await post({ action: 'delete' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it('refuses an instance this worktree does not have as opencode', async () => {
    const response = await post({ action: 'list', instanceId: 'claude' });
    expect(response.status).toBe(400);
  });
});

describe('POST with no server attached', () => {
  it('answers 409 rather than failing', async () => {
    const response = await post({ action: 'list' });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('NO_OPENCODE_PORT');
  });
});
