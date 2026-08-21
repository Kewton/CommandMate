/**
 * auto-yes: the armed agent is the worktree's, not a hard-coded claude
 * (Issue #1909).
 *
 * The POST used to end its resolution in a literal:
 *
 *   const cliToolId: CLIToolType = resolution.cliToolId ?? 'claude';
 *
 * `resolveInstanceCliTool` answers `cliToolId: null` for "this request named no
 * agent" and leaves the worktree default to the caller. This caller had no such
 * stage, so on a worktree whose default is copilot,
 * `commandmate auto-yes <id> --enable` armed a *claude* poller: the server
 * logged `poller:started {"cliToolId":"claude"}` and then
 * `Claude Code session mcbd-claude-<id> does not exist` every 2 seconds, while
 * copilot's permission dialogs sat unanswered. `send` / `wait` / `capture` all
 * took the worktree default; only the route that arms the poller did not.
 *
 * The GET half is pinned here too (DR3-010). Fixing only the POST would arm the
 * right poller and then report the wrong state: the backward-compatible
 * top-level fields read `getAutoYesState(id, 'claude')`, a key nothing would
 * ever write again on a copilot worktree.
 *
 * Resolution now goes through the one shared resolver (Issue #1925, design §4
 * D5 決定 3), so the precedence stages that reach this route are pinned as well
 * — including the split the design draws through it: the POST arms a session,
 * so a contradiction is refused (400); the GET only reads, so the roster wins
 * and the contradiction ships in the payload (DR3-015).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import type { CLIToolType } from '@/lib/cli-tools/types';
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

/**
 * Only the two poller entry points are replaced; state storage stays real so
 * the tests can read back the composite key that was actually written. Letting
 * the real poller start would put a 2-second timer against tmux behind every
 * assertion.
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

import { GET, POST } from '@/app/api/worktrees/[id]/auto-yes/route';
import {
  startAutoYesPolling,
  getAutoYesState,
  clearAllAutoYesStates,
} from '@/lib/polling/auto-yes-manager';

const WORKTREE_ID = 'wt-1909';

interface AutoYesBody {
  enabled: boolean;
  expiresAt: number | null;
  pollingStarted?: boolean;
  cliToolId?: string;
  instanceId?: string;
  resolvedBy?: string;
  conflict?: { instanceId: string; rosterCliTool: string; requestedCliTool: string } | null;
  agents?: Record<string, { enabled: boolean }>;
  instances?: Record<string, { enabled: boolean }>;
  error?: string;
  code?: string;
}

function post(body: unknown): Promise<Response> {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${WORKTREE_ID}/auto-yes`,
    { method: 'POST', body: JSON.stringify(body) }
  );
  return POST(request, { params: Promise.resolve({ id: WORKTREE_ID }) }) as Promise<Response>;
}

function get(query = ''): Promise<Response> {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${WORKTREE_ID}/auto-yes${query}`,
    { method: 'GET' }
  );
  return GET(request, { params: Promise.resolve({ id: WORKTREE_ID }) }) as Promise<Response>;
}

/** The (cliToolId, instanceId) pair `startAutoYesPolling` was last asked for. */
function armedTarget(): { cliToolId: string; instanceId: string | undefined } {
  const calls = vi.mocked(startAutoYesPolling).mock.calls;
  expect(calls.length).toBe(1);
  const [, cliToolId, instanceId] = calls[0];
  return { cliToolId, instanceId };
}

async function setUpDb(worktreeCliTool: CLIToolType | undefined): Promise<Database.Database> {
  const db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'Auto-yes default tool',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'repo',
    cliToolId: worktreeCliTool,
  };
  upsertWorktree(db, worktree);
  return db;
}

