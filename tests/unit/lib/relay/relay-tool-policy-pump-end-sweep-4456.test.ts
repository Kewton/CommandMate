/**
 * Issue #4456 item 7: the relay pump sweeps the open relays the tool policy
 * refuses at its end too, not only at its start (#4437 I6b). A relay that
 * became refused while the pump was awaiting another relay's delivery (its
 * worker switched to antigravity, or the declaration taken back) is cancelled
 * by this pump, not left open until the next one. Nothing is sent or claimed
 * for it either way.
 *
 * Harness from `relay-tool-policy-reresolve-4437.test.ts`.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRelay, getRelayById, stashRelayPayload } from '@/lib/db/relay-db';
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

describe('Issue #4456: the pump sweeps refused open relays at its end too', () => {
  it('positive: a relay whose worker turned antigravity during another delivery is cancelled by the same pump (4456)', async () => {
    const delivering = openRelayWithReply(REQUESTER, WORKER);
    const waiting = createRelay(db, { from: CLAUDE, to: CODEX, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    addRosterInstance(CODEX, 'codex');
    // The delivery's send is the await during which the other relay becomes refused.
    sendUserMessage.mockImplementationOnce(async () => {
      switchTool(CODEX, 'antigravity');
      return { ok: true, message: { id: 'm1' } };
    });
    await pumpRelayDeliveries();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, delivering)?.state).not.toBe('cancelled');
    expect(getRelayById(db, waiting.id)?.state).toBe('cancelled');
    expect(deliveryState(waiting.id)).toBeNull();
  });

  it('positive: the declaration taken back during a delivery cancels an open antigravity relay in the same pump (4456)', async () => {
    vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'api-key');
    openRelayWithReply(REQUESTER, WORKER);
    const agy = createRelay(db, { from: CLAUDE, to: AGY, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    sendUserMessage.mockImplementationOnce(async () => {
      vi.stubEnv('CM_ANTIGRAVITY_USAGE', '');
      return { ok: true, message: { id: 'm1' } };
    });
    await pumpRelayDeliveries();
    expect(getRelayById(db, agy.id)?.state).toBe('cancelled');
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('negative: nothing became refused — the other relay stays open after the pump (4456)', async () => {
    openRelayWithReply(REQUESTER, WORKER);
    const waiting = createRelay(db, { from: CLAUDE, to: CODEX, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    addRosterInstance(CODEX, 'codex');
    sendUserMessage.mockImplementationOnce(async () => {
      switchTool(CODEX, 'gemini');
      return { ok: true, message: { id: 'm1' } };
    });
    await pumpRelayDeliveries();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, waiting.id)?.state).toBe('pending');
  });
});
