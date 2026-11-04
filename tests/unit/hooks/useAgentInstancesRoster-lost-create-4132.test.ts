/**
 * Issue #4132: a create whose answer was lost goes by its key, not by what the row
 * looks like. Driven with the fake server, which keeps keys the way the routes do
 * (`tests/integration/roster-race-windows-4132.test.ts` holds it to them).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { enqueueRosterCreate } from '@/hooks/useAgentInstancesRoster';
import { clearRosterSnapshot } from '@/hooks/useInstanceRoleSettings';
import { INSTANCE_CREATION_KEY_HEADER } from '@/types/agent-roles';
import { FakeRoleServer, loseNextAnswer } from '../components/roles/fake-role-server';

const WT = 'wt-4132-hook';
const ROLES = '/instances/roles';
const CLAUDE: AgentInstance = { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 };
const TWO: AgentInstance = { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2', order: 1 };
const add = () => ({ id: 'claude-2', cliTool: 'claude', alias: 'Claude 2' });
const create = (onSaved = vi.fn()) => enqueueRosterCreate(WT, add, { state: 'inherit' }, onSaved);
const ids = (server: FakeRoleServer) => server.roster.map((row) => row.id);
const creates = (server: FakeRoleServer) => server.calls.filter((call) => call.method === 'POST' && call.url.endsWith(ROLES));

describe('[#4132] a create whose answer was lost', () => {
  let server: FakeRoleServer;

  beforeEach(() => {
    server = new FakeRoleServer([CLAUDE]);
    global.fetch = server.fetch as unknown as typeof fetch;
    clearRosterSnapshot(WT);
  });
  afterEach(() => clearRosterSnapshot(WT));

  it('sends a key, and another for each create', async () => {
    await create();
    server.roster = [CLAUDE];
    server.revisionNumber += 1;
    clearRosterSnapshot(WT);
    await create();
    const keys = creates(server).map((call) => call.headers?.[INSTANCE_CREATION_KEY_HEADER]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('it committed: saved', async () => {
    loseNextAnswer(server, 'POST', ROLES, '500', { committed: true });
    const onSaved = vi.fn();
    const result = await create(onSaved);
    expect(result.status).toBe('saved');
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(ids(server)).toEqual(['claude', 'claude-2']);
  });

  it('positive: the same row from another tab is not taken for this one', async () => {
    // Tab A's identical add lands; this tab's request is refused and the refusal is lost.
    loseNextAnswer(server, 'POST', ROLES, 'network', { committed: false });
    const passOn = global.fetch;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).endsWith(ROLES)) server.changeRosterElsewhere([CLAUDE, TWO]);
      return (passOn as typeof fetch)(url, init);
    }) as unknown as typeof fetch;
    const onSaved = vi.fn();
    const result = await create(onSaved);
    expect(result).toEqual({ status: 'saved_unverified', unconfirmed: true });
    expect(onSaved).not.toHaveBeenCalled();
    expect(ids(server)).toEqual(['claude', 'claude-2']);
  });

  it('positive: a request that commits after the check makes nothing, and adding again makes one', async () => {
    loseNextAnswer(server, 'POST', ROLES, 'network', { committed: false });
    expect((await create()).status).toBe('failed');
    const lost = creates(server)[0];

    // It reaches the server only now.
    const late = await server.fetch(`/api/worktrees/${WT}/instances/roles`, { method: 'POST', body: JSON.stringify(lost.body), headers: lost.headers });
    expect(late.status).toBe(409);
    expect(ids(server)).toEqual(['claude']);

    expect((await create()).status).toBe('saved');
    expect(ids(server)).toEqual(['claude', 'claude-2']);
  });

  it('the settling itself gets no answer: not claimed, and nothing added', async () => {
    loseNextAnswer(server, 'POST', ROLES, 'network', { committed: false });
    const passOn = global.fetch;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/settle')) throw new TypeError('Failed to fetch');
      return (passOn as typeof fetch)(url, init);
    }) as unknown as typeof fetch;
    expect(await create()).toEqual({ status: 'saved_unverified', unconfirmed: true });
    expect(ids(server)).toEqual(['claude']);
  });

  it('negative: an answered create asks nothing further', async () => {
    expect((await create()).status).toBe('saved');
    expect(server.calls.filter((call) => call.url.endsWith('/settle'))).toEqual([]);
  });
});
