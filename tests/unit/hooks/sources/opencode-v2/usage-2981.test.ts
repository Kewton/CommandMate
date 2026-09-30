/**
 * OpenCode V2 publishes its session's spend and context (Issue #2981).
 *
 * Driven by what 2.0.18 actually sent (`tests/fixtures/opencode-v2-usage-2981`):
 * the pure readers against the recorded bodies, then the refresh and the
 * subscription against a real loopback server that answers with the same
 * bodies behind the same Basic auth. The password directory is a
 * `mkdtempSync` sandbox under `os.tmpdir()`, removed after each test.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

vi.mock('@/lib/db', () => ({
  createMessage: vi.fn((_db: unknown, message: Record<string, unknown>) => ({ id: 'row', ...message })),
  findMessageByRequestId: vi.fn(() => null),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  ensureAgentSessionContextUsage,
  getAgentSessionContextUsage,
  getAgentSessionTelemetry,
  readOpencodeSessionInfo,
  recordAgentSessionContextUsage,
  recordAgentSessionTelemetry,
  resetAgentSessionContextUsage,
  resetAgentSessionTelemetry,
} from '@/lib/hooks/agent-session-telemetry';
import { opencodeV2AuthorizationHeader } from '@/lib/hooks/sources/opencode-v2/client';
import { resetOpencodeV2HistoryQueue } from '@/lib/hooks/sources/opencode-v2/history';
import {
  OPENCODE_V2_DIR_ENV,
  readOpencodeV2Password,
  removeOpencodeV2Password,
  writeOpencodeV2Password,
} from '@/lib/hooks/sources/opencode-v2/secrets';
import { opencodeV2AgentEventSource } from '@/lib/hooks/sources/opencode-v2/source';
import {
  closeOpencodeV2Subscription,
  openOpencodeV2Subscription,
  refreshOpencodeV2UsageOnFrame,
  resetOpencodeV2Subscriptions,
} from '@/lib/hooks/sources/opencode-v2/subscription';
import {
  isOpencodeV2UsageTriggerType,
  readOpencodeV2ContextTokens,
  readOpencodeV2ModelContextLimit,
  refreshOpencodeV2SessionUsage,
  resetOpencodeV2UsageRefreshes,
} from '@/lib/hooks/sources/opencode-v2/usage';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';

const FIXTURES = resolve(__dirname, '../../../../fixtures/opencode-v2-usage-2981');
function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

const SESSION_BODY = fixture<{ data: Record<string, unknown> }>(
  'session-get-after-two-turns-2.0.18.json'
);
const SESSION_LIST = fixture<{ data: Record<string, unknown>[] }>(
  'session-list-after-one-turn-2.0.18.json'
);
const MESSAGES = fixture<{ data: Record<string, unknown>[] }>(
  'session-messages-two-turns-2.0.18.json'
);
const MODELS = fixture<{ data: Record<string, unknown>[] }>(
  'model-list-opencode-provider-2.0.18.json'
);
const FRAMES = fixture<Record<string, unknown>[]>('sse-usage-two-turns-2.0.18.json');

const SESSION = 'ses_f1404be91ffex4cCxEyfrRm6bs';
const MODEL = 'longcat-2.5-preview-free';
/** The TUI after turn 2: footer `6.3K (1%)`, sidebar `6,341 tokens` / `1% used`. */
const CONTEXT_AFTER_TURN_2 = 6341;
/** The TUI after turn 1: footer `6.2K (1%)`, sidebar `6,208 tokens`. */
const CONTEXT_AFTER_TURN_1 = 6208;
const LIMIT = 1_000_000;

/** The document as it stood after turn 1: from turn 1's closing `idle` on (newest first). */
function messagesAfterTurn1(): Record<string, unknown>[] {
  const idles = MESSAGES.data.flatMap((m, i) => (m.type === 'idle' ? [i] : []));
  return MESSAGES.data.slice(idles[1]);
}

const target: AgentInstanceRef = {
  worktreeId: 'wt-2981',
  cliToolId: 'opencode-v2',
  instanceId: 'opencode-v2',
};

