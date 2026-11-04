/**
 * Issue #4132: the windows between a read and the write that relies on it, closed with
 * a condition on the request or a key on it. Every test really makes the other write
 * land in the window, through the real routes and a real database.
 *
 * A request carrying no condition is the negative control throughout: it answers and
 * behaves as it did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import type { Command } from 'commander';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { getAgentInstances, setAgentInstances } from '@/lib/db/agent-instances-db';
import { createAgentRole, getAgentRole, getInstanceRoleState } from '@/lib/db/agent-roles-db';
import { computeRosterRevision } from '@/lib/agent-roles/management';
import { clearAllAutoYesStates, getAutoYesState, setAutoYesEnabled } from '@/lib/auto-yes-state';
import type { AgentInstance } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';
import { EXPECTED_ROLE_NAME_HEADER, INSTANCE_CREATION_KEY_HEADER } from '@/types/agent-roles';
import {
  instanceCreateExample,
  instanceCreateReplayExample,
  instanceCreationSettleExamples,
} from './fixtures/agent-roles-api-examples';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/ws-server', () => ({ broadcast: vi.fn(), broadcastMessage: vi.fn(), cleanupRooms: vi.fn() }));
vi.mock('@/lib/session-cleanup', () => ({
  cleanupMultipleWorktrees: vi.fn(async () => ({ results: [], warnings: [] })),
  createOwnedSessionKiller: vi.fn(() => vi.fn(async () => false)),
}));
vi.mock('@/lib/realtime/terminal-broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime/terminal-broadcast')>()),
  broadcastSessionStatus: vi.fn(),
}));

const ownership = vi.hoisted(() => ({ hook: null as null | (() => void) }));
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn(async () => {
    ownership.hook?.();
    return { verdict: 'absent' };
  }),
}));
vi.mock('@/lib/polling/auto-yes-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/polling/auto-yes-manager')>()),
  startAutoYesPolling: vi.fn(() => ({ started: true })),
  stopAutoYesPolling: vi.fn(),
  stopAutoYesPollingByWorktree: vi.fn(),
}));
vi.mock('@/lib/hooks/pending-decision-recheck', () => ({
  recheckPendingDecisions: vi.fn(async () => ({ reason: 'none', examined: 0, delivered: 0, skipped: 0 })),
}));

import * as autoYesRoute from '@/app/api/worktrees/[id]/auto-yes/route';
import * as instanceRolesRoute from '@/app/api/worktrees/[id]/instances/roles/route';
import * as settleRoute from '@/app/api/worktrees/[id]/instances/roles/settle/route';
import * as roleRoute from '@/app/api/roles/[id]/route';
import * as worktreeRoute from '@/app/api/worktrees/[id]/route';
import { createInstancesCommand } from '@/cli/commands/instances';

const WT = 'wt-4132';
const ROLES = `/api/worktrees/${WT}/instances/roles`;
const AUTO_YES = `/api/worktrees/${WT}/auto-yes`;
const HOUR = 3600000;
const params = <T,>(value: T) => ({ params: Promise.resolve(value) });
const wt = params({ id: WT });

function request(url: string, method: string, body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const CLAUDE: AgentInstance = { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 };
const CODEX: AgentInstance = { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 };
const rosterRevision = () => computeRosterRevision(getAgentInstances(db, WT));
const ids = () => getAgentInstances(db, WT).map((instance) => instance.id);

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, { id: WT, name: WT, path: '/tmp/wt-4132', repositoryPath: '/tmp', repositoryName: 'r' } as Worktree);
  setAgentInstances(db, WT, [CLAUDE, CODEX]);
  clearAllAutoYesStates();
  ownership.hook = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearAllAutoYesStates();
  db.close();
});

describe('[#4132-1] Auto-Yes: a grant is named, and a condition goes by the name', () => {
  const arm = async (extra: Record<string, unknown> = {}) =>
    autoYesRoute.POST(request(AUTO_YES, 'POST', { enabled: true, duration: HOUR, cliToolId: 'codex', instanceId: 'codex', ...extra }), wt);
  const disable = async (grantId?: string) =>
    autoYesRoute.POST(
      request(`${AUTO_YES}${grantId === undefined ? '' : `?expectedGrantId=${grantId}`}`, 'POST', {
        enabled: false,
        cliToolId: 'codex',
        instanceId: 'codex',
      }),
      wt,
    );
  const live = () => getAutoYesState(WT, 'codex', 'codex');

  it('positive: another grant with the same expiry and mode is not the one armed, and stays', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
    const mine = await (await arm()).json();
    const other = setAutoYesEnabled(WT, 'codex', true, HOUR, undefined, 'codex');
    expect(other.expiresAt).toBe(mine.expiresAt);
    expect(other.answerMode).toBe(mine.answerMode);

    const response = await disable(mine.grantId);
    expect(response.status).toBe(409);
    const refused = await response.json();
    expect(refused).toMatchObject({ code: 'AUTO_YES_GRANT_CHANGED', enabled: true });
    expect(refused.grantId).not.toBe(mine.grantId);
    expect(live()).toBe(other);
  });

  it('its own grant is turned off', async () => {
    const { grantId } = await (await arm()).json();
    expect(typeof grantId).toBe('string');
    const response = await disable(grantId);
    expect(response.status).toBe(200);
    expect((await response.json()).enabled).toBe(false);
    expect(live()?.enabled).toBe(false);
  });

  it('a grant already off stays as it is, with the reason it has', async () => {
    const { grantId } = await (await arm()).json();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * HOUR);
    const response = await disable(grantId);
    expect(response.status).toBe(200);
    expect((await response.json()).enabled).toBe(false);
    expect(live()?.stopReason).toBe('expired');
  });

  it('every read names the same grant, until an enable replaces it', async () => {
    const { grantId } = await (await arm()).json();
    const read = async () =>
      (await autoYesRoute.GET(request(`${AUTO_YES}?cliToolId=codex&instanceId=codex`, 'GET'), wt)).json();
    expect((await read()).grantId).toBe(grantId);
    expect((await read()).grantId).toBe(grantId);
    await arm();
    expect((await read()).grantId).not.toBe(grantId);
  });

  it('onlyIfOff: arms what is off', async () => {
    const response = await arm({ onlyIfOff: true });
    expect(response.status).toBe(200);
    expect((await response.json()).enabled).toBe(true);
  });

  it('onlyIfOff: refuses a live grant and leaves its terms alone', async () => {
    const other = setAutoYesEnabled(WT, 'codex', true, 10800000, undefined, 'codex');
    const response = await arm({ onlyIfOff: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'AUTO_YES_ALREADY_ENABLED', enabled: true, expiresAt: other.expiresAt });
    expect(live()).toBe(other);
  });

  it('onlyIfOff: a grant landing during the ownership wait is seen', async () => {
    let other: ReturnType<typeof setAutoYesEnabled> | null = null;
    ownership.hook = () => {
      other = setAutoYesEnabled(WT, 'codex', true, 10800000, undefined, 'codex');
    };
    expect((await arm({ onlyIfOff: true })).status).toBe(409);
    expect(live()).toBe(other);
  });

  it.each([
    ['onlyIfOff that is no boolean', () => arm({ onlyIfOff: 'yes' })],
    ['onlyIfOff on a disable', () => autoYesRoute.POST(request(AUTO_YES, 'POST', { enabled: false, onlyIfOff: true, cliToolId: 'codex' }), wt)],
    ['expectedGrantId on an enable', () => autoYesRoute.POST(request(`${AUTO_YES}?expectedGrantId=x`, 'POST', { enabled: true, duration: HOUR }), wt)],
    ['expectedGrantId naming no target', () => autoYesRoute.POST(request(`${AUTO_YES}?expectedGrantId=x`, 'POST', { enabled: false }), wt)],
  ])('%s: 400, nothing changes', async (_name, call) => {
    const other = setAutoYesEnabled(WT, 'codex', true, HOUR, undefined, 'codex');
    expect((await call()).status).toBe(400);
    expect(live()).toBe(other);
  });

  it('negative: no condition behaves as it did, and only `grantId` is added to the answer', async () => {
    const first = await (await arm()).json();
    expect(Object.keys(first).sort()).toEqual(
      ['answerMode', 'cliToolId', 'conflict', 'contractPolicy', 'enabled', 'expiresAt', 'grantId', 'instanceId', 'pollingStarted', 'resolvedBy'].sort(),
    );
    const second = await arm();
    expect(second.status).toBe(200);
    // A plain disable stops whichever grant is live: that is its contract.
    setAutoYesEnabled(WT, 'codex', true, 10800000, undefined, 'codex');
    const off = await (await disable()).json();
    expect(Object.keys(off).sort()).toEqual(['cliToolId', 'conflict', 'enabled', 'expiresAt', 'instanceId', 'pollingStarted', 'resolvedBy'].sort());
    expect(live()?.enabled).toBe(false);
  });
});

describe('[#4132-2] PUT instances/roles: expectedRosterRevision', () => {
  const put = (body: Record<string, unknown>) => instanceRolesRoute.PUT(request(ROLES, 'PUT', body), wt);

  it('positive: the id moved to another tool after the read: refused, nothing saved', async () => {
    const roleId = createAgentRole(db, { name: 'Reviewer', body: 'review' }).id;
    const read = await (await instanceRolesRoute.GET(request(ROLES, 'GET'), wt)).json();
    setAgentInstances(db, WT, [CLAUDE, { ...CODEX, id: 'helper', cliTool: 'codex', alias: 'Helper' }, { id: 'codex', cliTool: 'codex', alias: 'New', order: 2 }]);

    const response = await put({ instanceId: 'codex', role: { state: 'role', roleId }, expectedRosterRevision: read.rosterRevision });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('roster_changed');
    expect(getInstanceRoleState(db, WT, 'codex')).toEqual({ state: 'inherit' });
  });

  it('nothing moved: saved', async () => {
    const response = await put({ instanceId: 'codex', role: { state: 'none' }, expectedRosterRevision: rosterRevision() });
    expect(response.status).toBe(200);
    expect(getInstanceRoleState(db, WT, 'codex')).toEqual({ state: 'none' });
  });

  it('a revision that is no string: 400, nothing saved', async () => {
    expect((await put({ instanceId: 'codex', role: { state: 'none' }, expectedRosterRevision: 1 })).status).toBe(400);
    expect(getInstanceRoleState(db, WT, 'codex')).toEqual({ state: 'inherit' });
  });

  it('negative: no revision is not checked, and answers the same keys', async () => {
    setAgentInstances(db, WT, [CLAUDE, { ...CODEX, alias: 'Moved' }]);
    const response = await put({ instanceId: 'codex', role: { state: 'none' } });
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json()).sort()).toEqual(['instances', 'rosterRevision', 'rosterSaved', 'success', 'toolDefaults']);
  });
});

describe('[#4132-3] the CLI roster PATCH carries the revision it read', () => {
  /** Real PATCH route. The GET route needs tmux, so its answer is computed the way it does. */
  function serve(onRead?: (reads: number) => void): { patches: Array<Record<string, unknown>> } {
    const patches: Array<Record<string, unknown>> = [];
    let reads = 0;
    vi.stubEnv('CM_PORT', '4132');
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === `/api/worktrees/${WT}` && method === 'GET') {
        const roster = getAgentInstances(db, WT);
        const answer = Response.json({ id: WT, name: WT, agentInstances: roster, rosterRevision: computeRosterRevision(roster) });
        reads += 1;
        onRead?.(reads);
        return answer;
      }
      if (url.pathname === `/api/worktrees/${WT}` && method === 'PATCH') {
        patches.push(JSON.parse(String(init?.body)));
        return worktreeRoute.PATCH(new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]), wt);
      }
      if (url.pathname === '/api/capabilities') return Response.json({ serverVersion: 'test', capabilities: [] });
      throw new Error(`Not stubbed: ${method} ${url.pathname}`);
    });
    return { patches };
  }

  async function run(create: () => Command, args: string[]): Promise<number | undefined> {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let code: number | undefined;
    vi.spyOn(process, 'exit').mockImplementation(((value?: number) => {
      code = value ?? 0;
      throw new Error(`exit ${value}`);
    }) as never);
    await create().parseAsync(['node', 'cli', ...args]).catch(() => {});
    return code;
  }
  const otherAdd: AgentInstance = { id: 'copilot', cliTool: 'copilot', alias: 'Copilot', order: 2 };
  const moveOnce = (next: AgentInstance[]) => (reads: number) => {
    if (reads === 1) setAgentInstances(db, WT, next);
  };

  it('add: another add landing after the read is kept, and the id goes by what is really there', async () => {
    const { patches } = serve(moveOnce([CLAUDE, CODEX, otherAdd, { id: 'claude-2', cliTool: 'claude', alias: 'Taken', order: 3 }]));
    await run(createInstancesCommand, [WT, 'add', '--agent', 'claude']);
    expect(ids()).toEqual(['claude', 'codex', 'copilot', 'claude-2', 'claude-3']);
    expect(getAgentInstances(db, WT).find((row) => row.id === 'claude-2')?.alias).toBe('Taken');
    expect(patches).toHaveLength(2);
    expect(typeof patches[0].expectedRosterRevision).toBe('string');
  });

  it('positive control: the same PATCH with no revision erases that add', async () => {
    const read = getAgentInstances(db, WT);
    setAgentInstances(db, WT, [...read, otherAdd]);
    const response = await worktreeRoute.PATCH(
      request(`/api/worktrees/${WT}`, 'PATCH', { agentInstances: [...read, { id: 'claude-2', cliTool: 'claude', alias: 'C2', order: 2 }] }),
      wt,
    );
    expect(response.status).toBe(200);
    expect(ids()).toEqual(['claude', 'codex', 'claude-2']);
  });

  it('alias: another add landing after the read is kept', async () => {
    serve(moveOnce([CLAUDE, CODEX, otherAdd]));
    await run(createInstancesCommand, [WT, 'alias', 'codex', 'Lead']);
    expect(ids()).toEqual(['claude', 'codex', 'copilot']);
    expect(getAgentInstances(db, WT).find((row) => row.id === 'codex')?.alias).toBe('Lead');
  });

  it('alias: the instance left after the read: exits, nothing comes back', async () => {
    serve(moveOnce([CLAUDE, otherAdd]));
    expect(await run(createInstancesCommand, [WT, 'alias', 'codex', 'Lead'])).toBeDefined();
    expect(ids()).toEqual(['claude', 'copilot']);
  });

  it('remove: another add landing after the read is kept', async () => {
    serve(moveOnce([CLAUDE, CODEX, otherAdd]));
    await run(createInstancesCommand, [WT, 'remove', 'codex']);
    expect(ids()).toEqual(['claude', 'copilot']);
  });

  it('a roster that keeps moving: gives up with an error, and what others saved stays', async () => {
    let n = 0;
    const { patches } = serve(() => {
      n += 1;
      setAgentInstances(db, WT, [CLAUDE, { ...CODEX, alias: `Moved ${n}` }]);
    });
    expect(await run(createInstancesCommand, [WT, 'alias', 'claude', 'Lead'])).toBeDefined();
    expect(patches).toHaveLength(3);
    expect(getAgentInstances(db, WT).find((row) => row.id === 'claude')?.alias).toBe('Claude');
  });

  it('negative: a server that gives no revision is sent no condition', async () => {
    const patches: Array<Record<string, unknown>> = [];
    vi.stubEnv('CM_PORT', '4132');
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return Response.json({ id: WT, name: WT, agentInstances: getAgentInstances(db, WT) });
      patches.push(JSON.parse(String(init?.body)));
      return Response.json({});
    });
    await run(createInstancesCommand, [WT, 'alias', 'codex', 'Lead']);
    expect(patches).toHaveLength(1);
    expect(Object.keys(patches[0])).toEqual(['agentInstances']);
  });
});

