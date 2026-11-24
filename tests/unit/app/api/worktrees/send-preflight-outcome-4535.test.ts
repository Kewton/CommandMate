/**
 * Issue #4535 PR-A2, T13 (design `docs/design/send-outcome-4535.md` §2.4 C4, §5.2 T13,
 * INV-S2 / I10, INV-F3, Q10).
 *
 * A refusal the route answers before the send service could type anything says so:
 * `sendOutcome: 'not_sent'`, from ONE rule in the route's wrapper (not one per
 * refusal). `RELAY_BIND_CONFLICT` is `unknown` (another attempt holds the relay;
 * its copy may be in). An answer that already says `sendOutcome` (the fence's 409
 * `SEND_TARGET_CHANGED`) passes the wrapper byte for byte.
 *
 * The send service is a fake that fails the test when it is reached, so every
 * refusal below is one the route made before it. Every input here names no bound
 * relay (`relayId` absent, or one that was never reserved): with a bound one the
 * binding's own `finish` answers `not_sent` before the boundary, which would keep
 * these green with the rule removed (T11 covers that side).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { cancelRelay, createRelay } from '@/lib/db/relay-db';
import type { Worktree } from '@/types/models';
import type { SendFenceOutcome } from '@/lib/session/send-fence-outcome';
import type { InputBoundaryHooks } from '@/lib/session/instance-input-lock';

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
    getSessionName(id: string, instanceId?: string) { return `mcbd-${instanceId ?? 'codex'}-${id}`; }
  },
}));
vi.mock('@/lib/cli-tools/claude', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/claude')>()),
  ClaudeTool: class {
    id = 'claude';
    name = 'Claude Code';
    command = 'claude';
    async isInstalled() { return true; }
    async isRunning() { return isRunning(); }
    async startSession() {}
    async sendMessage() {}
    async killSession() {}
    getSessionName(id: string, instanceId?: string) { return `mcbd-${instanceId ?? 'claude'}-${id}`; }
  },
}));

const checkSessionOwnership = vi.fn(async (..._args: unknown[]) => ({ verdict: 'absent' }));
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: (...args: unknown[]) => checkSessionOwnership(...args),
}));
vi.mock('@/app/api/worktrees/[id]/send/pane-shell', () => ({ isPaneBackAtShell: vi.fn(async () => false) }));

// The wrapper's rule is read on an answer the route has never seen before (a new
// refusal in validation): the real validation, unless a test says otherwise.
const { validateSendRequest } = vi.hoisted(() => ({ validateSendRequest: vi.fn() }));
vi.mock('@/app/api/worktrees/[id]/send/send-request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/api/worktrees/[id]/send/send-request')>();
  validateSendRequest.mockImplementation(actual.validateSendRequest);
  return { ...actual, validateSendRequest: (...args: Parameters<typeof actual.validateSendRequest>) => validateSendRequest(...args) };
});

const sendUserMessage = vi.fn();
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));
vi.mock('@/lib/relay/relay-delivery', () => ({ evaluateRelayAfterSend: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime/terminal-broadcast')>()),
  broadcastSessionStatus: vi.fn(),
}));

let testDb: Database.Database | null = null;
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => {
    if (!testDb) throw new Error('no test db');
    return testDb;
  },
}));

import { POST as sendMessage } from '@/app/api/worktrees/[id]/send/route';
import { answerSendTargetChanged } from '@/app/api/worktrees/[id]/send/send-target-changed-answer';
import { planAskForSend } from '@/lib/ask/ask-send';
import { setAskVersionProbeForTest } from '@/lib/ask/ask-correlation';
import { clearSendAttempts } from '@/lib/session/send-attempt-state';

const WT = 'wt-4535-preflight';
const ASKER = 'wt-4535-asker';
const ASK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PREFLIGHT_MODULE = '@/app/api/worktrees/[id]/send/send-preflight-outcome';

let db: Database.Database;
let wtPath = '';

interface SendParams {
  content: string;
  onAttempt?: (attempt: { state: string; reason: string }) => void;
  inputBoundary?: InputBoundaryHooks;
}

/** The send service must not be reached: every refusal in this file is the route's own. */
function serviceMustNotBeReached(): void {
  sendUserMessage.mockImplementation(async () => {
    throw new Error('the send service was reached — this refusal is not one made before it');
  });
}

