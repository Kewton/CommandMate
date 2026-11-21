/**
 * Issue #4498: a delivery decides rule 0 and the session it types into from ONE
 * successful resolution of the requester, and never from the display fallback
 * (`resolveRelaySession` answers claude when the roster cannot be read).
 *
 * - T1 / A1: the requester's read fails once → nothing sent, nothing claimed, the
 *   payload kept (`held`); the next pump (or a restarted server's) sends it once,
 *   to the tool the roster names.
 * - A2: the readiness check is not asked about a guessed tool either.
 * - T2: the display read and the policy read disagree (claude vs codex) → the send
 *   goes only to the tool the delivery's own read resolved, which rule 0 judged.
 * - T4: the roster moves while the readiness check awaits (a row removed, an id
 *   given another tool, the read failing once) → never the guessed tool.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRelay, getRelayById, getRelayPendingPayload, stashRelayPayload } from '@/lib/db/relay-db';
import { isOpenRelayState, type RelayEndpoint } from '@/lib/relay/types';

let db: Database.Database;

const sendUserMessage = vi.fn();
const findRelayHoldReason = vi.fn();
/** Fault injection on the roster read: the next N reads for one instance id throw. */
const rosterFault = vi.hoisted(() => ({ instanceId: null as string | null, remaining: 0 }));
/** T2: what the display resolver answers for the requester (as if it fell back). */
const displayOverride = vi.hoisted(() => ({ cliToolId: null as string | null }));
/** r1 (I2): what rule 0's own reading of the requester would answer, if it read again. */
const endpointOverride = vi.hoisted(() => ({ cliToolId: null as string | null }));

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));
vi.mock('@/lib/relay/relay-readiness', () => ({
  findRelayHoldReason: (...args: unknown[]) => findRelayHoldReason(...args),
}));
vi.mock('@/lib/db/agent-instances-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/agent-instances-db')>();
  return {
    ...actual,
    getAgentInstance: (...args: Parameters<typeof actual.getAgentInstance>) => {
      if (rosterFault.remaining > 0 && args[2] === rosterFault.instanceId) {
        rosterFault.remaining -= 1;
        throw new Error('roster unreadable (injected)');
      }
      return actual.getAgentInstance(...args);
    },
  };
});
vi.mock('@/lib/relay/relay-session-ref', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relay/relay-session-ref')>();
  return {
    ...actual,
    resolveRelaySession: (...args: Parameters<typeof actual.resolveRelaySession>) => {
      const resolved = actual.resolveRelaySession(...args);
      if (displayOverride.cliToolId !== null && args[1].instanceId === REQ_ID) {
        return { ...resolved, cliToolId: displayOverride.cliToolId as typeof resolved.cliToolId };
      }
      return resolved;
    },
    resolveRelayEndpointTool: (...args: Parameters<typeof actual.resolveRelayEndpointTool>) => {
      if (endpointOverride.cliToolId !== null && args[1].instanceId === REQ_ID) {
        return endpointOverride.cliToolId as ReturnType<typeof actual.resolveRelayEndpointTool>;
      }
      return actual.resolveRelayEndpointTool(...args);
    },
  };
});