describe('[#4132-4] creating with an idempotency key', () => {
  const KEY = 'k'.repeat(32);
  const OTHER_KEY = 'o'.repeat(32);
  const addBody = (extra: Record<string, unknown> = {}) => ({
    instance: { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2' },
    ...extra,
  });
  const post = ({ idempotencyKey, ...body }: Record<string, unknown>) =>
    instanceRolesRoute.POST(
      request(ROLES, 'POST', body, idempotencyKey === undefined ? {} : { [INSTANCE_CREATION_KEY_HEADER]: String(idempotencyKey) }),
      wt,
    );
  const settle = (idempotencyKey: unknown) =>
    settleRoute.POST(request(`${ROLES}/settle`, 'POST', { idempotencyKey }), wt);

  it('the same key sent again makes one, and says it is that one', async () => {
    const first = await post(addBody({ idempotencyKey: KEY, expectedRosterRevision: rosterRevision() }));
    expect(first.status).toBe(201);
    const staleRevision = 'stale';
    const again = await post(addBody({ idempotencyKey: KEY, expectedRosterRevision: staleRevision }));
    expect(again.status).toBe(200);
    const body = await again.json();
    expect(body.replayed).toBe(true);
    expect(body.created).toEqual({ instanceId: 'claude-2' });
    expect(Object.keys(body).sort()).toEqual(Object.keys(instanceCreateReplayExample).sort());
    expect(ids()).toEqual(['claude', 'codex', 'claude-2']);
  });

  it('the same key with other content is refused, not taken for that request', async () => {
    await post(addBody({ idempotencyKey: KEY }));
    const reused = await post({ instance: { id: 'claude-3', cliTool: 'claude', alias: 'C3' }, idempotencyKey: KEY });
    expect(reused.status).toBe(409);
    expect((await reused.json()).error).toBe('idempotency_key_reused');
    expect(ids()).toEqual(['claude', 'codex', 'claude-2']);
  });

  it('a refused create leaves no key behind: it can be sent again', async () => {
    const stale = await post(addBody({ idempotencyKey: KEY, expectedRosterRevision: 'stale' }));
    expect(stale.status).toBe(409);
    expect((await post(addBody({ idempotencyKey: KEY }))).status).toBe(201);
  });

  it("another request's identical row is not this one: settling cancels, and it is not claimed", async () => {
    // Tab A's add commits. Tab B's identical add, whose answer was lost, was refused.
    await post(addBody({ idempotencyKey: OTHER_KEY }));
    const refused = await post(addBody({ idempotencyKey: KEY }));
    expect(refused.status).toBe(409);
    const settled = await (await settle(KEY)).json();
    expect(settled.outcome).toBe('cancelled');
    expect(ids()).toEqual(['claude', 'codex', 'claude-2']);
  });

  it('settling a commit answers the instance it made', async () => {
    await post(addBody({ idempotencyKey: KEY }));
    const settled = await (await settle(KEY)).json();
    expect(settled).toEqual({ success: true, outcome: 'committed', instanceId: 'claude-2' });
    expect(Object.keys(settled).sort()).toEqual(Object.keys(instanceCreationSettleExamples.committed).sort());
  });

  it('a commit arriving after the check creates nothing, so adding again makes one', async () => {
    const before = await instanceRolesRoute.GET(request(ROLES, 'GET'), wt);
    const expectedRosterRevision = (await before.json()).rosterRevision;
    const settled = await (await settle(KEY)).json();
    expect(settled).toEqual(instanceCreationSettleExamples.cancelled);

    // The request whose answer was given up on reaches the server only now.
    const late = await post(addBody({ idempotencyKey: KEY, expectedRosterRevision }));
    expect(late.status).toBe(409);
    expect((await late.json()).error).toBe('creation_cancelled');
    expect(ids()).toEqual(['claude', 'codex']);

    const again = await post(addBody({ idempotencyKey: OTHER_KEY, expectedRosterRevision }));
    expect(again.status).toBe(201);
    expect(ids()).toEqual(['claude', 'codex', 'claude-2']);
  });

  it('settling twice answers the same', async () => {
    await settle(KEY);
    expect((await (await settle(KEY)).json()).outcome).toBe('cancelled');
  });

  it('positive control: with no key, a late commit after a read is a second row', async () => {
    await post({ instance: { id: 'claude-2', cliTool: 'claude', alias: 'First' } });
    await post({ instance: { id: 'claude-3', cliTool: 'claude', alias: 'Second' } });
    expect(ids()).toEqual(['claude', 'codex', 'claude-2', 'claude-3']);
  });

  it('a key is per worktree', async () => {
    upsertWorktree(db, { id: 'wt-b', name: 'wt-b', path: '/tmp/wt-b', repositoryPath: '/tmp', repositoryName: 'r' } as Worktree);
    await post(addBody({ idempotencyKey: KEY }));
    const elsewhere = await instanceRolesRoute.POST(
      request('/api/worktrees/wt-b/instances/roles', 'POST', addBody(), { [INSTANCE_CREATION_KEY_HEADER]: KEY }),
      params({ id: 'wt-b' }),
    );
    expect(elsewhere.status).toBe(201);
  });

  it('a failed role leaves neither the row nor the key', async () => {
    const missing = await post(addBody({ idempotencyKey: KEY, role: { state: 'role', roleId: 'nope' } }));
    expect(missing.status).toBe(404);
    expect(ids()).toEqual(['claude', 'codex']);
    expect((await (await settle(KEY)).json()).outcome).toBe('cancelled');
  });

  it.each([
    ['too short', 'short'],
    ['with a slash', `${'a'.repeat(20)}/x`],
    ['not a string', 12],
  ])('a key %s: 400', async (_name, idempotencyKey) => {
    expect((await post(addBody({ idempotencyKey }))).status).toBe(400);
    expect((await settle(idempotencyKey)).status).toBe(400);
    expect(ids()).toEqual(['claude', 'codex']);
  });

  it('settling for a worktree that is gone: 404', async () => {
    const response = await settleRoute.POST(
      request('/api/worktrees/nope/instances/roles/settle', 'POST', { idempotencyKey: KEY }),
      params({ id: 'nope' }),
    );
    expect(response.status).toBe(404);
  });

  it('negative: no key answers as it did', async () => {
    const response = await post(addBody());
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(Object.keys(instanceCreateExample).sort());
    const repeat = await post(addBody());
    expect(repeat.status).toBe(409);
    expect((await repeat.json()).error).toBe('instance_exists');
  });
});

describe('[#4132-5] renaming a role: expectedName', () => {
  const put = (id: string, { expectedName, ...body }: Record<string, unknown>) =>
    roleRoute.PUT(
      request(`/api/roles/${id}`, 'PUT', body, expectedName === undefined ? {} : { [EXPECTED_ROLE_NAME_HEADER]: encodeURIComponent(String(expectedName)) }),
      params({ id }),
    );
  const role = () => createAgentRole(db, { name: 'Original', body: 'text' });

  it('positive: another rename landed first: refused, and that name stays', async () => {
    const { id } = role();
    await put(id, { name: 'Theirs' });
    const response = await put(id, { name: 'Mine', expectedName: 'Original' });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('name_changed');
    expect(getAgentRole(db, id)?.name).toBe('Theirs');
  });

  it('a refused name takes the body with it', async () => {
    const { id } = role();
    await put(id, { name: 'Theirs' });
    expect((await put(id, { name: 'Mine', body: 'new', expectedName: 'Original' })).status).toBe(409);
    expect(getAgentRole(db, id)?.body).toBe('text');
  });

  it('nothing moved: renamed', async () => {
    const { id } = role();
    expect((await put(id, { name: 'Mine', expectedName: 'Original' })).status).toBe(200);
    expect(getAgentRole(db, id)?.name).toBe('Mine');
  });

  it('a name that is not ASCII goes through the header', async () => {
    const { id } = createAgentRole(db, { name: 'マーケター', body: 'text' });
    expect((await put(id, { name: 'Mine', expectedName: 'マーケター' })).status).toBe(200);
    expect(getAgentRole(db, id)?.name).toBe('Mine');
  });

  it('the name asked for is already there: nothing to refuse', async () => {
    const { id } = role();
    await put(id, { name: 'Mine' });
    expect((await put(id, { name: 'Mine', expectedName: 'Original' })).status).toBe(200);
  });

  it('a name that is not URI-encoded: 400', async () => {
    const { id } = role();
    const response = await roleRoute.PUT(
      request(`/api/roles/${id}`, 'PUT', { name: 'Mine' }, { [EXPECTED_ROLE_NAME_HEADER]: '%E0%A4%A' }),
      params({ id }),
    );
    expect(response.status).toBe(400);
    expect(getAgentRole(db, id)?.name).toBe('Original');
  });

  it('negative: no condition overwrites as it did', async () => {
    const { id } = role();
    await put(id, { name: 'Theirs' });
    expect((await put(id, { name: 'Mine' })).status).toBe(200);
    expect(getAgentRole(db, id)?.name).toBe('Mine');
  });
});
