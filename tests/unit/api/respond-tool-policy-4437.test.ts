/**
 * Issue #4437 (PR1, server): `/respond` (all three shapes), `/prompt-response`
 * and `/prompt-response/strict` ask the tool policy with the body's `origin` as
 * soon as the tool is resolved — before the ownership check, the structured
 * decision, the input lock and any key.
 *
 * I1 refused (409 `TOOL_POLICY_DENIED`, `sendOutcome: not_sent`, nothing read
 * or typed) · I2 a declaration lets the same request through (the answer is
 * delivered once) · I3 another tool from `session` goes through · I4 no origin
 * / `terminal` go through · I5 a non-string origin is 400, an unknown string is
 * refused as `unknown`.
 *
 * The answer senders and the screen readers are stubbed: these suites prove
 * where the gate sits and what it answers, not how an answer is typed.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { NextResponse, type NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, upsertWorktree } from '@/lib/db';
import { TOOL_POLICY_DENIED, TOOL_POLICY_DENIED_MESSAGE } from '@/lib/tool-policy/policy';
import type { Worktree } from '@/types/models';

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const isRunning = vi.fn(async (..._args: unknown[]) => true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (tool: string) => ({
        name: tool,
        getSessionName: (id: string, instanceId?: string) => `mcbd-${tool}-${id}${instanceId && instanceId !== tool ? `-${instanceId}` : ''}`,
        isRunning: (...args: unknown[]) => isRunning(...args),
      }),
    }),
  },
}));
const checkSessionOwnership = vi.fn(async (..._args: unknown[]) => ({ verdict: 'owned', sessionPath: null }));
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: (...args: unknown[]) => checkSessionOwnership(...args),
}));
const checkWorktreeSessionOwnership = vi.fn(async (..._args: unknown[]) => ({ verdict: 'owned', sessionPath: null }));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: (...args: unknown[]) => checkWorktreeSessionOwnership(...args),
}));
const sendPromptAnswer = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@/lib/prompt-answer-sender', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/prompt-answer-sender')>()),
  sendPromptAnswer: (...args: unknown[]) => sendPromptAnswer(...args),
}));
const screenAtSend = vi.fn(async (..._args: unknown[]) => ({ frame: undefined, promptData: null, readMark: 0 }));
vi.mock('@/app/api/worktrees/[id]/respond/screen-at-send', () => ({
  screenAtSend: (...args: unknown[]) => screenAtSend(...args),
}));
const answerViaStructuredDecision = vi.fn(async (..._args: unknown[]): Promise<NextResponse | null> =>
  NextResponse.json({ success: true, answeredVia: 'structured' }),
);
vi.mock('@/app/api/worktrees/[id]/prompt-response/structured-decision', () => ({
  answerViaStructuredDecision: (...args: unknown[]) => answerViaStructuredDecision(...args),
}));
vi.mock('@/app/api/worktrees/[id]/prompt-response/ledger-record', () => ({
  notePromptResponseInLedger: (_ctx: unknown, _request: unknown, response: NextResponse) => response,
}));
const answerStrictlyAsInputWriter = vi.fn(async (..._args: unknown[]) => ({
  strictRespond: 1,
  code: 0,
  keysSent: 0,
  replayed: false,
}));
vi.mock('@/lib/session/strict-prompt-answer-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/strict-prompt-answer-io')>()),
  answerStrictlyAsInputWriter: (...args: unknown[]) => answerStrictlyAsInputWriter(...args),
  recordStrictAnswer: vi.fn(),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/tasks/task-transition-service', () => ({ applyEventToActiveTask: vi.fn() }));

import { POST as respond } from '@/app/api/worktrees/[id]/respond/route';
import { POST as promptResponse } from '@/app/api/worktrees/[id]/prompt-response/route';
import { POST as strictRespond } from '@/app/api/worktrees/[id]/prompt-response/strict/route';

const WT = 'wt-4437-respond';
const AGENT_ORIGINS = ['session', 'agent', 'schedule', 'unknown'] as const;

type Route = typeof respond;

async function post(route: Route, url: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = (await route(request as unknown as NextRequest, { params: Promise.resolve({ id: WT }) })) as unknown as Response;
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function storedPrompt(cliToolId: 'antigravity' | 'claude'): string {
  return createMessage(db, {
    worktreeId: WT,
    role: 'assistant',
    content: 'Allow?',
    timestamp: new Date(),
    messageType: 'prompt',
    promptData: { type: 'yes_no', question: 'Allow?', options: ['yes', 'no'], status: 'pending' },
    cliToolId,
  }).id;
}

const strictBody = (extra: Record<string, unknown>) => ({
  expectScreen: 'antigravity-permission',
  observation: 'token-4437',
  answer: 'Yes',
  operationId: 'op-4437-0001',
  ...extra,
});

/** Every way an answer could go out, counted together. */
function deliveries(): number {
  return sendPromptAnswer.mock.calls.length + answerViaStructuredDecision.mock.calls.length + answerStrictlyAsInputWriter.mock.calls.length;
}