const { pumpRelayDeliveries, resetRelayDeliveryState } = await import('@/lib/relay/relay-delivery');

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const REQ_ID = 'rev-1';
/** The requester: a roster codex instance in a worktree whose own default is codex too. */
const REQUESTER: RelayEndpoint = { worktreeId: 'wt-a', instanceId: REQ_ID };
const WORKER: RelayEndpoint = { worktreeId: 'wt-b', instanceId: 'codex' };

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(`INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    id, id, `/tmp/${id}`, cliToolId, NOW,
  );
}

function addRosterInstance(endpoint: RelayEndpoint, cliToolId: string): void {
  db.prepare(
    `INSERT INTO agent_instances (worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at) VALUES (?, ?, ?, '', 0, ?)`,
  ).run(endpoint.worktreeId, endpoint.instanceId, cliToolId, NOW);
}

function openRelayWithReply(): string {
  const relay = createRelay(db, { from: REQUESTER, to: WORKER, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
  expect(stashRelayPayload(db, relay.id, 'reply', '[from B] done', NOW)).toBe(true);
  return relay.id;
}

const deliveryState = (relayId: string): unknown =>
  (db.prepare('SELECT delivery_state FROM session_relays WHERE id = ?').get(relayId) as { delivery_state: unknown })
    .delivery_state;

/** The requester's read throws `times` times, starting with the first read after the readiness await. */
function failRequesterAfterReadiness(times = 1): void {
  findRelayHoldReason.mockImplementationOnce(async () => {
    rosterFault.instanceId = REQ_ID;
    rosterFault.remaining = times;
    return null;
  });
}

/** Every tool the send went to. */
const sentTools = (): unknown[] => sendUserMessage.mock.calls.map((call) => (call[1] as { cliToolId: unknown }).cliToolId);

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertWorktree('wt-a', 'codex');
  insertWorktree('wt-b', 'codex');
  addRosterInstance(REQUESTER, 'codex');
  rosterFault.instanceId = null;
  rosterFault.remaining = 0;
  displayOverride.cliToolId = null;
  endpointOverride.cliToolId = null;
  resetRelayDeliveryState();
  sendUserMessage.mockReset();
  sendUserMessage.mockResolvedValue({ ok: true, message: { id: 'm1' } });
  findRelayHoldReason.mockReset();
  findRelayHoldReason.mockResolvedValue(null);
  vi.stubEnv('CM_ANTIGRAVITY_USAGE', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRelayDeliveryState();
  db.close();
});

describe('Issue #4498 T1 (A1): a requester read that fails once holds the payload', () => {
  it('4498 T1 the read after the readiness await fails once: nothing sent, not claimed, payload kept, relay open', async () => {
    const relayId = openRelayWithReply();
    failRequesterAfterReadiness();
    await pumpRelayDeliveries();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(deliveryState(relayId)).toBeNull();
    expect(getRelayPendingPayload(db, relayId)).toMatchObject({ kind: 'reply', body: '[from B] done' });
    expect(isOpenRelayState(getRelayById(db, relayId)?.state ?? 'cancelled')).toBe(true);
  });

  it('4498 T1 the next pump resolves: sent once, to codex (the roster tool)', async () => {
    const relayId = openRelayWithReply();
    failRequesterAfterReadiness();
    await pumpRelayDeliveries();
    await pumpRelayDeliveries();
    expect(sentTools()).toEqual(['codex']);
    expect(sendUserMessage.mock.calls[0][1]).toMatchObject({ worktreeId: 'wt-a', instanceId: REQ_ID });
    expect(getRelayPendingPayload(db, relayId)).toBeNull();
    await pumpRelayDeliveries();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('4498 T1 a server restart between the two pumps: the held payload is sent once, to codex', async () => {
    openRelayWithReply();
    failRequesterAfterReadiness();
    await pumpRelayDeliveries();
    resetRelayDeliveryState();
    await pumpRelayDeliveries();
    await pumpRelayDeliveries();
    expect(sentTools()).toEqual(['codex']);
  });

  it('4498 T1 control — nothing fails: delivered on the first pump, to codex', async () => {
    openRelayWithReply();
    await pumpRelayDeliveries();
    expect(sentTools()).toEqual(['codex']);
  });
});

describe('Issue #4498 A2: the readiness check is never asked about a guessed tool', () => {
  it('4498 A2 every read of the requester fails for a pump: readiness not asked, nothing sent, payload kept', async () => {
    // Declared, so rule 0 restricts no tool and the unreadable ends are not withdrawn:
    // what is left to see is which tool the readiness check and the send were given.
    vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'api-key');
    const relayId = openRelayWithReply();
    rosterFault.instanceId = REQ_ID;
    rosterFault.remaining = Number.MAX_SAFE_INTEGER;
    await pumpRelayDeliveries();
    expect(findRelayHoldReason.mock.calls.map((call) => call[1])).not.toContain('claude');
    expect(findRelayHoldReason).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayPendingPayload(db, relayId)).toMatchObject({ kind: 'reply' });

    rosterFault.remaining = 0;
    await pumpRelayDeliveries();
    expect(findRelayHoldReason.mock.calls.map((call) => call[1])).toEqual(['codex']);
    expect(sentTools()).toEqual(['codex']);
  });
});

describe('Issue #4498 T2: the display read and the policy read disagree', () => {
  it('4498 T2 display says claude, the roster says codex: typed only into codex, never claude', async () => {
    displayOverride.cliToolId = 'claude';
    openRelayWithReply();
    await pumpRelayDeliveries();
    expect(sentTools()).not.toContain('claude');
    expect(sentTools()).toEqual(['codex']);
    expect(findRelayHoldReason.mock.calls.map((call) => call[1])).toEqual(['codex']);
  });
});

describe('Issue #4498 T4: the roster moves while the readiness check awaits', () => {
  it('4498 T4 the row is removed and the read fails once: held, not typed into claude; then the worktree default', async () => {
    openRelayWithReply();
    findRelayHoldReason.mockImplementationOnce(async () => {
      db.prepare('DELETE FROM agent_instances WHERE worktree_id = ? AND instance_id = ?').run('wt-a', REQ_ID);
      rosterFault.instanceId = REQ_ID;
      rosterFault.remaining = 1;
      return null;
    });
    await pumpRelayDeliveries();
    expect(sendUserMessage).not.toHaveBeenCalled();
    await pumpRelayDeliveries();
    // The roster no longer names it: the shared resolver's answer (the worktree's own tool), as `/send` would.
    expect(sentTools()).toEqual(['codex']);
  });

  it('4498 T4 the id is given another tool (codex → gemini): typed once into the re-resolved tool, judged on it', async () => {
    openRelayWithReply();
    findRelayHoldReason.mockImplementationOnce(async () => {
      db.prepare('UPDATE agent_instances SET cli_tool_id = ? WHERE worktree_id = ? AND instance_id = ?').run('gemini', 'wt-a', REQ_ID);
      return null;
    });
    await pumpRelayDeliveries();
    expect(sentTools()).toEqual(['gemini']);
  });

  it('4498 T4 the id is given antigravity mid-await: withdrawn by rule 0, nothing typed (I5 unchanged)', async () => {
    const relayId = openRelayWithReply();
    findRelayHoldReason.mockImplementationOnce(async () => {
      db.prepare('UPDATE agent_instances SET cli_tool_id = ? WHERE worktree_id = ? AND instance_id = ?').run('antigravity', 'wt-a', REQ_ID);
      return null;
    });
    await pumpRelayDeliveries();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relayId)?.state).toBe('cancelled');
  });
});

describe('Issue #4498 r1 (I2): rule 0 judges the resolution the send uses, not a second read', () => {
  it('4498 r1 I2 a second read of the requester would say antigravity: judged on the one resolution (codex), sent once, not withdrawn', async () => {
    // Undeclared: a second read answering antigravity would withdraw the relay.
    const relayId = openRelayWithReply();
    findRelayHoldReason.mockImplementationOnce(async () => {
      endpointOverride.cliToolId = 'antigravity';
      return null;
    });
    await pumpRelayDeliveries();
    expect(sentTools()).toEqual(['codex']);
    expect(getRelayById(db, relayId)?.state).not.toBe('cancelled');
  });
});

describe('Issue #4498 r1: a registered requester whose roster row goes away is not typed into under another tool', () => {
  /** Default claude, the instance registered as codex: a non-primary id, so a lost row resolves to claude. */
  const REG: RelayEndpoint = { worktreeId: 'wt-c', instanceId: 'reg-9' };

  function openFrom(from: RelayEndpoint): string {
    const relay = createRelay(db, { from, to: WORKER, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    expect(stashRelayPayload(db, relay.id, 'reply', '[from B] done', NOW)).toBe(true);
    return relay.id;
  }
  const removeRow = (endpoint: RelayEndpoint): void => {
    db.prepare('DELETE FROM agent_instances WHERE worktree_id = ? AND instance_id = ?').run(endpoint.worktreeId, endpoint.instanceId);
  };

  beforeEach(() => {
    insertWorktree('wt-c', 'claude');
  });

  it('4498 r1 the row goes away during the readiness check: nothing sent, held; held again next pump; the row back → codex once', async () => {
    addRosterInstance(REG, 'codex');
    const relayId = openFrom(REG);
    findRelayHoldReason.mockImplementationOnce(async () => {
      removeRow(REG);
      return null;
    });
    await pumpRelayDeliveries();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(deliveryState(relayId)).toBeNull();
    expect(getRelayPendingPayload(db, relayId)).toMatchObject({ kind: 'reply' });

    await pumpRelayDeliveries();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(isOpenRelayState(getRelayById(db, relayId)?.state ?? 'cancelled')).toBe(true);
    expect(getRelayPendingPayload(db, relayId)).toMatchObject({ kind: 'reply' });

    addRosterInstance(REG, 'codex');
    await pumpRelayDeliveries();
    await pumpRelayDeliveries();
    expect(sentTools()).toEqual(['codex']);
    expect(sendUserMessage.mock.calls[0][1]).toMatchObject({ worktreeId: 'wt-c', instanceId: 'reg-9' });
  });

  it('4498 r1 negative control — an ad-hoc id never on the roster goes to the worktree default (claude)', async () => {
    openFrom({ worktreeId: 'wt-c', instanceId: 'helper-7' });
    await pumpRelayDeliveries();
    expect(sentTools()).toEqual(['claude']);
  });

  it('4498 r1 the shared resolver\'s last resort (the worktree declares no usable tool): held, never the assumed claude', async () => {
    db.prepare('UPDATE worktrees SET cli_tool_id = ? WHERE id = ?').run('not-a-tool', 'wt-c');
    const relayId = openFrom({ worktreeId: 'wt-c', instanceId: 'helper-7' });
    await pumpRelayDeliveries();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayPendingPayload(db, relayId)).toMatchObject({ kind: 'reply' });
  });
});