async function postRaw(body: string, worktreeId = WT): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/worktrees/${worktreeId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return (await sendMessage(request as unknown as NextRequest, {
    params: Promise.resolve({ id: worktreeId }),
  })) as unknown as Response;
}

async function post(extra: Record<string, unknown>, worktreeId = WT): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await postRaw(JSON.stringify({ content: 'review this', cliToolId: 'codex', ...extra }), worktreeId);
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

function boundRelay() {
  return createRelay(db, {
    from: { worktreeId: ASKER, instanceId: 'claude' },
    to: { worktreeId: WT, instanceId: 'codex' },
    hops: 1,
    expiresAt: Date.now() + 60_000,
    bindMode: 'bound',
  });
}

beforeEach(() => {
  wtPath = mkdtempSync(join(tmpdir(), 'send-preflight-4535-'));
  db = new Database(':memory:');
  runMigrations(db);
  testDb = db;
  vi.clearAllMocks();
  isRunning.mockResolvedValue(true);
  clearSendAttempts();
  serviceMustNotBeReached();
  setAskVersionProbeForTest(async (tool) => (tool === 'claude' ? '2.1.293 (Claude Code)' : null));
  for (const id of [WT, ASKER]) {
    upsertWorktree(db, {
      id,
      name: id,
      path: id === WT ? wtPath : join(wtPath, 'asker'),
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'codex',
    } as Worktree);
  }
});

afterEach(() => {
  setAskVersionProbeForTest(null);
  testDb = null;
  db.close();
  rmSync(wtPath, { recursive: true, force: true });
});