function expectRefused(status: number, body: Record<string, unknown>, origin: string): void {
  expect(status).toBe(409);
  expect(body).toMatchObject({
    error: TOOL_POLICY_DENIED_MESSAGE,
    code: TOOL_POLICY_DENIED,
    policy: { tool: 'antigravity', operation: 'respond', origin, declaration: 'personal' },
    sendOutcome: 'not_sent',
  });
  expect(deliveries()).toBe(0);
  expect(checkSessionOwnership).not.toHaveBeenCalled();
  expect(checkWorktreeSessionOwnership).not.toHaveBeenCalled();
  expect(isRunning).not.toHaveBeenCalled();
  expect(screenAtSend).not.toHaveBeenCalled();
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, {
    id: WT,
    name: WT,
    path: `/path/to/${WT}`,
    repositoryPath: '/path/to/repo',
    repositoryName: 'repo',
    cliToolId: 'antigravity',
  } as Worktree);
  db.prepare('UPDATE worktrees SET selected_agents = ? WHERE id = ?').run(JSON.stringify(['antigravity', 'claude']), WT);
  vi.clearAllMocks();
  vi.stubEnv('CM_ANTIGRAVITY_USAGE', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
});

describe('Issue #4437: /respond — stored prompt (messageId)', () => {
  it.each(AGENT_ORIGINS)('origin %s → 409, the row stays pending, nothing typed (4437)', async (origin) => {
    const messageId = storedPrompt('antigravity');
    const { status, body } = await post(respond, 'respond', { messageId, answer: 'yes', origin });
    expectRefused(status, body, origin);
    const row = db.prepare('SELECT prompt_data FROM chat_messages WHERE id = ?').get(messageId) as { prompt_data: string };
    expect(JSON.parse(row.prompt_data).status).toBe('pending');
  });

  it('declared (api-key): the same request is answered, once (4437)', async () => {
    vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'api-key');
    const { status, body } = await post(respond, 'respond', { messageId: storedPrompt('antigravity'), answer: 'yes', origin: 'session' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('no origin (a person) and terminal: answered on antigravity (4437)', async () => {
    for (const extra of [{}, { origin: 'terminal' }]) {
      const { status } = await post(respond, 'respond', { messageId: storedPrompt('antigravity'), answer: 'yes', ...extra });
      expect(status).toBe(200);
    }
    expect(sendPromptAnswer).toHaveBeenCalledTimes(2);
  });

  it('another tool from origin session: answered (4437)', async () => {
    const { status } = await post(respond, 'respond', { messageId: storedPrompt('claude'), answer: 'yes', origin: 'session' });
    expect(status).toBe(200);
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('a non-string origin → 400, nothing read (4437)', async () => {
    const { status, body } = await post(respond, 'respond', { messageId: storedPrompt('antigravity'), answer: 'yes', origin: 7 });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'origin must be a string' });
    expect(deliveries()).toBe(0);
  });
});

describe('Issue #4437: /respond — structured shapes (decisionId, sole decision)', () => {
  it.each(AGENT_ORIGINS)('sole decision, origin %s → 409 before the agent is asked (4437)', async (origin) => {
    const { status, body } = await post(respond, 'respond', { answer: '1', cliTool: 'antigravity', origin });
    expectRefused(status, body, origin);
  });

  it('decisionId, origin session → 409 (4437)', async () => {
    const { status, body } = await post(respond, 'respond', { decisionId: 'per_4437', answer: '1', cliTool: 'antigravity', origin: 'session' });
    expectRefused(status, body, 'session');
  });

  it('declared, or no origin: not refused by the policy (the route answers as before) (4437)', async () => {
    const asPerson = await post(respond, 'respond', { answer: '1', cliTool: 'antigravity' });
    vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'enterprise');
    const declared = await post(respond, 'respond', { answer: '1', cliTool: 'antigravity', origin: 'session' });
    for (const { status, body } of [asPerson, declared]) {
      expect(body.code).not.toBe(TOOL_POLICY_DENIED);
      expect(status).not.toBe(409);
    }
    expect(declared).toEqual(asPerson);
  });
});

describe('Issue #4437: /prompt-response', () => {
  it.each(AGENT_ORIGINS)('origin %s → 409, nothing read or typed (4437)', async (origin) => {
    const { status, body } = await post(promptResponse, 'prompt-response', { answer: '1', cliTool: 'antigravity', origin, originEvidence: 'no-tty' });
    expectRefused(status, body, origin);
  });

  it('an unknown origin string is `unknown`, refused rather than 400 (4437)', async () => {
    const { status, body } = await post(promptResponse, 'prompt-response', { answer: '1', cliTool: 'antigravity', origin: 'cron' });
    expectRefused(status, body, 'unknown');
  });

  it('declared (enterprise): answered once (4437)', async () => {
    vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'enterprise');
    const { status } = await post(promptResponse, 'prompt-response', { answer: '1', cliTool: 'antigravity', origin: 'session' });
    expect(status).toBe(200);
    expect(answerViaStructuredDecision).toHaveBeenCalledTimes(1);
  });

  it('no origin / terminal on antigravity, session on claude: answered (4437)', async () => {
    for (const body of [
      { answer: '1', cliTool: 'antigravity' },
      { answer: '1', cliTool: 'antigravity', origin: 'terminal' },
      { answer: '1', cliTool: 'claude', origin: 'session' },
    ]) {
      expect((await post(promptResponse, 'prompt-response', body)).status).toBe(200);
    }
    expect(answerViaStructuredDecision).toHaveBeenCalledTimes(3);
  });

  it('negative control: the retired browser Auto-Yes origin is still its own 409 (4437)', async () => {
    const { status, body } = await post(promptResponse, 'prompt-response', { answer: '1', cliTool: 'antigravity', origin: 'auto-yes-browser' });
    expect(status).toBe(409);
    expect(body.reason).toBe('browser-auto-yes-retired');
  });

  it('a non-string origin → 400 (4437)', async () => {
    const { status, body } = await post(promptResponse, 'prompt-response', { answer: '1', cliTool: 'claude', origin: { a: 1 } });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'origin must be a string' });
    expect(deliveries()).toBe(0);
  });
});

