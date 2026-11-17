/**
 * Issue #4437 (PR1, server): relays with antigravity at either end.
 *
 * - Rule 0 of `decideRelayCreation`: refused right after the self-target typo and
 *   before every other refusal, at either end; a declaration lets it through.
 * - `POST /api/relays`: 409 `RELAY_TOOL_POLICY_DENIED` with `policy.endpoint`,
 *   no row, no system line (I6).
 * - The pump: an open relay already in the ledger (an older server, a
 *   declaration taken back) is not typed into — withdrawn as `cancelled` (I6).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRelay, getRelayById, getRelayPendingPayload, markRelayExpired, stashRelayPayload } from '@/lib/db/relay-db';
import {
  decideRelayCreation,
  findRelayToolPolicyDenial,
  isRelayRefusal,
  RELAY_TOOL_POLICY_DENIED_MESSAGE,
  type RelayCreationInput,
} from '@/lib/relay/relay-policy';
import { RELAY_TOOL_POLICY_DENIED } from '@/lib/tool-policy/policy';

let db: Database.Database;

const sendUserMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));
vi.mock('@/lib/relay/relay-readiness', () => ({ findRelayHoldReason: vi.fn(async () => null) }));

const { pumpRelayDeliveries, resetRelayDeliveryState } = await import('@/lib/relay/relay-delivery');
const { POST: postRelayRoute } = await import('@/app/api/relays/route');

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const CLAUDE = { worktreeId: 'wt-a', instanceId: 'claude' };
const CODEX = { worktreeId: 'wt-b', instanceId: 'codex' };
const AGY = { worktreeId: 'wt-c', instanceId: 'antigravity' };

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(`INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    id,
    `/tmp/${id}`,
    cliToolId,
    NOW,
  );
}

async function postRelay(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await postRelayRoute(
    new Request('http://localhost/api/relays', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const relayRows = (): number => (db.prepare('SELECT COUNT(*) AS n FROM session_relays').get() as { n: number }).n;
const systemLines = (): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE request_id LIKE 'relay-sys:%'`).get() as { n: number }).n;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertWorktree('wt-a', 'claude');
  insertWorktree('wt-b', 'codex');
  insertWorktree('wt-c', 'antigravity');
  resetRelayDeliveryState();
  sendUserMessage.mockReset();
  sendUserMessage.mockResolvedValue({ ok: true, message: { id: 'm1' } });
  vi.stubEnv('CM_ANTIGRAVITY_USAGE', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRelayDeliveryState();
  db.close();
});

describe('Issue #4437: rule 0 of decideRelayCreation', () => {
  const base = (over: Partial<RelayCreationInput> = {}): RelayCreationInput => ({
    from: CLAUDE,
    to: AGY,
    parentHops: null,
    allowRelayChain: false,
    openBetween: 0,
    tools: { from: 'claude', to: 'antigravity', declaration: 'personal' },
    ...over,
  });

  it.each([
    ['to', { from: 'claude', to: 'antigravity' }],
    ['from', { from: 'antigravity', to: 'codex' }],
  ] as const)('antigravity at the %s end → RELAY_TOOL_POLICY_DENIED naming that end (4437)', (endpoint, tools) => {
    const verdict = decideRelayCreation(base({ tools: { ...tools, declaration: 'personal' } }));
    expect(isRelayRefusal(verdict)).toBe(true);
    expect(verdict).toMatchObject({
      code: RELAY_TOOL_POLICY_DENIED,
      message: RELAY_TOOL_POLICY_DENIED_MESSAGE,
      toolPolicy: { endpoint, decision: { allowed: false, tool: 'antigravity', operation: 'relay', origin: 'relay' } },
    });
  });

  it('before the chain, the depth and the duplicate refusals (4437)', () => {
    for (const over of [
      { parentHops: 1 },
      { parentHops: 3, allowRelayChain: true },
      { openBetween: 1 },
    ]) {
      expect(decideRelayCreation(base(over))).toMatchObject({ code: RELAY_TOOL_POLICY_DENIED });
      // Positive control: the same input with a declaration hits the old refusal.
      const declared = decideRelayCreation(base({ ...over, tools: { from: 'claude', to: 'antigravity', declaration: 'api-key' } }));
      expect(isRelayRefusal(declared) && declared.code).not.toBe(RELAY_TOOL_POLICY_DENIED);
      expect(isRelayRefusal(declared)).toBe(true);
    }
  });

  it('after the self-target typo (4437)', () => {
    expect(decideRelayCreation(base({ to: CLAUDE, tools: { from: 'antigravity', to: 'antigravity', declaration: 'personal' } }))).toMatchObject({
      code: 'RELAY_SELF_TARGET',
    });
  });

  it.each(['api-key', 'enterprise'] as const)('declared %s: opened as before (4437)', (declaration) => {
    expect(decideRelayCreation(base({ tools: { from: 'antigravity', to: 'antigravity', declaration } }))).toEqual({ ok: true, hops: 1 });
  });

  it('other tools, and a caller naming no tools, are as before (4437)', () => {
    expect(decideRelayCreation(base({ to: CODEX, tools: { from: 'claude', to: 'codex', declaration: 'personal' } }))).toEqual({ ok: true, hops: 1 });
    expect(decideRelayCreation(base({ tools: undefined }))).toEqual({ ok: true, hops: 1 });
    expect(findRelayToolPolicyDenial({ from: 'claude', to: 'codex', declaration: 'personal' })).toBeNull();
  });
});

describe('Issue #4437: POST /api/relays (I6)', () => {
  it.each([
    ['to', CLAUDE, AGY],
    ['from', AGY, CODEX],
  ] as const)('antigravity at the %s end → 409, no row, no system line (4437)', async (endpoint, from, to) => {
    const { status, body } = await postRelay({ from, to, bind: true });
    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: RELAY_TOOL_POLICY_DENIED,
      error: RELAY_TOOL_POLICY_DENIED_MESSAGE,
      policy: {
        tool: 'antigravity',
        operation: 'relay',
        origin: 'relay',
        declaration: 'personal',
        reason: 'ANTIGRAVITY_CONSUMER_TERMS',
        endpoint,
        unlock: expect.stringContaining('CM_ANTIGRAVITY_USAGE'),
      },
    });
    expect(relayRows()).toBe(0);
    expect(systemLines()).toBe(0);
  });

  it('declared (api-key): the same relay is opened (4437)', async () => {
    vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'api-key');
    const { status } = await postRelay({ from: CLAUDE, to: AGY });
    expect(status).toBe(201);
    expect(relayRows()).toBe(1);
  });

  it('claude ↔ codex: opened as before, with no policy on the body (4437)', async () => {
    const { status, body } = await postRelay({ from: CLAUDE, to: CODEX });
    expect(status).toBe(201);
    expect(body).not.toHaveProperty('policy');
    expect(relayRows()).toBe(1);
    expect(systemLines()).toBe(1);
  });

  it('the other refusals answer as before, with no policy (4437)', async () => {
    const { status, body } = await postRelay({ from: CLAUDE, to: CLAUDE });
    expect(status).toBe(409);
    expect(body).toEqual({ error: expect.any(String), code: 'RELAY_SELF_TARGET' });
  });
});

describe('Issue #4437: the pump and an antigravity relay already open (I6)', () => {
  function openRelayWithReply(from: typeof CLAUDE, to: typeof CLAUDE): string {
    const relay = createRelay(db, { from, to, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    expect(stashRelayPayload(db, relay.id, 'reply', '[from B] done', NOW)).toBe(true);
    return relay.id;
  }

  it.each([
    ['worker', CLAUDE, AGY],
    ['requester', AGY, CODEX],
  ] as const)('antigravity as the %s: nothing sent, the relay cancelled (4437)', async (_label, from, to) => {
    const relayId = openRelayWithReply(from, to);
    await pumpRelayDeliveries();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relayId)?.state).toBe('cancelled');
    expect(getRelayPendingPayload(db, relayId)).toBeNull();
    // A second pump finds nothing to do.
    await pumpRelayDeliveries();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('declared (enterprise): delivered as before (4437)', async () => {
    vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'enterprise');
    const relayId = openRelayWithReply(AGY, CODEX);
    await pumpRelayDeliveries();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, relayId)?.state).not.toBe('cancelled');
  });

  it('claude ↔ codex: delivered as before (4437)', async () => {
    const relayId = openRelayWithReply(CLAUDE, CODEX);
    await pumpRelayDeliveries();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, relayId)?.state).not.toBe('cancelled');
  });

  it('an expiry notice of a closed relay: dropped for an antigravity requester, delivered to another (4437)', async () => {
    const toAgy = createRelay(db, { from: AGY, to: CODEX, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    const fromClaude = createRelay(db, { from: CLAUDE, to: AGY, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    for (const relay of [toAgy, fromClaude]) {
      expect(stashRelayPayload(db, relay.id, 'expired', 'expired notice', NOW)).toBe(true);
      expect(markRelayExpired(db, relay.id, NOW)).toBe(true);
    }
    await pumpRelayDeliveries();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage.mock.calls[0][1]).toMatchObject({ worktreeId: 'wt-a', cliToolId: 'claude' });
    expect(getRelayPendingPayload(db, toAgy.id)).toBeNull();
  });
});