describe('POST /api/worktrees/:id/auto-yes — default agent (Issue #1909)', () => {
  beforeEach(async () => {
    await setUpDb('copilot');
    clearAllAutoYesStates();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    clearAllAutoYesStates();
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
  });

  /**
   * The Issue's own reproduction: `commandmate auto-yes proj-cp --enable` on a
   * worktree whose default is copilot. The poller that starts is the assertion
   * — the response's `enabled: true` was already true while the bug was live.
   */
  it('arms the worktree default agent when the request names none', async () => {
    const response = await post({ enabled: true });
    expect(response.status).toBe(200);

    expect(armedTarget()).toEqual({ cliToolId: 'copilot', instanceId: 'copilot' });

    const body = (await response.json()) as AutoYesBody;
    expect(body.enabled).toBe(true);
    expect(body.pollingStarted).toBe(true);
    expect(body.cliToolId).toBe('copilot');
    expect(body.instanceId).toBe('copilot');
    expect(body.resolvedBy).toBe('worktree-default');
  });

  /** The stored state has to land on the same key, or the poller reads nothing. */
  it('stores the state under the worktree default, not under claude', async () => {
    await post({ enabled: true });

    expect(getAutoYesState(WORKTREE_ID, 'copilot', 'copilot')?.enabled).toBe(true);
    expect(getAutoYesState(WORKTREE_ID, 'claude', 'claude')).toBeNull();
  });

  /**
   * The other door into the same expression: an instance the roster does not
   * know, whose id is not a tool name either (`send --instance worker-7`). That
   * is `cliToolId: null` too, so it used to arm claude just the same.
   */
  it('arms the worktree default for an unregistered, non-tool instance id', async () => {
    const body = (await (await post({ enabled: true, instanceId: 'worker-7' })).json()) as AutoYesBody;

    expect(armedTarget()).toEqual({ cliToolId: 'copilot', instanceId: 'worker-7' });
    expect(body.cliToolId).toBe('copilot');
    expect(body.resolvedBy).toBe('worktree-default');
  });

  it('keeps honouring an explicit cliToolId', async () => {
    const body = (await (await post({ enabled: true, cliToolId: 'codex' })).json()) as AutoYesBody;

    expect(armedTarget()).toEqual({ cliToolId: 'codex', instanceId: 'codex' });
    expect(body.resolvedBy).toBe('explicit');
  });

  it('resolves a roster instance to its registered agent (#1629)', async () => {
    const db = await setUpDb('copilot');
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'oc-2', cliTool: 'opencode', alias: 'OpenCode 2', order: 0 },
    ]);
    vi.clearAllMocks();

    const body = (await (await post({ enabled: true, instanceId: 'oc-2' })).json()) as AutoYesBody;

    expect(armedTarget()).toEqual({ cliToolId: 'opencode', instanceId: 'oc-2' });
    expect(body.resolvedBy).toBe('roster');
  });

  /** #868: an unregistered instance id that names a tool IS that tool's primary. */
  it('anchors an unregistered instance id that names a tool to that tool', async () => {
    const body = (await (await post({ enabled: true, instanceId: 'opencode' })).json()) as AutoYesBody;

    expect(armedTarget()).toEqual({ cliToolId: 'opencode', instanceId: 'opencode' });
    expect(body.resolvedBy).toBe('primary');
  });

  /**
   * DR3-015: arming is a side effect, so two contradicting declarations of
   * which agent is meant are refused rather than resolved. Auto-answering a
   * dialog in the wrong pane is not something a guess may cause.
   */
  it('refuses a cliToolId the roster contradicts and arms nothing', async () => {
    const db = await setUpDb('copilot');
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'oc-2', cliTool: 'opencode', alias: 'OpenCode 2', order: 0 },
    ]);
    vi.clearAllMocks();

    const response = await post({ enabled: true, instanceId: 'oc-2', cliToolId: 'claude' });
    expect(response.status).toBe(400);

    const body = (await response.json()) as AutoYesBody;
    expect(body.code).toBe('instance_tool_conflict');
    expect(body.error).toContain('oc-2');
    expect(body).toMatchObject({
      instanceId: 'oc-2',
      rosterCliTool: 'opencode',
      requestedCliTool: 'claude',
    });
    expect(startAutoYesPolling).not.toHaveBeenCalled();
    expect(getAutoYesState(WORKTREE_ID, 'opencode', 'oc-2')).toBeNull();
  });

  /**
   * A worktree that names no agent still resolves to claude — but as
   * `worktree-default`, not as the resolver's last-resort `fallback` stage.
   *
   * Pinned because it is the one place the two look alike from outside, and
   * they mean opposite things. Design §4 D5 決定 5 treats `resolvedBy:
   * 'fallback'` as a warning ("the shape of the #1909 bug"), which presumes it
   * is reachable. It is not, on this route or any other: `worktrees.cli_tool_id`
   * is `TEXT DEFAULT 'claude'` (`init-db.ts`), and `getWorktreeById` maps a NULL
   * to `'claude'` on the way out (`worktree-db.ts`) — so the resolver is handed
   * a concrete tool for every worktree that exists, and every route 404s on one
   * that does not. The default agent now lives in the DB read layer, which the
   * design's guard scope deliberately excludes (DR2-006).
   */
  it('resolves an agent-less worktree as worktree-default, not fallback', async () => {
    await setUpDb(undefined);
    vi.clearAllMocks();

    const body = (await (await post({ enabled: true })).json()) as AutoYesBody;

    expect(body.cliToolId).toBe('claude');
    expect(body.resolvedBy).toBe('worktree-default');
  });

  /**
   * `auto-yes <id> --disable` names no agent on purpose and disables every
   * instance of the worktree. Naming one in the response would describe a
   * request that deliberately named none.
   */
  it('names no agent on the untargeted disable-all request', async () => {
    await post({ enabled: true });
    vi.clearAllMocks();

    const body = (await (await post({ enabled: false })).json()) as AutoYesBody;

    expect(body.enabled).toBe(false);
    expect(body.cliToolId).toBeUndefined();
    expect(body.resolvedBy).toBeUndefined();
    expect(getAutoYesState(WORKTREE_ID, 'copilot', 'copilot')?.enabled).toBeFalsy();
  });
});