describe('Issue #4437: /prompt-response/strict', () => {
  it.each(AGENT_ORIGINS)('origin %s → 409 with strictRespond, nothing captured or typed (4437)', async (origin) => {
    const { status, body } = await post(strictRespond, 'prompt-response/strict', strictBody({ cliTool: 'antigravity', origin }));
    expectRefused(status, body, origin);
    expect(body.strictRespond).toBe(1);
  });

  it('declared (api-key): answered once (4437)', async () => {
    vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'api-key');
    const { status } = await post(strictRespond, 'prompt-response/strict', strictBody({ cliTool: 'antigravity', origin: 'session' }));
    expect(status).toBe(200);
    expect(answerStrictlyAsInputWriter).toHaveBeenCalledTimes(1);
  });

  it('no origin / terminal: answered on antigravity (4437)', async () => {
    for (const extra of [{}, { origin: 'terminal' }]) {
      expect((await post(strictRespond, 'prompt-response/strict', strictBody({ cliTool: 'antigravity', ...extra }))).status).toBe(200);
    }
    expect(answerStrictlyAsInputWriter).toHaveBeenCalledTimes(2);
  });

  it('a non-string origin → 400 invalid_origin (4437)', async () => {
    const { status, body } = await post(strictRespond, 'prompt-response/strict', strictBody({ cliTool: 'antigravity', origin: false }));
    expect(status).toBe(400);
    expect(body).toMatchObject({ strictRespond: 1, code: 'invalid_origin' });
    expect(deliveries()).toBe(0);
  });
});
