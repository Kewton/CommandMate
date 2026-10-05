/**
 * auto-yes: arming is refused for a session another server created
 * (Issue #3290).
 *
 * Issue #2865 taught the Auto-Yes POLLER to leave a same-named session alone
 * when its `#{session_path}` is not this worktree's — but the route that arms
 * it never asked. So `POST /auto-yes {enabled: true}` against such a session
 * answered 200, stored `enabled: true` and started a poller that would never
 * answer anything: the toggle read ON over a session nothing was watching.
 *
 * The route now makes the same check the routes that type into a session make,
 * before any state is written. What it deliberately does NOT refuse is pinned
 * here as well:
 *
 * - a session that does not exist yet (`commandmate send --auto-yes` arms
 *   before the session is started), and
 * - turning Auto-Yes OFF, whoever owns the session — that writes this server's
 *   own state and touches no pane, and refusing it would leave a grant nobody
 *   can withdraw.
 *
 * The ownership check and the state storage are real; tmux, the database handle
 * and the two poller entry points are stood in for.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

const hasSession = vi.fn(async (_sessionName: string) => true);
const getSessionWorkingDirectory = vi.fn(async (_sessionName: string): Promise<string | null> => null);

vi.mock('@/lib/tmux/tmux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux')>();
  return {
    ...actual,
    hasSession: (...args: [string]) => hasSession(...args),
    getSessionWorkingDirectory: (...args: [string]) => getSessionWorkingDirectory(...args),
  };
});

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
      mockDb?.close();
      mockDb = null;
    },
  };
});

/**
 * Only the poller entry points are replaced; state storage stays real so the
 * tests read back what was actually written. A real poller would put a
 * 2-second timer against tmux behind every assertion.
 */
vi.mock('@/lib/polling/auto-yes-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/polling/auto-yes-manager')>();
  return {
    ...actual,
    startAutoYesPolling: vi.fn(() => ({ started: true })),
    stopAutoYesPolling: vi.fn(() => true),
    stopAutoYesPollingByWorktree: vi.fn(() => 0),
  };
});

vi.mock('@/lib/hooks/pending-decision-recheck', () => ({
  recheckPendingDecisions: vi.fn(),
}));

import { GET, POST } from '@/app/api/worktrees/[id]/auto-yes/route';
import { recheckPendingDecisions } from '@/lib/hooks/pending-decision-recheck';
import {
  clearAllAutoYesStates,
  getAutoYesState,
  setAutoYesEnabled,
  startAutoYesPolling,
} from '@/lib/polling/auto-yes-manager';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { resetForeignSessionWarningsForTesting } from '@/lib/tmux/session-ownership';

const WORKTREE_ID = 'wt-3290';
const WORKTREE_PATH = '/nonexistent-3290/this-server/wt-3290';
const OTHER_SERVER_PATH = '/nonexistent-3290/other-server/wt-3290';
const CLAUDE_SESSION = resolveSessionName('claude', WORKTREE_ID);
const CODEX_2_SESSION = resolveSessionName('codex', WORKTREE_ID, 'codex-2');

function post(body: unknown): Promise<Response> {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/auto-yes`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id: WORKTREE_ID }) }) as Promise<Response>;
}

function get(query = ''): Promise<Response> {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/auto-yes${query}`, {
    method: 'GET',
  });
  return GET(request, { params: Promise.resolve({ id: WORKTREE_ID }) }) as Promise<Response>;
}

/** `#{session_path}` per session name; anything unlisted is this worktree's. */
function sessionPaths(paths: Record<string, string>): void {
  getSessionWorkingDirectory.mockImplementation(async (name: string) => paths[name] ?? WORKTREE_PATH);
}

beforeEach(async () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'develop',
    path: WORKTREE_PATH,
    repositoryPath: '/nonexistent-3290/this-server',
    repositoryName: 'this-server',
    cliToolId: 'claude',
  };
  upsertWorktree(db, worktree);

  clearAllAutoYesStates();
  vi.clearAllMocks();
  resetForeignSessionWarningsForTesting();
  hasSession.mockResolvedValue(true);
  sessionPaths({});
  vi.mocked(recheckPendingDecisions).mockResolvedValue({
    examined: 0,
    delivered: 0,
    skipped: 0,
    reason: 'no-pending',
  });
});

afterEach(async () => {
  clearAllAutoYesStates();
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
});