describe('GET /api/worktrees/:id/auto-yes — default agent (Issue #1909, DR3-010)', () => {
  beforeEach(async () => {
    const db = await setUpDb('copilot');
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'oc-2', cliTool: 'opencode', alias: 'OpenCode 2', order: 0 },
    ]);
    clearAllAutoYesStates();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    clearAllAutoYesStates();
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
  });

  /**
   * The GET-side twin of the bug: with the POST fixed and this left alone, the
   * copilot poller runs while the top-level fields report the claude key that
   * nothing writes — so the UI shows auto-yes OFF for an armed worktree.
   */
  it('reads the top-level state from the worktree default agent', async () => {
    await post({ enabled: true });

    const body = (await (await get()).json()) as AutoYesBody;

    expect(body.enabled).toBe(true);
    expect(body.cliToolId).toBe('copilot');
    expect(body.resolvedBy).toBe('worktree-default');
    expect(body.instances?.copilot?.enabled).toBe(true);
  });

  it('reports the top-level state as disabled when the default agent is not armed', async () => {
    await post({ enabled: true, cliToolId: 'codex' });

    const body = (await (await get()).json()) as AutoYesBody;

    expect(body.cliToolId).toBe('copilot');
    expect(body.enabled).toBe(false);
    expect(body.instances?.codex?.enabled).toBe(true);
  });

  /**
   * DR3-015, read side: the roster wins and the contradiction is reported at
   * 200. The pair asked for and the pair the POST would arm have to be the
   * same one, or the toggle reads a state its own writes never reach.
   */
  it('lets the roster win over a contradicting ?cliToolId and reports the conflict', async () => {
    await post({ enabled: true, instanceId: 'oc-2' });

    const response = await get('?cliToolId=claude&instanceId=oc-2');
    expect(response.status).toBe(200);

    const body = (await response.json()) as AutoYesBody;
    expect(body.enabled).toBe(true);
    expect(body.cliToolId).toBe('opencode');
    expect(body.resolvedBy).toBe('roster');
    expect(body.conflict).toEqual({
      instanceId: 'oc-2',
      rosterCliTool: 'opencode',
      requestedCliTool: 'claude',
    });
  });

  it('reports conflict: null when nothing contradicts', async () => {
    const body = (await (await get('?cliToolId=copilot')).json()) as AutoYesBody;

    expect(body.conflict).toBeNull();
    expect(body.resolvedBy).toBe('explicit');
  });

  it('still rejects an invalid cliToolId', async () => {
    expect((await get('?cliToolId=notatool')).status).toBe(400);
  });

  it('still rejects a malformed instanceId', async () => {
    expect((await get('?instanceId=' + encodeURIComponent('bad/instance'))).status).toBe(400);
  });
});
