/**
 * `POST /api/worktrees/:id/send` with `relayId` (Issue #3957, PR 2).
 *
 * The send reserves the bound relay before any side effect, records its
 * boundary in the REQUIRED hook right before the first key, and answers
 * `sendOutcome` on every response after the reservation. The send service is
 * stubbed to drive the hook the way the real sender does (inside
 * `noteInputStart` / `noteDispatchStart`), so each outcome can be produced.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { cancelRelay, createRelay, getRelayBinding, getRelayById } from '@/lib/db/relay-db';
import type { InputBoundaryHooks } from '@/lib/session/instance-input-lock';
import type { Worktree } from '@/types/models';
import type { NextRequest } from 'next/server';

const isRunning = vi.fn(async () => true);

vi.mock('@/lib/cli-tools/codex', () => ({
  CodexTool: class {
    id = 'codex';
    name = 'Codex CLI';
    command = 'codex';
    async isInstalled() { return true; }
    async isRunning() { return isRunning(); }
    async startSession() {}
    async sendMessage() {}
    async killSession() {}
    getSessionName(id: string) { return `mcbd-codex-${id}`; }
  },
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
const evaluateRelayAfterSend = vi.fn();
vi.mock('@/lib/relay/relay-delivery', () => ({
  evaluateRelayAfterSend: (...args: unknown[]) => evaluateRelayAfterSend(...args),
}));
vi.mock('@/lib/realtime/terminal-broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime/terminal-broadcast')>()),
  broadcastSessionStatus: vi.fn(),
}));

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      mockDb = null;
    },
  };
});

import { POST as sendMessage } from '@/app/api/worktrees/[id]/send/route';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';

const WT = 'wt-3957-bind';
const OTHER = 'wt-3957-asker';

interface SendParams {
  content: string;
  onAttempt?: (attempt: { state: string; reason: string }) => void;
  inputBoundary?: InputBoundaryHooks;
}

function ok(params: SendParams) {
  params.onAttempt?.({ state: 'sent', reason: 'submitted' });
  return { ok: true, message: { id: 'm-own', worktreeId: WT, role: 'user', content: params.content } };
}

/** A sender that types: the hook right before the first key, as `noteInputStart` runs it. */
function typesBody(): void {
  sendUserMessage.mockImplementation(async (_db: unknown, params: SendParams) => {
    try {
      params.inputBoundary?.beforeInput(new Date(), 'input_start');
    } catch (error) {
      params.onAttempt?.({ state: 'not-sent', reason: 'input-lock-lost' });
      return { ok: false, stage: 'send', error: String(error) };
    }
    return ok(params);
  });
}