describe('T13: no refusal before the send service answers without sendOutcome (Issue #4535 C4)', () => {
  const refusals: Array<{ name: string; send: () => Promise<{ status: number; body: Record<string, unknown> }>; status: number; code?: string }> = [
    { name: 'the worktree does not exist', send: () => post({}, 'wt-4535-missing'), status: 404 },
    {
      name: 'a body that is not JSON',
      send: async () => {
        const response = await postRaw('{not json');
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
      },
      status: 400,
    },
    { name: 'an empty body text', send: () => post({ content: '   ' }), status: 400 },
    { name: 'an unknown tool id', send: () => post({ cliToolId: 'nope' }), status: 400 },
    {
      name: 'the ask id is reserved for another message',
      send: async () => {
        await planAskForSend(db, { id: ASK }, { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude', content: 'something else' });
        return post({ cliToolId: 'claude', ask: { id: ASK, protocol: 1 } });
      },
      status: 409,
      code: 'ASK_ID_CONFLICT',
    },
    { name: 'a relayId that is not a relay id', send: () => post({ relayId: 'not-a-uuid' }), status: 400, code: 'RELAY_BIND_INVALID' },
    { name: 'a relayId that is not a string', send: () => post({ relayId: 7 }), status: 400, code: 'RELAY_BIND_INVALID' },
    {
      name: 'model_refused, the early check (a send naming a role)',
      send: () => post({ cliToolId: 'claude', model: 'opus', role: { state: 'inherit' } }),
      status: 400,
      code: 'model_refused',
    },
    { name: 'model_refused, the late check (a running claude)', send: () => post({ cliToolId: 'claude', model: 'opus' }), status: 400, code: 'model_refused' },
    {
      name: 'INVALID_PATH, the early check (a send naming a role)',
      send: () => post({ imagePath: 'http://example.invalid/x.png', role: { state: 'inherit' } }),
      status: 400,
      code: 'INVALID_PATH',
    },
    { name: 'INVALID_PATH, the late check', send: () => post({ imagePath: 'http://example.invalid/x.png' }), status: 400, code: 'INVALID_PATH' },
  ];

  it.each(refusals)('$name: $status not_sent, the service never reached', async ({ send, status, code }) => {
    const answer = await send();
    expect(answer.status).toBe(status);
    if (code !== undefined) expect(answer.body.code).toBe(code);
    expect(answer.body.sendOutcome).toBe('not_sent');
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('RELAY_BIND_CONFLICT (a closed relay): 409 unknown — another attempt may hold it', async () => {
    const relay = boundRelay();
    cancelRelay(db, relay.id);
    const { status, body } = await post({ relayId: relay.id });
    expect(status).toBe(409);
    expect(body.code).toBe('RELAY_BIND_CONFLICT');
    expect(body.sendOutcome).toBe('unknown');
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('the outer catch before the service: 500 not_sent', async () => {
    checkSessionOwnership.mockRejectedValueOnce(new Error('tmux went away'));
    const { status, body } = await post({});
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to send message', sendOutcome: 'not_sent' });
  });

  it('the wrapper reads a refusal it has never seen (EXACT_TARGET_MISMATCH) by the rule, not by a list', async () => {
    validateSendRequest.mockImplementationOnce(() => ({
      ok: false,
      response: NextResponse.json({ error: 'the target is not the one named', code: 'EXACT_TARGET_MISMATCH' }, { status: 400 }),
    }));
    const { status, body } = await post({});
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'the target is not the one named', code: 'EXACT_TARGET_MISMATCH', sendOutcome: 'not_sent' });
  });
});

describe('T13: the brief choice 409 (Q10)', () => {
  it('carries code brief_choice and not_sent; error keeps its value', async () => {
    sendUserMessage.mockResolvedValueOnce({
      ok: false,
      stage: 'brief_choice',
      code: 'boundary_changed',
      reason: 'superseded',
      boundary: { id: 'b-1', state: 'superseded' },
      error: 'brief choice aborted (superseded); nothing was typed',
    });
    const { status, body } = await post({ brief: 'decline', briefBoundary: 'b-1' });
    expect(status).toBe(409);
    expect(body).toEqual({
      error: 'boundary_changed',
      code: 'brief_choice',
      reason: 'superseded',
      boundary: { id: 'b-1', state: 'superseded' },
      sendOutcome: 'not_sent',
    });
  });
});

describe('T13 negative controls: what is answered as before', () => {
  it('the 201 of a plain send is unchanged (no sendOutcome)', async () => {
    sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
      params.onAttempt?.({ state: 'sent', reason: 'submitted' });
      return { ok: true, message: { id: 'm-own', worktreeId: WT, role: 'user', content: params.content } };
    });
    const { status, body } = await post({});
    expect(status).toBe(201);
    expect(body).not.toHaveProperty('sendOutcome');
  });

  it('a failure inside the service it never placed carries no sendOutcome', async () => {
    sendUserMessage.mockImplementationOnce(async () => ({ ok: false, stage: 'send', error: 'no record' }));
    const { status, body } = await post({});
    expect(status).toBe(500);
    expect(body).not.toHaveProperty('sendOutcome');
  });

  it('a throw inside the service (the outer catch after it was entered) carries no sendOutcome', async () => {
    sendUserMessage.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const { status, body } = await post({});
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to send message' });
  });

  it('a refusal recorded as this request\'s attempt (another server\'s session) is not_sent, as before', async () => {
    checkSessionOwnership.mockResolvedValueOnce({ verdict: 'foreign', sessionPath: '/elsewhere' } as never);
    const { status, body } = await post({});
    expect(status).toBe(409);
    expect(body.sendOutcome).toBe('not_sent');
  });
});

describe('INV-F3 control: a 409 SEND_TARGET_CHANGED passes the wrapper unchanged (4 cases)', () => {
  const fenceOf = (state: SendFenceOutcome['state']): SendFenceOutcome => ({
    kind: 'target-changed',
    state,
    order: 1,
    refusal: { reason: 'target-gone', requestId: 'req-4535' },
  });

  it.each([
    { bound: false, state: 'not-sent' as const },
    { bound: false, state: 'indeterminate' as const },
    { bound: true, state: 'not-sent' as const },
    { bound: true, state: 'indeterminate' as const },
  ])('bound=$bound, fence $state: the fence\'s body (+ relayId when bound), byte for byte', async ({ bound, state }) => {
    const fence = fenceOf(state);
    sendUserMessage.mockImplementationOnce(async (_db: unknown, params: SendParams) => {
      params.onAttempt?.({ state, reason: 'target-changed' });
      return { ok: false, stage: 'send', error: 'send target changed: target-gone', fence };
    });
    const relay = bound ? boundRelay() : null;
    const { status, text } = await post(relay ? { relayId: relay.id } : {});

    const fenceBody = (await answerSendTargetChanged(fence, { db, worktreeId: WT, instanceId: undefined, cliToolId: 'codex' }).json()) as Record<string, unknown>;
    expect(fenceBody.sendOutcome).toBe(state === 'not-sent' ? 'not_sent' : 'unknown');
    expect(status).toBe(409);
    expect(text).toBe(JSON.stringify(relay ? { ...fenceBody, relayId: relay.id } : fenceBody));
  });
});

describe('T13: the rule itself (send-preflight-outcome.ts, called directly)', () => {
  interface PreflightModule {
    preflightSendOutcome: (
      answer: { status: number; body: Record<string, unknown> },
      state: { attemptRecorded: boolean; serviceEntered: boolean; stoppedBeforeKeys: boolean },
    ) => 'not_sent' | 'unknown' | null;
  }
  const load = async (): Promise<PreflightModule> => (await import(/* @vite-ignore */ PREFLIGHT_MODULE)) as PreflightModule;
  const before = { attemptRecorded: false, serviceEntered: false, stoppedBeforeKeys: false };

  it('a new refusal it has no list entry for (400 EXACT_TARGET_MISMATCH, nothing recorded, before the service) is not_sent', async () => {
    const { preflightSendOutcome } = await load();
    expect(preflightSendOutcome({ status: 400, body: { error: 'x', code: 'EXACT_TARGET_MISMATCH' } }, before)).toBe('not_sent');
    expect(preflightSendOutcome({ status: 404, body: { error: 'x' } }, before)).toBe('not_sent');
    expect(preflightSendOutcome({ status: 500, body: { error: 'x' } }, before)).toBe('not_sent');
  });

  it('RELAY_BIND_CONFLICT is unknown', async () => {
    const { preflightSendOutcome } = await load();
    expect(preflightSendOutcome({ status: 409, body: { error: 'x', code: 'RELAY_BIND_CONFLICT' } }, before)).toBe('unknown');
  });

  it('an answer that already says sendOutcome is left alone', async () => {
    const { preflightSendOutcome } = await load();
    for (const sendOutcome of ['not_sent', 'unknown', 'sent']) {
      expect(preflightSendOutcome({ status: 409, body: { code: 'SEND_TARGET_CHANGED', sendOutcome } }, before)).toBeNull();
      expect(preflightSendOutcome({ status: 409, body: { code: 'RELAY_BIND_CONFLICT', sendOutcome } }, before)).toBeNull();
    }
  });

  it('a recorded attempt, a service that was entered, or a success adds nothing; a service that stopped before any key is not_sent', async () => {
    const { preflightSendOutcome } = await load();
    const refusal = { status: 400, body: { error: 'x', code: 'EXACT_TARGET_MISMATCH' } };
    expect(preflightSendOutcome(refusal, { ...before, attemptRecorded: true })).toBeNull();
    expect(preflightSendOutcome(refusal, { ...before, serviceEntered: true })).toBeNull();
    expect(preflightSendOutcome(refusal, { ...before, serviceEntered: true, stoppedBeforeKeys: true })).toBe('not_sent');
    expect(preflightSendOutcome({ status: 201, body: { id: 'm' } }, before)).toBeNull();
    expect(preflightSendOutcome({ status: 200, body: { ask: {} } }, before)).toBeNull();
  });
});
