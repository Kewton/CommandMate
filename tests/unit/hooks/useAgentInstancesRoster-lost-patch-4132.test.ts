/**
 * Issue #4132: a roster PATCH whose answer was lost goes by its key, as a create does,
 * not by what the list looks like. The fake server keeps keys the way the routes do
 * (`tests/integration/roster-race-windows-4132.test.ts` holds it to them).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { enqueueRosterWrite } from '@/hooks/useAgentInstancesRoster';
import { clearRosterSnapshot } from '@/hooks/useInstanceRoleSettings';
import { INSTANCE_CREATION_KEY_HEADER } from '@/types/agent-roles';
import { FakeRoleServer, loseNextAnswer } from '../components/roles/fake-role-server';

const WT = 'wt-4132-patch';
const CLAUDE: AgentInstance = { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 };
const TWO: AgentInstance = { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2', order: 1 };
const add = (base: AgentInstance[]) => [...base, { ...TWO, order: base.length }];
const write = (onSaved = vi.fn()) => enqueueRosterWrite(WT, add, onSaved);
const ids = (server: FakeRoleServer) => server.roster.map((row) => row.id);
const patches = (server: FakeRoleServer) => server.calls.filter((call) => call.method === 'PATCH');
const UNKNOWN = { status: 'saved_unverified', unconfirmed: true };

describe('[#4132] a roster PATCH whose answer was lost', () => {
  let server: FakeRoleServer;

  beforeEach(() => {
    server = new FakeRoleServer([CLAUDE]);
    global.fetch = server.fetch as unknown as typeof fetch;
    clearRosterSnapshot(WT);
  });
  afterEach(() => clearRosterSnapshot(WT));

  /** Runs `change` as the settling leaves. */
  function atTheSettling(change: () => void): void {
    const passOn = global.fetch;
    let done = false;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (!done && String(url).endsWith('/settle')) {
        done = true;
        change();
      }
      return (passOn as typeof fetch)(url, init);
    }) as unknown as typeof fetch;
  }

  it('sends a key in a header, another for each attempt, and leaves the body as it was', async () => {
    const passOn = global.fetch;
    let refused = false;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (!refused && init?.method === 'PATCH') {
        refused = true;
        server.changeRosterElsewhere([{ ...CLAUDE, alias: 'Moved' }]);
      }
      return (passOn as typeof fetch)(url, init);
    }) as unknown as typeof fetch;
    expect((await write()).status).toBe('saved');
    const keys = patches(server).map((call) => call.headers?.[INSTANCE_CREATION_KEY_HEADER]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(keys[1]).not.toBe(keys[0]);
    expect(Object.keys(patches(server)[1].body).sort()).toEqual(['agentInstances', 'expectedRosterRevision']);
  });

  it('it committed: saved, with the roster read after it', async () => {
    loseNextAnswer(server, 'PATCH', WT, '500', { committed: true });
    const onSaved = vi.fn();
    const result = await write(onSaved);
    expect(result.status).toBe('saved');
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(ids(server)).toEqual(['claude', 'claude-2']);
  });

  it('positive: the same list from another tab is not taken for this one', async () => {
    loseNextAnswer(server, 'PATCH', WT, 'network', { committed: false });
    const passOn = global.fetch;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') server.changeRosterElsewhere([CLAUDE, TWO]);
      return (passOn as typeof fetch)(url, init);
    }) as unknown as typeof fetch;
    const onSaved = vi.fn();
    expect(await write(onSaved)).toEqual(UNKNOWN);
    expect(onSaved).not.toHaveBeenCalled();
    expect(ids(server)).toEqual(['claude', 'claude-2']);
  });

  it('positive: a request that commits after the check makes nothing, and adding again makes one', async () => {
    loseNextAnswer(server, 'PATCH', WT, 'network', { committed: false });
    expect((await write()).status).toBe('failed');
    const lost = patches(server)[0];

    const late = await server.fetch(`/api/worktrees/${WT}`, { method: 'PATCH', body: JSON.stringify(lost.body), headers: lost.headers });
    expect(late.status).toBe(409);
    expect(ids(server)).toEqual(['claude']);

    expect((await write()).status).toBe('saved');
    expect(ids(server)).toEqual(['claude', 'claude-2']);
  });

  it('positive: its row was removed and the id made again: the old key does not claim that row', async () => {
    loseNextAnswer(server, 'PATCH', WT, '500', { committed: true });
    atTheSettling(() => {
      server.changeRosterElsewhere([CLAUDE]);
      server.changeRosterElsewhere([CLAUDE, { ...TWO, alias: 'Theirs' }]);
    });
    const onSaved = vi.fn();
    expect(await write(onSaved)).toEqual(UNKNOWN);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('positive: the settling gets no answer: not claimed, though the list is what was sent', async () => {
    loseNextAnswer(server, 'PATCH', WT, 'network', { committed: true });
    const passOn = global.fetch;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/settle')) throw new TypeError('Failed to fetch');
      return (passOn as typeof fetch)(url, init);
    }) as unknown as typeof fetch;
    const onSaved = vi.fn();
    expect(await write(onSaved)).toEqual(UNKNOWN);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('it did not commit, and nothing can be read: failed, since the settling said so', async () => {
    loseNextAnswer(server, 'PATCH', WT, 'network', { committed: false });
    const passOn = global.fetch;
    let read = 0;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method && read++ > 0) throw new TypeError('Failed to fetch');
      return (passOn as typeof fetch)(url, init);
    }) as unknown as typeof fetch;
    expect((await write()).status).toBe('failed');
  });

  it('negative: an answered PATCH asks nothing further', async () => {
    expect((await write()).status).toBe('saved');
    expect(server.calls.filter((call) => call.url.endsWith('/settle'))).toEqual([]);
  });

  it('negative: a failure answered with no 5xx is a failure, and asks nothing further', async () => {
    const passOn = global.fetch;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'PATCH' ? ({ ok: false, json: async () => ({}) } as Response) : (passOn as typeof fetch)(url, init),
    ) as unknown as typeof fetch;
    expect((await write()).status).toBe('failed');
    expect(server.calls.filter((call) => call.url.endsWith('/settle'))).toEqual([]);
  });

  it('negative: a write the server refused asks nothing further', async () => {
    const passOn = global.fetch;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'PATCH' ? ({ ok: false, status: 400, json: async () => ({}) } as Response) : (passOn as typeof fetch)(url, init),
    ) as unknown as typeof fetch;
    expect((await write()).status).toBe('failed');
    expect(server.calls.filter((call) => call.url.endsWith('/settle'))).toEqual([]);
  });
});
