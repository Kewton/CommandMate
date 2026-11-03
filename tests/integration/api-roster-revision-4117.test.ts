/**
 * `PATCH /api/worktrees/:id` and `expectedRosterRevision` (Issue #4117), through the
 * real routes. The bug: a client holding an older roster replaced the whole list and
 * erased what `POST /instances/roles` had created.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { getWorktreeById, upsertWorktree } from '@/lib/db';
import { getAgentInstances, setAgentInstances } from '@/lib/db/agent-instances-db';
import { createAgentRole, getInstanceRoleState } from '@/lib/db/agent-roles-db';
import type { AgentInstance } from '@/lib/cli-tools/types';

let testDb: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => testDb,
}));

// The worktree's GET also lists tmux and asks git. Neither is what this is about.
vi.mock('@/lib/tmux/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux')>()),
  listSessions: vi.fn(async () => []),
}));
vi.mock('@/lib/git/git-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/git/git-utils')>()),
  getGitStatus: vi.fn(async () => undefined),
}));

import { GET, PATCH } from '@/app/api/worktrees/[id]/route';
import * as instanceRolesRoute from '@/app/api/worktrees/[id]/instances/roles/route';

const WT = 'wt-4117';
const ROSTER: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
];

function request(url: string, method: string, body?: unknown): NextRequest {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as NextRequest;
}
const params = { params: Promise.resolve({ id: WT }) };

const patch = (body: unknown) => PATCH(request(`/api/worktrees/${WT}`, 'PATCH', body), params);

async function readRevision(): Promise<string> {
  const response = await instanceRolesRoute.GET(request(`/api/worktrees/${WT}/instances/roles`, 'GET'), params);
  return (await response.json()).rosterRevision;
}

async function createWithRole(id: string, roleId: string, expectedRosterRevision?: string): Promise<Response> {
  return instanceRolesRoute.POST(
    request(`/api/worktrees/${WT}/instances/roles`, 'POST', {
      instance: { id, cliTool: 'codex', alias: id },
      role: { state: 'role', roleId },
      ...(expectedRosterRevision ? { expectedRosterRevision } : {}),
    }),
    params,
  );
}

beforeEach(() => {
  testDb = new Database(':memory:');
  runMigrations(testDb);
  testDb.pragma('foreign_keys = ON');
  upsertWorktree(testDb, {
    id: WT,
    name: 'feature/4117',
    path: '/repos/commandmate-issue-4117',
    repositoryPath: '/repos/commandmate',
    repositoryName: 'commandmate',
  });
  setAgentInstances(testDb, WT, ROSTER);
});

afterEach(() => {
  testDb.close();
});

describe('[#4117] PATCH with expectedRosterRevision', () => {
  it('a client that read before the create is refused, and the create survives', async () => {
    const role = createAgentRole(testDb, { name: 'Reviewer', body: 'b' });
    const stale = await readRevision();
    expect((await createWithRole('codex-2', role.id)).status).toBe(201);

    const response = await patch({
      agentInstances: [{ ...ROSTER[0], alias: 'Lead' }, ROSTER[1]],
      expectedRosterRevision: stale,
      description: 'must not land',
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('ROSTER_CHANGED');
    expect(body.rosterRevision).toBe(await readRevision());
    expect(body.agentInstances.map((i: AgentInstance) => i.id)).toEqual(['claude', 'codex', 'codex-2']);
    // Nothing of the request was written, not only the roster.
    expect(getWorktreeById(testDb, WT)?.description ?? null).toBeNull();
    expect(getAgentInstances(testDb, WT).map((i) => i.id)).toEqual(['claude', 'codex', 'codex-2']);
    expect(getInstanceRoleState(testDb, WT, 'codex-2')).toMatchObject({ state: 'role', roleId: role.id });
  });

  it('a current revision saves, and the answer carries what to send next', async () => {
    const first = await patch({
      agentInstances: [{ ...ROSTER[0], alias: 'Lead' }, ROSTER[1]],
      expectedRosterRevision: await readRevision(),
    });
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.agentInstances[0].alias).toBe('Lead');
    expect(body.rosterRevision).toBe(await readRevision());

    const second = await patch({ agentInstances: [ROSTER[1], ROSTER[0]], expectedRosterRevision: body.rosterRevision });
    expect(second.status).toBe(200);
  });

  it('the revision the POST route answers is the one the PATCH checks, and the other way round', async () => {
    const role = createAgentRole(testDb, { name: 'Reviewer', body: 'b' });
    const created = await (await createWithRole('codex-2', role.id, await readRevision())).json();
    const patched = await patch({
      agentInstances: getAgentInstances(testDb, WT),
      expectedRosterRevision: created.rosterRevision,
    });
    expect(patched.status).toBe(200);
    const { rosterRevision } = await patched.json();
    expect((await createWithRole('codex-3', role.id, rosterRevision)).status).toBe(201);
  });

  it('a derived roster has a revision too', async () => {
    setAgentInstances(testDb, WT, [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }]);
    testDb.prepare('DELETE FROM agent_instances WHERE worktree_id = ?').run(WT);
    const response = await patch({ agentInstances: ROSTER, expectedRosterRevision: await readRevision() });
    expect(response.status).toBe(200);
  });

  it('refuses a revision that is not a string', async () => {
    const response = await patch({ agentInstances: ROSTER, expectedRosterRevision: 7 });
    expect(response.status).toBe(400);
    expect(getAgentInstances(testDb, WT).map((i) => i.id)).toEqual(['claude', 'codex']);
  });

  it('negative control: a client that sends no condition replaces the list as before', async () => {
    const role = createAgentRole(testDb, { name: 'Reviewer', body: 'b' });
    await createWithRole('codex-2', role.id);
    const response = await patch({ agentInstances: ROSTER });
    expect(response.status).toBe(200);
    expect(getAgentInstances(testDb, WT).map((i) => i.id)).toEqual(['claude', 'codex']);
  });

  it('negative control: a PATCH of other fields needs no condition', async () => {
    const response = await patch({ description: 'hello' });
    expect(response.status).toBe(200);
    expect(getWorktreeById(testDb, WT)?.description).toBe('hello');
  });
});

describe('[#4117] GET answers the revision with the roster', () => {
  const read = async () => (await GET(request(`/api/worktrees/${WT}`, 'GET'), params)).json();

  it('is the revision the role route answers, and PATCH accepts it', async () => {
    const body = await read();
    expect(body.rosterRevision).toBe(await readRevision());
    expect(body.agentInstances.map((i: AgentInstance) => i.id)).toEqual(['claude', 'codex']);
    const saved = await patch({
      agentInstances: [{ ...ROSTER[0], alias: 'Lead' }, ROSTER[1]],
      expectedRosterRevision: body.rosterRevision,
    });
    expect(saved.status).toBe(200);
  });

  it('is computed from the roster alone, whatever else the row carries', async () => {
    const before = await read();
    expect(before.agentInstances[0].sessionName).toEqual(expect.any(String));
    setAgentInstances(testDb, WT, [{ ...ROSTER[0], alias: 'Lead' }, ROSTER[1]]);
    const after = await read();
    expect(after.rosterRevision).not.toBe(before.rosterRevision);
    expect(after.rosterRevision).toBe(await readRevision());
  });

  it('a revision read before a create is refused after it', async () => {
    const role = createAgentRole(testDb, { name: 'Reviewer', body: 'b' });
    const { rosterRevision } = await read();
    expect((await createWithRole('codex-2', role.id)).status).toBe(201);
    const refused = await patch({ agentInstances: ROSTER, expectedRosterRevision: rosterRevision });
    expect(refused.status).toBe(409);
    expect(getAgentInstances(testDb, WT).map((i) => i.id)).toEqual(['claude', 'codex', 'codex-2']);
  });

  it('negative control: a PATCH with no condition still saves', async () => {
    const saved = await patch({ agentInstances: [{ ...ROSTER[0], alias: 'Lead' }, ROSTER[1]] });
    expect(saved.status).toBe(200);
  });
});
