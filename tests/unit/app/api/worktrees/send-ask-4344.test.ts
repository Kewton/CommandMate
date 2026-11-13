/**
 * `POST /api/worktrees/:id/send` and its `ask` field (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §3.2・§4): the reservation before any
 * key, the envelope handed to the send service, the send's outcome on the
 * ledger, the re-POST that types nothing, and the bodies that are sent as they
 * are (a command, a tool the server does not attribute). A body without `ask`
 * is answered as before (no `ask` key).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import type { NextRequest } from 'next/server';

const isRunning = vi.fn(async () => true);
function fakeTool(id: string) {
  return {
    id,
    name: id,
    command: id,
    async isInstalled() { return true; },
    async isRunning() { return isRunning(); },
    async startSession() {},
    async sendMessage() {},
    async killSession() {},
    getSessionName(worktreeId: string) { return `mcbd-${id}-${worktreeId}`; },
  };
}
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: (id: string) => fakeTool(id) }) },
}));

vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'absent' })),
}));

const sendUserMessage = vi.fn();
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));

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
import { getAskCorrelation } from '@/lib/db/ask-correlation-db';
import { setAskVersionProbeForTest } from '@/lib/ask/ask-correlation';

const WT = 'wt-4344-send';
const ASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function post(body: Record<string, unknown>): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return sendMessage(request as unknown as NextRequest, { params: Promise.resolve({ id: WT }) }) as unknown as Promise<Response>;
}

interface Params { content: string; askEnvelopeId?: string; onAttempt?: (a: { state: string; reason: string }) => void }

function succeeds(): void {
  sendUserMessage.mockImplementation(async (_db: unknown, params: Params) => ({
    ok: true,
    message: { id: 'm-1', worktreeId: WT, role: 'user', content: params.content, cliToolId: 'claude', instanceId: 'claude' },
  }));
}

describe('POST /send: ask (Issue #4344)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = (await import('@/lib/db/db-instance')) as unknown as { setMockDb: (d: Database.Database) => void };
    setMockDb(db);
    vi.clearAllMocks();
    succeeds();
    // H5: an installed claude that writes stop_reason (no `--version` is spawned).
    setAskVersionProbeForTest(async (tool) => (tool === 'claude' ? '2.1.293 (Claude Code)' : null));
    upsertWorktree(db, {
      id: WT, name: 'Ask', path: `/path/to/${WT}`, repositoryPath: '/path/to/repo', repositoryName: 'repo', cliToolId: 'claude',
    } as Worktree);
  });

  afterEach(async () => {
    const { closeDbInstance } = (await import('@/lib/db/db-instance')) as unknown as { closeDbInstance: () => void };
    closeDbInstance();
    db.close();
    setAskVersionProbeForTest(null);
  });

  it('reserves before the send, hands the envelope id to the service, and records the send as sent', async () => {
    let reservedAtInput: string | undefined;
    sendUserMessage.mockImplementation(async (_db: unknown, params: Params) => {
      reservedAtInput = getAskCorrelation(db, ASK)?.sendState;
      return { ok: true, message: { id: 'm-1', worktreeId: WT, role: 'user', content: params.content } };
    });
    const response = await post({ content: 'hi', cliToolId: 'claude', ask: { id: ASK, protocol: 1 } });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: 'm-1', ask: { id: ASK, state: 'pending', sendState: 'sent' } });
    expect(reservedAtInput).toBe('reserved');
    expect((sendUserMessage.mock.calls[0][1] as Params).askEnvelopeId).toBe(ASK);
    expect(getAskCorrelation(db, ASK)).toMatchObject({ sendState: 'sent', sentMessageId: 'm-1', worktreeId: WT, instanceId: 'claude' });
  });

  it('(10) the same askId and body again: 200 with the row, nothing typed', async () => {
    await post({ content: 'hi', cliToolId: 'claude', ask: { id: ASK, protocol: 1 } });
    const again = await post({ content: 'hi', cliToolId: 'claude', ask: { id: ASK, protocol: 1 } });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ask: { id: ASK, state: 'pending', reason: null, sendState: 'sent' } });
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('(10) the same askId with another body: 409, nothing typed', async () => {
    await post({ content: 'hi', cliToolId: 'claude', ask: { id: ASK, protocol: 1 } });
    const other = await post({ content: 'something else', cliToolId: 'claude', ask: { id: ASK, protocol: 1 } });
    expect(other.status).toBe(409);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('(7) M4: a command body is typed as it is — no envelope, no reservation, unavailable/slash_command', async () => {
    const response = await post({ content: '/compact', cliToolId: 'claude', ask: { id: ASK, protocol: 1 } });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ask: { id: null, state: 'unavailable', reason: 'slash_command' } });
    const params = sendUserMessage.mock.calls[0][1] as Params;
    expect(params.content).toBe('/compact');
    expect(params.askEnvelopeId).toBeUndefined();
    expect(getAskCorrelation(db, ASK)).toBeNull();
  });

  it('a tool the server does not attribute is sent as it is (unavailable/tool_unsupported)', async () => {
    const response = await post({ content: 'hi', cliToolId: 'codex', ask: { id: ASK, protocol: 1 } });
    expect(await response.json()).toMatchObject({ ask: { id: null, state: 'unavailable', reason: 'tool_unsupported' } });
    expect((sendUserMessage.mock.calls[0][1] as Params).askEnvelopeId).toBeUndefined();
    expect(getAskCorrelation(db, ASK)).toBeNull();
  });

  it('a send refused before any key records not_sent, and the answer says so', async () => {
    sendUserMessage.mockImplementation(async (_db: unknown, params: Params) => {
      params.onAttempt?.({ state: 'not-sent', reason: 'prompt-waiting' });
      return { ok: false, stage: 'prompt_waiting', error: 'waiting on a prompt' };
    });
    const response = await post({ content: 'hi', cliToolId: 'claude', ask: { id: ASK, protocol: 1 } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'PROMPT_WAITING', ask: { id: ASK, sendState: 'not_sent' } });
    // H2 (cell 2 → N): terminal at the save.
    expect(getAskCorrelation(db, ASK)).toMatchObject({ sendState: 'not_sent', attributionState: 'unmatched', reason: 'not_sent' });
  });

  it('a send whose outcome is not known is send_unknown (never resent)', async () => {
    sendUserMessage.mockImplementation(async (_db: unknown, params: Params) => {
      params.onAttempt?.({ state: 'indeterminate', reason: 'submit-unconfirmed' });
      return { ok: false, stage: 'send', error: 'submit not confirmed' };
    });
    await post({ content: 'hi', cliToolId: 'claude', ask: { id: ASK, protocol: 1 } });
    expect(getAskCorrelation(db, ASK)?.sendState).toBe('send_unknown');
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['older than the minimum', async () => '2.1.200'],
    ['unreadable', async () => null],
    ['a probe that throws', async () => { throw new Error('spawn failed'); }],
  ])('H5: claude whose version is %s is sent as it is (unavailable/tool_unsupported, no envelope)', async (_name, probe) => {
    setAskVersionProbeForTest(probe as () => Promise<string | null>);
    const response = await post({ content: 'hi', cliToolId: 'claude', ask: { id: ASK, protocol: 1 } });
    expect(await response.json()).toMatchObject({ ask: { id: null, state: 'unavailable', reason: 'tool_unsupported' } });
    expect((sendUserMessage.mock.calls[0][1] as Params).askEnvelopeId).toBeUndefined();
    expect(getAskCorrelation(db, ASK)).toBeNull();
  });

  it.each([{ id: 'nope', protocol: 1 }, { id: ASK, protocol: 2 }, 'x', [ASK]])('a malformed ask (%j) is 400 with nothing sent', async (ask) => {
    const response = await post({ content: 'hi', cliToolId: 'claude', ask });
    expect(response.status).toBe(400);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('negative control: a body without ask is answered as before (no `ask` key, no envelope)', async () => {
    const response = await post({ content: 'hi', cliToolId: 'claude' });
    expect(response.status).toBe(201);
    expect(await response.json()).not.toHaveProperty('ask');
    expect((sendUserMessage.mock.calls[0][1] as Params).askEnvelopeId).toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) AS n FROM ask_correlations').get() as { n: number }).n).toBe(0);
  });
});