describe('[#3290] POST /auto-yes {enabled: true} — a session another server owns', () => {
  it('answers 409 with the ownership code, stores nothing and starts no poller', async () => {
    sessionPaths({ [CLAUDE_SESSION]: OTHER_SERVER_PATH });

    const res = await post({ enabled: true, cliToolId: 'claude' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: `tmux session "${CLAUDE_SESSION}" belongs to another CommandMate server`,
      code: 'session_owned_by_other_server',
      sessionName: CLAUDE_SESSION,
      sessionPath: OTHER_SERVER_PATH,
    });
    expect(getAutoYesState(WORKTREE_ID, 'claude')).toBeNull();
    expect(startAutoYesPolling).not.toHaveBeenCalled();
    expect(recheckPendingDecisions).not.toHaveBeenCalled();
  });

  it('refuses the worktree default agent too, when the request names none', async () => {
    sessionPaths({ [CLAUDE_SESSION]: OTHER_SERVER_PATH });

    const res = await post({ enabled: true });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ sessionName: CLAUDE_SESSION });
    expect(startAutoYesPolling).not.toHaveBeenCalled();
  });

  it('checks the instance\'s own session, not the primary\'s', async () => {
    sessionPaths({ [CODEX_2_SESSION]: OTHER_SERVER_PATH });

    const res = await post({ enabled: true, cliToolId: 'codex', instanceId: 'codex-2' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ sessionName: CODEX_2_SESSION, sessionPath: OTHER_SERVER_PATH });
    expect(getAutoYesState(WORKTREE_ID, 'codex', 'codex-2')).toBeNull();
    expect(startAutoYesPolling).not.toHaveBeenCalled();
  });

  it('answers 409 when the session_path cannot be read (fail safe)', async () => {
    getSessionWorkingDirectory.mockResolvedValue(null);

    const res = await post({ enabled: true, cliToolId: 'claude' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'session_owned_by_other_server', sessionPath: null });
    expect(startAutoYesPolling).not.toHaveBeenCalled();
  });

  it('leaves an earlier grant exactly as it was', async () => {
    const before = setAutoYesEnabled(WORKTREE_ID, 'claude', true);
    sessionPaths({ [CLAUDE_SESSION]: OTHER_SERVER_PATH });

    const res = await post({ enabled: true, cliToolId: 'claude', duration: 10800000 });

    expect(res.status).toBe(409);
    expect(getAutoYesState(WORKTREE_ID, 'claude')).toEqual(before);
  });
});

describe('[#3290] what the check does not refuse', () => {
  it('arms its own session as before (control)', async () => {
    const res = await post({ enabled: true, cliToolId: 'claude' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      enabled: true,
      pollingStarted: true,
      cliToolId: 'claude',
      instanceId: 'claude',
    });
    expect(getAutoYesState(WORKTREE_ID, 'claude')?.enabled).toBe(true);
    expect(startAutoYesPolling).toHaveBeenCalledWith(WORKTREE_ID, 'claude', 'claude');
  });

  it('arms ahead of a session that does not exist yet (control)', async () => {
    // `commandmate send --auto-yes` posts here before the session is started.
    hasSession.mockResolvedValue(false);

    const res = await post({ enabled: true, cliToolId: 'claude' });

    expect(res.status).toBe(200);
    expect(getAutoYesState(WORKTREE_ID, 'claude')?.enabled).toBe(true);
    expect(startAutoYesPolling).toHaveBeenCalledTimes(1);
  });

  it('arms one agent while another agent\'s session is foreign', async () => {
    sessionPaths({ [CODEX_2_SESSION]: OTHER_SERVER_PATH });

    const res = await post({ enabled: true, cliToolId: 'claude' });

    expect(res.status).toBe(200);
    expect(startAutoYesPolling).toHaveBeenCalledWith(WORKTREE_ID, 'claude', 'claude');
  });

  it('turns Auto-Yes off whoever owns the session, without asking tmux', async () => {
    setAutoYesEnabled(WORKTREE_ID, 'claude', true);
    sessionPaths({ [CLAUDE_SESSION]: OTHER_SERVER_PATH });

    const targeted = await post({ enabled: false, cliToolId: 'claude' });

    expect(targeted.status).toBe(200);
    expect(await targeted.json()).toMatchObject({ enabled: false });
    expect(getAutoYesState(WORKTREE_ID, 'claude')?.enabled).toBe(false);

    setAutoYesEnabled(WORKTREE_ID, 'claude', true);
    const all = await post({ enabled: false });

    expect(all.status).toBe(200);
    expect(getAutoYesState(WORKTREE_ID, 'claude')?.enabled).toBe(false);
    expect(hasSession).not.toHaveBeenCalled();
  });

  it('reads the state back whoever owns the session, without asking tmux', async () => {
    setAutoYesEnabled(WORKTREE_ID, 'claude', true);
    sessionPaths({ [CLAUDE_SESSION]: OTHER_SERVER_PATH });

    const res = await get('?cliToolId=claude');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, cliToolId: 'claude' });
    expect(hasSession).not.toHaveBeenCalled();
  });

  it('still answers 404 for a worktree it does not know, before asking tmux', async () => {
    const request = new NextRequest('http://localhost:3000/api/worktrees/wt-unknown/auto-yes', {
      method: 'POST',
      body: JSON.stringify({ enabled: true, cliToolId: 'claude' }),
    });

    const res = await POST(request, { params: Promise.resolve({ id: 'wt-unknown' }) });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Worktree 'wt-unknown' not found" });
    expect(hasSession).not.toHaveBeenCalled();
  });
});
