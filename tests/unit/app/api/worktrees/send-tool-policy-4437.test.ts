/**
 * Issue #4437 (PR1, server): `POST /api/worktrees/:id/send` asks the tool policy
 * with the body's `origin` before anything is started, saved or typed.
 *
 * - I1: no declaration, antigravity, an agent's origin → 409 `TOOL_POLICY_DENIED`,
 *   `sendOutcome: not_sent`, no send, no start, `lastSend.reason` recorded.
 * - I2: a declaration (`api-key` / `enterprise`) → 201 and one send, as before.
 * - I3: other tools from `session` → 201.
 * - I4: no origin (web UI, CLI before #4437) and `terminal` → 201 on antigravity.
 * - I5: an unknown origin string is `unknown` (refused, not 400); a non-string is 400.
 * - I7: `--role` is not saved before the refusal.
 *
 * Positive control: each refused case is paired with the same request under a
 * declaration, which goes through — the refusal is the policy's, not the setup's.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { createRelay, getRelayById } from '@/lib/db/relay-db';
import { createAgentRole, getInstanceRoleState } from '@/lib/db/agent-roles-db';
import { clearSendAttempts, getLastSendAttempt } from '@/lib/session/send-attempt-state';
import { validateSendRequest } from '@/app/api/worktrees/[id]/send/send-request';
import { TOOL_POLICY_DENIED, TOOL_POLICY_DENIED_MESSAGE, ANTIGRAVITY_TERMS_URL, ANTIGRAVITY_FAQ_URL } from '@/lib/tool-policy/policy';
import type { Worktree } from '@/types/models';

const startSession = vi.fn(async (..._args: unknown[]) => {});
const isRunning = vi.fn(async (..._args: unknown[]) => true);

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (tool: string) => ({
        id: tool,
        name: tool,
        command: tool,
        getSessionName: (id: string, instanceId?: string) => `mcbd-${tool}-${id}${instanceId && instanceId !== tool ? `-${instanceId}` : ''}`,
        isInstalled: async () => true,
        isRunning: (...args: unknown[]) => isRunning(...args),
        startSession: (...args: unknown[]) => startSession(...args),
        sendMessage: async () => {},
        killSession: async () => {},
      }),
    }),
  },
}));
vi.mock('@/lib/cli-tools/base', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/base')>()),
  probeRunningSessionHookUrl: vi.fn(),
}));
const checkSessionOwnership = vi.fn(async (..._args: unknown[]) => ({ verdict: 'absent' }));
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: (...args: unknown[]) => checkSessionOwnership(...args),
}));
vi.mock('@/app/api/worktrees/[id]/send/pane-shell', () => ({ isPaneBackAtShell: vi.fn(async () => false) }));
const sendUserMessage = vi.fn();
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));
vi.mock('@/lib/relay/relay-delivery', () => ({ evaluateRelayAfterSend: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime/terminal-broadcast')>()),
  broadcastSessionStatus: vi.fn(),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database | null): void;
}
vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database | null) => {
      mockDb = db;
    },
  };
});

import { POST as sendMessage } from '@/app/api/worktrees/[id]/send/route';

const WT = 'wt-4437-send';
const OTHER = 'wt-4437-asker';
const AGENT_ORIGINS = ['session', 'agent', 'schedule', 'unknown'] as const;

let db: Database.Database;

async function post(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hello', ...body }),
  });
  const response = (await sendMessage(request as unknown as NextRequest, {
    params: Promise.resolve({ id: WT }),
  })) as unknown as Response;
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function declare(value: string): void {
  vi.stubEnv('CM_ANTIGRAVITY_USAGE', value);
}

function expectNothingTyped(): void {
  expect(sendUserMessage).not.toHaveBeenCalled();
  expect(startSession).not.toHaveBeenCalled();
  expect(isRunning).not.toHaveBeenCalled();
  expect(checkSessionOwnership).not.toHaveBeenCalled();
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  for (const id of [WT, OTHER]) {
    upsertWorktree(db, {
      id,
      name: id,
      path: `/path/to/${id}`,
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    } as Worktree);
  }
  db.prepare('UPDATE worktrees SET selected_agents = ? WHERE id = ?').run(
    JSON.stringify(['claude', 'antigravity', 'codex']),
    WT,
  );
  vi.clearAllMocks();
  clearSendAttempts();
  // A pane that is not running would be started — the refused cases must not get there.
  isRunning.mockResolvedValue(false);
  sendUserMessage.mockReset();
  sendUserMessage.mockImplementation(async (_db: unknown, params: { content: string; onAttempt?: (a: unknown) => void }) => {
    params.onAttempt?.({ state: 'sent', reason: 'submitted' });
    return { ok: true, message: { id: 'm-4437', worktreeId: WT, role: 'user', content: params.content } };
  });
  declare('');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(null);
  db.close();
  clearSendAttempts();
});

describe('Issue #4437: POST /send — the tool policy', () => {
  describe('I1: no declaration, antigravity, an origin that is not a person', () => {
    it.each(AGENT_ORIGINS)('origin %s → 409 TOOL_POLICY_DENIED, not_sent, nothing started or typed (4437)', async (origin) => {
      const { status, body } = await post({ cliToolId: 'antigravity', origin, originEvidence: 'env:CM_AGENT_TOOL' });

      expect(status).toBe(409);
      expect(body).toEqual({
        error: TOOL_POLICY_DENIED_MESSAGE,
        code: TOOL_POLICY_DENIED,
        policy: {
          tool: 'antigravity',
          operation: 'send',
          origin,
          reason: 'ANTIGRAVITY_CONSUMER_TERMS',
          declaration: 'personal',
          links: { terms: ANTIGRAVITY_TERMS_URL, faq: ANTIGRAVITY_FAQ_URL },
          unlock: expect.stringContaining('CM_ANTIGRAVITY_USAGE=api-key'),
        },
        sendOutcome: 'not_sent',
      });
      expectNothingTyped();
      expect(getLastSendAttempt({ worktreeId: WT, cliToolId: 'antigravity', instanceId: 'antigravity' })).toMatchObject({
        state: 'not-sent',
        reason: 'tool-policy-denied',
      });
    });

    it('a body may not claim the server-internal `relay` origin: read as unknown and refused (4437)', async () => {
      const { status, body } = await post({ cliToolId: 'antigravity', origin: 'relay' });
      expect(status).toBe(409);
      expect((body.policy as Record<string, unknown>).origin).toBe('unknown');
      expectNothingTyped();
    });

    it('an instance backed by antigravity (named by the instance alone) is refused too (4437)', async () => {
      const { status, body } = await post({ instanceId: 'antigravity', origin: 'session' });
      expect(status).toBe(409);
      expect(body.code).toBe(TOOL_POLICY_DENIED);
      expectNothingTyped();
    });

    it('with `ask`: operation ask, the ask answer says not_sent (4437)', async () => {
      const { status, body } = await post({
        cliToolId: 'antigravity',
        origin: 'session',
        ask: { id: '0b6a3b9e-2a64-4f4e-9f3c-7f8a1d2c3b4a', protocol: 1 },
      });
      expect(status).toBe(409);
      expect((body.policy as Record<string, unknown>).operation).toBe('ask');
      expect(body.ask).toMatchObject({ sendState: 'not_sent' });
      expect(body.sendOutcome).toBe('not_sent');
      expectNothingTyped();
    });

    it('with a bound relay: not_sent, and the relay is withdrawn (4437)', async () => {
      // A relay opened before the policy (an older server): rule 0 would refuse it today.
      const relay = createRelay(db, {
        from: { worktreeId: OTHER, instanceId: 'claude' },
        to: { worktreeId: WT, instanceId: 'antigravity' },
        hops: 1,
        expiresAt: Date.now() + 60_000,
        bindMode: 'bound',
      });
      const { status, body } = await post({ cliToolId: 'antigravity', origin: 'session', relayId: relay.id });
      expect(status).toBe(409);
      expect(body).toMatchObject({ code: TOOL_POLICY_DENIED, relayId: relay.id, sendOutcome: 'not_sent' });
      expect(getRelayById(db, relay.id)?.state).toBe('cancelled');
      expectNothingTyped();
    });
  });

  describe('I2: a declaration lifts it — as before', () => {
    it.each(['api-key', 'enterprise'])('%s: origin session → 201, one send (4437)', async (value) => {
      declare(value);
      isRunning.mockResolvedValue(true);
      const { status, body } = await post({ cliToolId: 'antigravity', origin: 'session' });
      expect(status).toBe(201);
      expect(body.id).toBe('m-4437');
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it('positive control: a value that is not a declaration is personal, and refuses (4437)', async () => {
      declare('API-KEY');
      const { status } = await post({ cliToolId: 'antigravity', origin: 'session' });
      expect(status).toBe(409);
      expectNothingTyped();
    });
  });

  describe('I3: other tools are not affected', () => {
    it.each(['claude', 'codex'])('%s from origin session → 201, one send (4437)', async (tool) => {
      isRunning.mockResolvedValue(true);
      const { status } = await post({ cliToolId: tool, origin: 'session' });
      expect(status).toBe(201);
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      expect(getLastSendAttempt({ worktreeId: WT, cliToolId: tool as 'claude', instanceId: tool })?.reason).not.toBe('tool-policy-denied');
    });
  });

  describe('I4: a person — the web UI, the CLI before #4437, a terminal', () => {
    it('no origin → 201 on antigravity, answered as before (no sendOutcome, no policy) (4437)', async () => {
      isRunning.mockResolvedValue(true);
      const { status, body } = await post({ cliToolId: 'antigravity' });
      expect(status).toBe(201);
      expect(Object.keys(body).sort()).toEqual(['content', 'id', 'role', 'worktreeId']);
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it('origin terminal → 201 on antigravity (4437)', async () => {
      isRunning.mockResolvedValue(true);
      const { status } = await post({ cliToolId: 'antigravity', origin: 'terminal' });
      expect(status).toBe(201);
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('I5: the origin field', () => {
    it('an unknown string is `unknown`: refused on antigravity, not 400 (4437)', async () => {
      const { status, body } = await post({ cliToolId: 'antigravity', origin: 'robot-from-the-future' });
      expect(status).toBe(409);
      expect((body.policy as Record<string, unknown>).origin).toBe('unknown');
    });

    it('an unknown string on another tool goes through (4437)', async () => {
      isRunning.mockResolvedValue(true);
      const { status } = await post({ cliToolId: 'claude', origin: 'robot-from-the-future' });
      expect(status).toBe(201);
    });

    it.each([[42], [null], [{ kind: 'session' }], [['session']], [true]])(
      'a non-string origin %j → 400 with nothing recorded (4437)',
      async (origin) => {
        const { status, body } = await post({ cliToolId: 'claude', origin });
        expect(status).toBe(400);
        // Issue #4535 (C4, the human's decision 2026-11-24 16:08): plus `sendOutcome: 'not_sent'`.
        expect(body).toEqual({ error: 'origin must be a string', sendOutcome: 'not_sent' });
        expect(getLastSendAttempt({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' })).toBeNull();
        expect(sendUserMessage).not.toHaveBeenCalled();
      },
    );

    it('validateSendRequest does not refuse unknown keys: origin and originEvidence are accepted (4437)', () => {
      const validated = validateSendRequest(db, WT, {
        content: 'hello',
        cliToolId: 'claude',
        origin: 'terminal',
        originEvidence: 'x'.repeat(500),
        somethingNewer: { a: 1 },
      } as unknown as Parameters<typeof validateSendRequest>[2]);
      expect(validated.ok).toBe(true);
      if (validated.ok) expect(validated.value.origin).toBe('terminal');
      const legacy = validateSendRequest(db, WT, { content: 'hello', cliToolId: 'claude' });
      expect(legacy.ok && legacy.value.origin).toBe('legacy');
    });
  });

  describe('I7: --role is not saved before the refusal', () => {
    it('refused: the role is not saved (4437)', async () => {
      const role = createAgentRole(db, { name: 'R-4437', body: 'BODY' }).id;
      const { status, body } = await post({ cliToolId: 'antigravity', origin: 'session', role: { state: 'role', roleId: role } });
      expect(status).toBe(409);
      expect(body).not.toHaveProperty('roleSettings');
      expect(getInstanceRoleState(db, WT, 'antigravity')).not.toMatchObject({ state: 'role', roleId: role });
      expectNothingTyped();
    });

    it('positive control: declared, the same request saves the role (4437)', async () => {
      declare('api-key');
      const role = createAgentRole(db, { name: 'R-4437', body: 'BODY' }).id;
      await post({ cliToolId: 'antigravity', origin: 'session', role: { state: 'role', roleId: role } });
      expect(getInstanceRoleState(db, WT, 'antigravity')).toMatchObject({ state: 'role', roleId: role });
    });
  });
});