async function post(extra: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'review this', cliToolId: 'codex', ...extra }),
  });
  const response = (await sendMessage(request as unknown as NextRequest, {
    params: Promise.resolve({ id: WT }),
  })) as unknown as Response;
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('POST /send with relayId (Issue #3957)', () => {
  let db: Database.Database;

  function boundRelay(to = { worktreeId: WT, instanceId: 'codex' }) {
    return createRelay(db, {
      from: { worktreeId: OTHER, instanceId: 'claude' },
      to,
      hops: 1,
      expiresAt: Date.now() + 60_000,
      bindMode: 'bound',
    });
  }

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
    vi.clearAllMocks();
    clearAgentStopEvents();
    typesBody();
    for (const id of [WT, OTHER]) {
      upsertWorktree(db, {
        id,
        name: id,
        path: `/path/to/${id}`,
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
        cliToolId: 'codex',
      } as Worktree);
    }
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
    clearAgentStopEvents();
  });

  it('negative control: without relayId the answer carries no sendOutcome', async () => {
    const { status, body } = await post({});
    expect(status).toBe(201);
    expect(body).not.toHaveProperty('sendOutcome');
  });

  it('sent: boundary recorded right before the input, sendOutcome sent, re-judged', async () => {
    recordAgentEvent(WT, 'codex', undefined, { event: 'user_prompt_submit', at: Date.now() - 1_000, detail: null, sessionId: 's' });
    const relay = boundRelay();
    const before = Date.now();
    const { status, body } = await post({ relayId: relay.id });

    expect(status).toBe(201);
    expect(body).toMatchObject({ sendOutcome: 'sent', relayId: relay.id, id: 'm-own' });
    const read = getRelayById(db, relay.id);
    expect(read).toMatchObject({ sendState: 'sent', boundaryKind: 'input_start', turnOpenAtSend: true, obsState: 'valid' });
    expect(read?.inputBoundaryAt).toBeGreaterThanOrEqual(before);
    expect(getRelayBinding(db, relay.id)?.inputMessageId).toBe('m-own');
    expect(evaluateRelayAfterSend).toHaveBeenCalledWith(relay.id);
  });

  it('refuses a relayId that is not a relay id with 400 and types nothing', async () => {
    const { status, body } = await post({ relayId: 'not-a-uuid' });
    expect(status).toBe(400);
    expect(body.code).toBe('RELAY_BIND_INVALID');
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('refuses a relay addressed to another session with 400', async () => {
    const relay = boundRelay({ worktreeId: WT, instanceId: 'codex-2' });
    const { status, body } = await post({ relayId: relay.id });
    expect(status).toBe(400);
    expect(body.code).toBe('RELAY_BIND_INVALID');
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('refuses a legacy relay with 400 (it was never opened for binding)', async () => {
    const relay = createRelay(db, {
      from: { worktreeId: OTHER, instanceId: 'claude' },
      to: { worktreeId: WT, instanceId: 'codex' },
      hops: 1,
      expiresAt: Date.now() + 60_000,
    });
    const { status } = await post({ relayId: relay.id });
    expect(status).toBe(400);
  });

  it('refuses a closed relay with 409, before any side effect', async () => {
    const relay = boundRelay();
    cancelRelay(db, relay.id);
    const { status, body } = await post({ relayId: relay.id });
    expect(status).toBe(409);
    expect(body.code).toBe('RELAY_BIND_CONFLICT');
    expect(body).not.toHaveProperty('sendOutcome');
    expect(checkSessionOwnership).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('a second send of the same relay is 409 while the first attempt keeps it', async () => {
    const relay = boundRelay();
    let releaseFirst: () => void = () => {};
    sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      params.inputBoundary?.beforeInput(new Date(), 'input_start');
      return ok(params);
    });
    const first = post({ relayId: relay.id });
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledTimes(1));

    const second = await post({ relayId: relay.id });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('RELAY_BIND_CONFLICT');

    releaseFirst();
    expect((await first).body.sendOutcome).toBe('sent');
    expect(getRelayById(db, relay.id)?.sendState).toBe('sent');
  });

  it('cancelled while the send queued: the hook refuses, nothing typed, not_sent', async () => {
    const relay = boundRelay();
    sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
      cancelRelay(db, relay.id);
      try {
        params.inputBoundary?.beforeInput(new Date(), 'input_start');
      } catch (error) {
        params.onAttempt?.({ state: 'not-sent', reason: 'input-lock-lost' });
        return { ok: false, stage: 'send', error: String(error) };
      }
      throw new Error('the body was typed although the relay was gone');
    });
    const { status, body } = await post({ relayId: relay.id });
    expect(status).toBe(500);
    expect(body.sendOutcome).toBe('not_sent');
    expect(getRelayById(db, relay.id)?.state).toBe('cancelled');
  });

  it('refused before the first key (prompt waiting): not_sent, relay failed', async () => {
    const relay = boundRelay();
    sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
      params.onAttempt?.({ state: 'not-sent', reason: 'prompt-waiting' });
      return { ok: false, stage: 'prompt_waiting', error: 'waiting' };
    });
    const { status, body } = await post({ relayId: relay.id });
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'PROMPT_WAITING', sendOutcome: 'not_sent' });
    expect(getRelayById(db, relay.id)?.sendState).toBe('failed');
  });

  it('refused by another server\'s session before the service: not_sent', async () => {
    const relay = boundRelay();
    checkSessionOwnership.mockResolvedValueOnce({ verdict: 'foreign', sessionPath: '/elsewhere' } as never);
    const { status, body } = await post({ relayId: relay.id });
    expect(status).toBe(409);
    expect(body.sendOutcome).toBe('not_sent');
  });

  it('failed after the first key without a verdict: unknown, held as send_unknown', async () => {
    const relay = boundRelay();
    sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
      params.inputBoundary?.beforeInput(new Date(), 'input_start');
      params.onAttempt?.({ state: 'indeterminate', reason: 'send-error' });
      return { ok: false, stage: 'send', error: 'tmux went away' };
    });
    const { status, body } = await post({ relayId: relay.id });
    expect(status).toBe(500);
    expect(body.sendOutcome).toBe('unknown');
    expect(getRelayById(db, relay.id)).toMatchObject({ sendState: 'unknown', holdReason: 'send_unknown' });
  });

  it('the transport sent but the history write threw: unknown / send_unknown', async () => {
    const relay = boundRelay();
    sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
      params.inputBoundary?.beforeInput(new Date(), 'input_start');
      params.onAttempt?.({ state: 'sent', reason: 'submitted' });
      throw new Error('SQLITE_FULL');
    });
    const { status, body } = await post({ relayId: relay.id });
    expect(status).toBe(500);
    expect(body.sendOutcome).toBe('unknown');
    expect(getRelayById(db, relay.id)?.holdReason).toBe('send_unknown');
    expect(evaluateRelayAfterSend).not.toHaveBeenCalled();
  });

  it('a sender that reported no boundary: unknown / no_input_boundary', async () => {
    const relay = boundRelay();
    sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => ok(params));
    const { body } = await post({ relayId: relay.id });
    expect(body.sendOutcome).toBe('unknown');
    expect(getRelayById(db, relay.id)?.holdReason).toBe('no_input_boundary');
  });

  describe('opencode: the HTTP dispatch and its keyboard fallback', () => {
    it('dispatch delivered: the dispatch time is the boundary (kind dispatch)', async () => {
      const relay = boundRelay();
      sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
        params.inputBoundary?.beforeInput(new Date(1_900_000_000_000), 'dispatch');
        return ok(params);
      });
      const { body } = await post({ relayId: relay.id });
      expect(body.sendOutcome).toBe('sent');
      expect(getRelayById(db, relay.id)).toMatchObject({ boundaryKind: 'dispatch', inputBoundaryAt: 1_900_000_000_000 });
    });

    it('dispatch confirmed not sent → the keyboard\'s own input start replaces the boundary', async () => {
      const relay = boundRelay();
      sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
        params.inputBoundary?.beforeInput(new Date(1_900_000_000_000), 'dispatch');
        params.inputBoundary?.onDispatchFailed?.('not_sent');
        params.inputBoundary?.beforeInput(new Date(1_900_000_060_000), 'input_start');
        return ok(params);
      });
      const { body } = await post({ relayId: relay.id });
      expect(body.sendOutcome).toBe('sent');
      expect(getRelayById(db, relay.id)).toMatchObject({
        sendState: 'sent',
        boundaryKind: 'input_start',
        inputBoundaryAt: 1_900_000_060_000,
      });
    });

    it('positive control: without the not-sent verdict the dispatch boundary is never replaced', async () => {
      const relay = boundRelay();
      let refused = false;
      sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
        params.inputBoundary?.beforeInput(new Date(1_900_000_000_000), 'dispatch');
        try {
          params.inputBoundary?.beforeInput(new Date(1_900_000_060_000), 'input_start');
        } catch {
          refused = true;
        }
        return ok(params);
      });
      await post({ relayId: relay.id });
      expect(refused).toBe(true);
      expect(getRelayById(db, relay.id)?.inputBoundaryAt).toBe(1_900_000_000_000);
    });

    it('dispatch outcome unknown → held as dispatch_unknown; the fallback still types, sendOutcome unknown', async () => {
      const relay = boundRelay();
      let typed = false;
      sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
        params.inputBoundary?.beforeInput(new Date(1_900_000_000_000), 'dispatch');
        params.inputBoundary?.onDispatchFailed?.('unknown');
        params.inputBoundary?.beforeInput(new Date(1_900_000_060_000), 'input_start');
        typed = true;
        return ok(params);
      });
      const { status, body } = await post({ relayId: relay.id });
      expect(status).toBe(201);
      expect(typed).toBe(true);
      expect(body.sendOutcome).toBe('unknown');
      expect(getRelayById(db, relay.id)).toMatchObject({ sendState: 'unknown', holdReason: 'dispatch_unknown' });
      expect(evaluateRelayAfterSend).not.toHaveBeenCalled();
    });

    it('dispatch unknown and the fallback then failed: still unknown, never not_sent', async () => {
      const relay = boundRelay();
      sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
        params.inputBoundary?.beforeInput(new Date(), 'dispatch');
        params.inputBoundary?.onDispatchFailed?.('unknown');
        params.onAttempt?.({ state: 'not-sent', reason: 'prompt-not-ready' });
        return { ok: false, stage: 'send', error: 'prompt not ready' };
      });
      const { body } = await post({ relayId: relay.id });
      expect(body.sendOutcome).toBe('unknown');
    });

    it('dispatch confirmed not sent and the fallback hook refused: not_sent', async () => {
      const relay = boundRelay();
      sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
        params.inputBoundary?.beforeInput(new Date(), 'dispatch');
        params.inputBoundary?.onDispatchFailed?.('not_sent');
        cancelRelay(db, relay.id);
        try {
          params.inputBoundary?.beforeInput(new Date(), 'input_start');
        } catch {
          params.onAttempt?.({ state: 'not-sent', reason: 'input-lock-lost' });
          return { ok: false, stage: 'send', error: 'refused' };
        }
        return ok(params);
      });
      const { body } = await post({ relayId: relay.id });
      expect(body.sendOutcome).toBe('not_sent');
    });
  });

  describe('two HTTP attempts in one send (opencode image → text, review P2)', () => {
    it('unknown then not_sent: stays unknown, never not_sent', async () => {
      const relay = boundRelay();
      sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
        params.inputBoundary?.beforeInput(new Date(1_900_000_000_000), 'dispatch');
        params.inputBoundary?.onDispatchFailed?.('unknown');
        params.inputBoundary?.beforeInput(new Date(1_900_000_010_000), 'dispatch');
        params.inputBoundary?.onDispatchFailed?.('not_sent');
        try {
          params.inputBoundary?.beforeInput(new Date(1_900_000_020_000), 'input_start');
        } catch {
          params.onAttempt?.({ state: 'not-sent', reason: 'input-lock-lost' });
          return { ok: false, stage: 'send', error: 'refused' };
        }
        params.onAttempt?.({ state: 'not-sent', reason: 'prompt-not-ready' });
        return { ok: false, stage: 'send', error: 'prompt not ready' };
      });
      const { body } = await post({ relayId: relay.id });
      expect(body.sendOutcome).toBe('unknown');
      expect(getRelayById(db, relay.id)).toMatchObject({ state: 'pending', sendState: 'unknown', holdReason: 'dispatch_unknown' });
    });

    it('unknown then the second HTTP attempt delivered: sent, boundary from the first', async () => {
      const relay = boundRelay();
      sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
        params.inputBoundary?.beforeInput(new Date(1_900_000_000_000), 'dispatch');
        params.inputBoundary?.onDispatchFailed?.('unknown');
        params.inputBoundary?.beforeInput(new Date(1_900_000_010_000), 'dispatch');
        return ok(params);
      });
      const { body } = await post({ relayId: relay.id });
      expect(body.sendOutcome).toBe('sent');
      expect(getRelayById(db, relay.id)).toMatchObject({ sendState: 'sent', holdReason: null, inputBoundaryAt: 1_900_000_000_000 });
    });

    it('negative control: not_sent alone, fallback refused → not_sent', async () => {
      const relay = boundRelay();
      sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
        params.inputBoundary?.beforeInput(new Date(), 'dispatch');
        params.inputBoundary?.onDispatchFailed?.('not_sent');
        params.onAttempt?.({ state: 'not-sent', reason: 'prompt-not-ready' });
        return { ok: false, stage: 'send', error: 'prompt not ready' };
      });
      const { body } = await post({ relayId: relay.id });
      expect(body.sendOutcome).toBe('not_sent');
    });
  });
});
