/**
 * Issue #4437 (PR1, server), re-instruction 1: the relay pump judges the state
 * it actually sends to and leaves behind.
 *
 * - I6a: the tool policy is judged after the last await before the send, on the
 *   endpoints resolved again there. An instance switched to antigravity while
 *   the readiness check awaited is not typed into: the relay is cancelled and
 *   the payload is never claimed.
 * - I6b: an open relay with antigravity at either end does not stay open after
 *   a pump, whether or not it carries a payload.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRelay, getRelayById, getRelayPendingPayload, stashRelayPayload } from '@/lib/db/relay-db';
import type { RelayEndpoint } from '@/lib/relay/types';

let db: Database.Database;

const sendUserMessage = vi.fn();
const findRelayHoldReason = vi.fn();
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));
vi.mock('@/lib/relay/relay-readiness', () => ({
  findRelayHoldReason: (...args: unknown[]) => findRelayHoldReason(...args),
}));

const { pumpRelayDeliveries, resetRelayDeliveryState } = await import('@/lib/relay/relay-delivery');

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
/** Roster instances: the tool each one runs is what the test switches. */
const REQUESTER: RelayEndpoint = { worktreeId: 'wt-a', instanceId: 'req-1' };
const WORKER: RelayEndpoint = { worktreeId: 'wt-b', instanceId: 'work-1' };
const CLAUDE: RelayEndpoint = { worktreeId: 'wt-a', instanceId: 'claude' };
const CODEX: RelayEndpoint = { worktreeId: 'wt-b', instanceId: 'codex' };
const AGY: RelayEndpoint = { worktreeId: 'wt-c', instanceId: 'antigravity' };

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(`INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    id,
    `/tmp/${id}`,
    cliToolId,
    NOW,
  );
}

function addRosterInstance(endpoint: RelayEndpoint, cliToolId: string): void {
  db.prepare(
    `INSERT INTO agent_instances (worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at) VALUES (?, ?, ?, '', 0, ?)`,
  ).run(endpoint.worktreeId, endpoint.instanceId, cliToolId, NOW);
}

function switchTool(endpoint: RelayEndpoint, cliToolId: string): void {
  const changed = db
    .prepare(`UPDATE agent_instances SET cli_tool_id = ? WHERE worktree_id = ? AND instance_id = ?`)
    .run(cliToolId, endpoint.worktreeId, endpoint.instanceId).changes;
  expect(changed).toBe(1);
}

function openRelayWithReply(from: RelayEndpoint, to: RelayEndpoint): string {
  const relay = createRelay(db, { from, to, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
  expect(stashRelayPayload(db, relay.id, 'reply', '[from B] done', NOW)).toBe(true);
  return relay.id;
}

const deliveryState = (relayId: string): unknown =>
  (db.prepare('SELECT delivery_state FROM session_relays WHERE id = ?').get(relayId) as { delivery_state: unknown })
    .delivery_state;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertWorktree('wt-a', 'claude');
  insertWorktree('wt-b', 'codex');
  insertWorktree('wt-c', 'antigravity');
  addRosterInstance(REQUESTER, 'claude');
  addRosterInstance(WORKER, 'codex');
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

describe('Issue #4437 I6a: judged on the endpoints re-resolved after the last await', () => {
  /** The readiness check is the last await before the send: switch the tool inside it. */
  function switchDuringReadiness(endpoint: RelayEndpoint): void {
    findRelayHoldReason.mockImplementationOnce(async () => {
      switchTool(endpoint, 'antigravity');
      return null;
    });
  }

  it.each([
    ['requester', REQUESTER],
    ['worker', WORKER],
  ] as const)('the %s switched to antigravity mid-await: nothing sent, cancelled, not claimed (4437)', async (_label, endpoint) => {
    const relayId = openRelayWithReply(REQUESTER, WORKER);
    switchDuringReadiness(endpoint);
    await pumpRelayDeliveries();
    expect(findRelayHoldReason).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relayId)?.state).toBe('cancelled');
    expect(getRelayPendingPayload(db, relayId)).toBeNull();
    expect(deliveryState(relayId)).toBeNull();
  });

  it('declared (api-key): the switched requester is sent to as before (4437)', async () => {
    vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'api-key');
    const relayId = openRelayWithReply(REQUESTER, WORKER);
    switchDuringReadiness(REQUESTER);
    await pumpRelayDeliveries();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage.mock.calls[0][1]).toMatchObject({ worktreeId: 'wt-a', instanceId: 'req-1', cliToolId: 'antigravity' });
    expect(getRelayById(db, relayId)?.state).not.toBe('cancelled');
  });

  it('nothing switched: the roster relay is delivered as before (4437)', async () => {
    const relayId = openRelayWithReply(REQUESTER, WORKER);
    await pumpRelayDeliveries();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage.mock.calls[0][1]).toMatchObject({ worktreeId: 'wt-a', instanceId: 'req-1', cliToolId: 'claude' });
    expect(getRelayById(db, relayId)?.state).not.toBe('cancelled');
  });

  it('switched to another tool that is not refused: delivered to it (4437)', async () => {
    const relayId = openRelayWithReply(REQUESTER, WORKER);
    findRelayHoldReason.mockImplementationOnce(async () => {
      switchTool(REQUESTER, 'codex');
      return null;
    });
    await pumpRelayDeliveries();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage.mock.calls[0][1]).toMatchObject({ cliToolId: 'codex' });
    expect(getRelayById(db, relayId)?.state).not.toBe('cancelled');
  });
});

describe('Issue #4437 I6b: an open antigravity relay without a payload', () => {
  it.each([
    ['to', CLAUDE, AGY],
    ['from', AGY, CODEX],
  ] as const)('antigravity at the %s end, no payload: cancelled by the pump, nothing sent (4437)', async (_end, from, to) => {
    const relay = createRelay(db, { from, to, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    expect(getRelayPendingPayload(db, relay.id)).toBeNull();
    await pumpRelayDeliveries();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relay.id)?.state).toBe('cancelled');
  });

  it('a roster instance now running antigravity, no payload: cancelled (4437)', async () => {
    const relay = createRelay(db, { from: REQUESTER, to: WORKER, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    switchTool(WORKER, 'antigravity');
    await pumpRelayDeliveries();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relay.id)?.state).toBe('cancelled');
  });

  it('other tools, no payload: still open after the pump (4437)', async () => {
    const relay = createRelay(db, { from: CLAUDE, to: CODEX, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    const roster = createRelay(db, { from: REQUESTER, to: WORKER, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    await pumpRelayDeliveries();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(findRelayHoldReason).not.toHaveBeenCalled();
    expect(getRelayById(db, relay.id)?.state).toBe('pending');
    expect(getRelayById(db, roster.id)?.state).toBe('pending');
  });

  it('declared (enterprise), no payload: still open after the pump (4437)', async () => {
    vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'enterprise');
    const relay = createRelay(db, { from: CLAUDE, to: AGY, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    await pumpRelayDeliveries();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relay.id)?.state).toBe('pending');
  });
});
