/**
 * Issue #4496 (server): rule 0 judges an ad-hoc `to` end by the tool the send asked
 * for (`to.cliToolId` on `POST /api/relays`), keeps the roster as the authority for a
 * registered instance (I3), and refuses an end whose tool cannot be read (I4).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { addAgentInstance } from '@/lib/db/agent-instances-db';
import { findRelayToolPolicyDenial } from '@/lib/relay/relay-policy';
import { RELAY_TOOL_POLICY_DENIED } from '@/lib/tool-policy/policy';

let db: Database.Database;

const sendUserMessage = vi.fn();
/** A roster read that throws for one instance id (fault injection, fix1). */
const rosterFault = vi.hoisted(() => ({ instanceId: null as string | null }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));
vi.mock('@/lib/relay/relay-readiness', () => ({ findRelayHoldReason: vi.fn(async () => null) }));
vi.mock('@/lib/db/agent-instances-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/agent-instances-db')>();
  return {
    ...actual,
    getAgentInstance: (...args: Parameters<typeof actual.getAgentInstance>) => {
      if (rosterFault.instanceId !== null && args[2] === rosterFault.instanceId) throw new Error('roster unreadable (injected)');
      return actual.getAgentInstance(...args);
    },
  };
});

const { POST: postRelayRoute } = await import('@/app/api/relays/route');
const { resolveRelayEndpointTool } = await import('@/lib/relay/relay-session-ref');
const { pumpRelayDeliveries, resetRelayDeliveryState } = await import('@/lib/relay/relay-delivery');
const { createRelay, getRelayById } = await import('@/lib/db/relay-db');

const WT = 'wt-4496';
const FROM = { worktreeId: WT, instanceId: 'codex' };

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

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    WT, WT, `/tmp/${WT}`, 'codex', Date.now(),
  );
  vi.stubEnv('CM_ANTIGRAVITY_USAGE', '');
  rosterFault.instanceId = null;
  resetRelayDeliveryState();
  sendUserMessage.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
});

describe('Issue #4496: POST /api/relays judges an ad-hoc end by to.cliToolId', () => {
  it('4496 ad-hoc to with cliToolId antigravity: 409 RELAY_TOOL_POLICY_DENIED, no row', async () => {
    const result = await postRelay({ from: FROM, to: { worktreeId: WT, instanceId: 'agy-adhoc', cliToolId: 'antigravity' }, bind: true });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe(RELAY_TOOL_POLICY_DENIED);
    expect(result.body.policy).toMatchObject({ tool: 'antigravity', endpoint: 'to' });
    expect(relayRows()).toBe(0);
  });

  it('4496 control — ad-hoc to with cliToolId claude opens the relay', async () => {
    const result = await postRelay({ from: FROM, to: { worktreeId: WT, instanceId: 'claude-adhoc', cliToolId: 'claude' }, bind: true });
    expect(result.status).toBe(201);
    expect(relayRows()).toBe(1);
  });

  it('4496 control — no cliToolId (an older CLI) resolves as before: the worktree default', async () => {
    const result = await postRelay({ from: FROM, to: { worktreeId: WT, instanceId: 'agy-adhoc' }, bind: true });
    expect(result.status).toBe(201);
  });

  it('4496 I3 — a roster instance is judged by its roster tool, not the requested one', async () => {
    addAgentInstance(db, WT, { id: 'codex-2', cliTool: 'codex', alias: '', order: 0 });
    addAgentInstance(db, WT, { id: 'agy-2', cliTool: 'antigravity', alias: '', order: 1 });
    expect((await postRelay({ from: FROM, to: { worktreeId: WT, instanceId: 'agy-2', cliToolId: 'claude' } })).status).toBe(409);
    expect((await postRelay({ from: FROM, to: { worktreeId: WT, instanceId: 'codex-2', cliToolId: 'claude' } })).status).toBe(201);
  });

  it('4496 a cliToolId that names no tool is a 400, no row', async () => {
    const result = await postRelay({ from: FROM, to: { worktreeId: WT, instanceId: 'x-adhoc', cliToolId: 'agy' } });
    expect(result.status).toBe(400);
    expect(relayRows()).toBe(0);
  });

  it('4496 a declared server opens the ad-hoc antigravity relay', async () => {
    vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'api-key');
    const result = await postRelay({ from: FROM, to: { worktreeId: WT, instanceId: 'agy-adhoc', cliToolId: 'antigravity' } });
    expect(result.status).toBe(201);
  });
});

describe('Issue #4496 I4: an end whose tool cannot be read is refused (fail-closed)', () => {
  it('4496 findRelayToolPolicyDenial refuses a null end under a personal declaration', () => {
    const denial = findRelayToolPolicyDenial({ from: 'codex', to: null, declaration: 'personal' });
    expect(denial).toMatchObject({ endpoint: 'to', decision: { allowed: false, tool: 'antigravity' } });
  });

  it('4496 control — a null end under an api-key declaration is let through (no tool is restricted then)', () => {
    expect(findRelayToolPolicyDenial({ from: null, to: 'codex', declaration: 'api-key' })).toBeNull();
  });

  it('4496 resolveRelayEndpointTool answers null rather than a fallback when the roster cannot be read', () => {
    const broken = new Database(':memory:');
    try {
      expect(resolveRelayEndpointTool(broken, { worktreeId: WT, instanceId: 'x-adhoc' }, 'claude')).toBeNull();
    } finally {
      broken.close();
    }
  });

  it('4496 resolveRelayEndpointTool: ad-hoc → requested, tool-named id → itself, no request → default', () => {
    expect(resolveRelayEndpointTool(db, { worktreeId: WT, instanceId: 'x-adhoc' }, 'antigravity')).toBe('antigravity');
    expect(resolveRelayEndpointTool(db, { worktreeId: WT, instanceId: 'antigravity' }, 'claude')).toBe('antigravity');
    expect(resolveRelayEndpointTool(db, { worktreeId: WT, instanceId: 'x-adhoc' })).toBe('codex');
  });
});

describe('Issue #4496 fix1 (I4): the delivery judges an unreadable end as every tool', () => {
  function openAdHocRelay(): string {
    const now = Date.now();
    return createRelay(db, { from: FROM, to: { worktreeId: WT, instanceId: 'x-adhoc' }, hops: 1, expiresAt: now + 60 * 60 * 1000, now }).id;
  }

  it('4496 the to end\'s roster cannot be read: the pump\'s sweep withdraws the relay (rule 0 reached)', async () => {
    const id = openAdHocRelay();
    rosterFault.instanceId = 'x-adhoc';
    await pumpRelayDeliveries();
    expect(getRelayById(db, id)?.state).toBe('cancelled');
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('4496 control — the same relay with the roster readable stays open', async () => {
    const id = openAdHocRelay();
    await pumpRelayDeliveries();
    expect(getRelayById(db, id)?.state).not.toBe('cancelled');
  });
});