describe('what 2.0.18 measured (fixture pins)', () => {
  it('session.usage.updated carries the cumulative total that GET /api/session/{id} serves', () => {
    const usage = FRAMES.filter((f) => f.type === 'session.usage.updated');
    const last = usage[usage.length - 1].data as Record<string, unknown>;
    expect(last.tokens).toEqual(SESSION_BODY.data.tokens);
    expect(last.cost).toBe(SESSION_BODY.data.cost);
  });

  it('the context is the last step, not the session total', () => {
    const steps = FRAMES.filter((f) => f.type === 'session.step.ended');
    const tokens = (steps[steps.length - 1].data as { tokens: Record<string, number> & { cache: Record<string, number> } }).tokens;
    expect(tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write).toBe(
      CONTEXT_AFTER_TURN_2
    );
    const total = SESSION_BODY.data.tokens as { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
    expect(total.input + total.output + total.reasoning + total.cache.read + total.cache.write).not.toBe(
      CONTEXT_AFTER_TURN_2
    );
  });
});

describe('readers (Issue #2981)', () => {
  it('reads the session record verbatim from GET /api/session/{id}', () => {
    expect(readOpencodeSessionInfo(SESSION_BODY.data, 42)).toEqual({
      id: SESSION,
      title: 'ALPHA one',
      agent: 'build',
      model: MODEL,
      provider: 'opencode',
      cost: 0,
      tokens: { input: 5925, output: 34, reasoning: 128, cacheRead: 13312, cacheWrite: 0, total: null },
      at: 42,
    });
    // The list route serves the same shape (after turn 1).
    expect(readOpencodeSessionInfo(SESSION_LIST.data[0], 1)?.tokens).toMatchObject({
      input: 2857,
      output: 12,
      reasoning: 64,
      cacheRead: 3840,
    });
  });

  it("refuses a sub-agent's session", () => {
    expect(readOpencodeSessionInfo({ ...SESSION_BODY.data, parentID: 'ses_parent' }, 1)).toBeNull();
    expect(readOpencodeSessionInfo(null, 1)).toBeNull();
  });

  it('reads the context as the newest assistant message, in any order', () => {
    expect(readOpencodeV2ContextTokens(MESSAGES.data)).toBe(CONTEXT_AFTER_TURN_2);
    expect(readOpencodeV2ContextTokens([...MESSAGES.data].reverse())).toBe(CONTEXT_AFTER_TURN_2);
    expect(readOpencodeV2ContextTokens(messagesAfterTurn1())).toBe(CONTEXT_AFTER_TURN_1);
  });

  it('skips a step without output and answers null when there is none', () => {
    const streaming = {
      id: 'msg_zzzz',
      type: 'assistant',
      time: { created: Number.MAX_SAFE_INTEGER },
      tokens: { input: 9, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    expect(readOpencodeV2ContextTokens([streaming, ...MESSAGES.data])).toBe(CONTEXT_AFTER_TURN_2);
    expect(readOpencodeV2ContextTokens(MESSAGES.data.filter((m) => m.type !== 'assistant'))).toBeNull();
    expect(readOpencodeV2ContextTokens([null, 1, 'x', { type: 'assistant' }])).toBeNull();
  });

  it("reads the model's limit.context from GET /api/model", () => {
    expect(readOpencodeV2ModelContextLimit(MODELS.data, 'opencode', MODEL)).toBe(LIMIT);
    expect(readOpencodeV2ModelContextLimit(MODELS.data, 'other', MODEL)).toBeNull();
    expect(readOpencodeV2ModelContextLimit(MODELS.data, 'opencode', 'nope')).toBeNull();
    expect(
      readOpencodeV2ModelContextLimit([{ providerID: 'p', id: 'm', limit: { context: 0 } }], 'p', 'm')
    ).toBeNull();
  });

  it('triggers on session.usage.updated and the end of a turn only', () => {
    expect(isOpencodeV2UsageTriggerType('session.usage.updated')).toBe(true);
    expect(isOpencodeV2UsageTriggerType('session.execution.succeeded')).toBe(true);
    expect(isOpencodeV2UsageTriggerType('session.step.ended')).toBe(false);
    expect(isOpencodeV2UsageTriggerType(null)).toBe(false);
  });
});

let dir: string;
let server: Server | null;
let port: number;
let streams: ServerResponse[];
let sessionBody: Record<string, unknown>;
let requests: string[];

async function startServer(onStream: (res: ServerResponse) => void = () => {}): Promise<void> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const password = readOpencodeV2Password(target);
    if (password === null || req.headers.authorization !== opencodeV2AuthorizationHeader(password)) {
      res.writeHead(401);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(url.pathname);
    const json = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/openapi.json') return json({});
    if (url.pathname === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      streams.push(res);
      onStream(res);
      return;
    }
    if (url.pathname === `/api/session/${SESSION}`) return json(sessionBody);
    if (url.pathname === `/api/session/${SESSION}/message`) {
      return json({ data: MESSAGES.data, cursor: { previous: 'p', next: null } });
    }
    if (url.pathname === '/api/model') return json(MODELS);
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function telemetry() {
  return getAgentSessionTelemetry(target.worktreeId, 'opencode-v2', 'opencode-v2');
}
function context() {
  return getAgentSessionContextUsage(target.worktreeId, 'opencode-v2', 'opencode-v2');
}

beforeEach(() => {
  dir = makeTempDir('cm-2981-usage-');
  vi.stubEnv(OPENCODE_V2_DIR_ENV, join(dir, 'opencode-v2'));
  writeOpencodeV2Password(target);
  server = null;
  streams = [];
  requests = [];
  sessionBody = SESSION_BODY;
  resetAgentSessionTelemetry();
  resetAgentSessionContextUsage();
});

afterEach(async () => {
  resetOpencodeV2Subscriptions();
  resetOpencodeV2UsageRefreshes();
  resetOpencodeV2HistoryQueue();
  resetAgentSessionTelemetry();
  resetAgentSessionContextUsage();
  for (const res of streams) res.destroy();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  vi.unstubAllEnvs();
  removeTempDir(dir);
});

describe('refreshOpencodeV2SessionUsage (Issue #2981)', () => {
  it('stores the cumulative record and the last turn context, as the TUI shows them', async () => {
    await startServer();
    const record = await refreshOpencodeV2SessionUsage(target, port, SESSION);
    expect(record?.id).toBe(SESSION);
    expect(telemetry()).toMatchObject({
      id: SESSION,
      model: MODEL,
      provider: 'opencode',
      cost: 0,
      tokens: { input: 5925, output: 34, reasoning: 128, cacheRead: 13312, cacheWrite: 0 },
    });
    expect(context()).toMatchObject({
      tokens: CONTEXT_AFTER_TURN_2,
      limit: LIMIT,
      percent: 1,
      sessionAt: telemetry()?.at,
    });
  });

  it("ensureAgentSessionContextUsage answers v2's own measurement without dialing v1", async () => {
    await startServer();
    await refreshOpencodeV2SessionUsage(target, port, SESSION);
    const cached = context();
    // A newer record than the measurement: v1 would start a refresh; v2 must not.
    const newer = { ...telemetry()!, at: telemetry()!.at + 1 };
    expect(ensureAgentSessionContextUsage(target, newer)).toBe(cached);
  });

  it("writes nothing for a sub-agent's session", async () => {
    await startServer();
    sessionBody = { data: { ...SESSION_BODY.data, parentID: 'ses_parent' } };
    expect(await refreshOpencodeV2SessionUsage(target, port, SESSION)).toBeNull();
    expect(telemetry()).toBeNull();
    expect(context()).toBeNull();
  });

  it('writes nothing once the asking subscription is gone', async () => {
    await startServer();
    expect(await refreshOpencodeV2SessionUsage(target, port, SESSION, () => false)).toBeNull();
    expect(telemetry()).toBeNull();
  });

  it('writes nothing when the password file is gone, or nothing answers', async () => {
    await startServer();
    const closedPort = port;
    await new Promise<void>((done) => server!.close(() => done()));
    server = null;
    expect(await refreshOpencodeV2SessionUsage(target, closedPort, SESSION)).toBeNull();
    removeOpencodeV2Password(target);
    expect(await refreshOpencodeV2SessionUsage(target, closedPort, SESSION)).toBeNull();
    expect(telemetry()).toBeNull();
  });

  it('refreshOpencodeV2UsageOnFrame ignores frames that move nothing', async () => {
    await startServer();
    const step = FRAMES.find((f) => f.type === 'session.step.ended')!;
    expect(refreshOpencodeV2UsageOnFrame(target, port, step)).toBeNull();
    const usage = FRAMES.find((f) => f.type === 'session.usage.updated')!;
    await refreshOpencodeV2UsageOnFrame(target, port, usage);
    expect(telemetry()?.id).toBe(SESSION);
  });
});

describe('the subscription writes and forgets the usage (Issue #2981)', () => {
  it('records on the measured frames and drops both records on close', async () => {
    await startServer((res) => {
      for (const frame of FRAMES) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    });
    openOpencodeV2Subscription(
      target,
      port,
      () => {},
      (raw) => opencodeV2AgentEventSource.normalizeEvent(raw)
    );
    await waitFor(() => context()?.tokens === CONTEXT_AFTER_TURN_2);
    expect(telemetry()?.tokens.input).toBe(5925);

    await closeOpencodeV2Subscription(target);
    expect(telemetry()).toBeNull();
    expect(context()).toBeNull();
  });

  it('close forgets a record only for its own instance (v1 records untouched)', async () => {
    const v1 = { worktreeId: target.worktreeId, cliToolId: 'opencode' as const, instanceId: 'opencode' };
    const record = readOpencodeSessionInfo(SESSION_BODY.data, 1)!;
    recordAgentSessionTelemetry(v1, record);
    recordAgentSessionContextUsage(v1, { tokens: 1, limit: 2, percent: 50, sessionAt: 1, at: 1 });
    await startServer();
    openOpencodeV2Subscription(target, port, () => {}, () => null);
    await closeOpencodeV2Subscription(target);
    expect(getAgentSessionTelemetry(target.worktreeId, 'opencode', 'opencode')).toBe(record);
    expect(getAgentSessionContextUsage(target.worktreeId, 'opencode', 'opencode')?.percent).toBe(50);
  });
});
