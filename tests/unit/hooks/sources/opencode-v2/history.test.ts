/**
 * OpenCode V2's replies reach History (Issue #2940).
 *
 * Driven by what 2.0.18 was measured to send (`tests/fixtures/opencode-v2-history-2940`):
 * the SSE frames of two turns, and the `GET /api/session/{id}/message` document
 * the turn's end is read from. The HTTP side is a real loopback server with the
 * same Basic auth as the real one; the database is an in-memory map keyed the
 * way `findMessageByRequestId` is.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const rows = new Map<string, Record<string, unknown>>();
const createMessage = vi.fn((_db: unknown, message: Record<string, unknown>) => {
  const saved = { id: `row-${rows.size + 1}`, ...message };
  rows.set(String(message.requestId), saved);
  return saved;
});
const findMessageByRequestId = vi.fn(
  (_db: unknown, _worktreeId: string, requestId: string) => rows.get(requestId) ?? null
);

vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (...a: [unknown, string, string]) => findMessageByRequestId(...a),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import { opencodeV2AuthorizationHeader } from '@/lib/hooks/sources/opencode-v2/client';
import {
  buildOpencodeV2TurnsFromMessages,
  resetOpencodeV2HistoryQueue,
  syncOpencodeV2History,
} from '@/lib/hooks/sources/opencode-v2/history';
import {
  OPENCODE_V2_DIR_ENV,
  readOpencodeV2Password,
  writeOpencodeV2Password,
} from '@/lib/hooks/sources/opencode-v2/secrets';
import { opencodeV2AgentEventSource } from '@/lib/hooks/sources/opencode-v2/source';
import {
  getOpencodeV2Liveness,
  isOpencodeV2StructuredHistoryLive,
  openOpencodeV2Subscription,
  recordOpencodeV2TurnEnd,
  resetOpencodeV2Subscriptions,
} from '@/lib/hooks/sources/opencode-v2/subscription';
import { renderOpencodeTurn } from '@/lib/hooks/sources/opencode/transcript';
import type { AgentInstanceRef, NormalizedAgentEvent } from '@/lib/hooks/sources/types';
import { opencodeTurnRequestId } from '@/types/agent-transcript';

const FIXTURES = resolve(__dirname, '../../../../fixtures/opencode-v2-history-2940');
const DOCUMENT = JSON.parse(
  readFileSync(join(FIXTURES, 'session-messages-two-turns-2.0.18.json'), 'utf8')
) as { data: Record<string, unknown>[] };
const FRAMES = JSON.parse(
  readFileSync(join(FIXTURES, 'sse-two-turns-2.0.18.json'), 'utf8')
) as Record<string, unknown>[];

const SESSION = 'ses_f18a0b80affeVVzGMUwUIzo15L';
const USER_1 = 'msg_0e75f4826001x6PX1M8AIBrYGY';
const USER_2 = 'msg_0e75f74ec001P3u9WbSEfm7LEn';
/** The first turn's closing `idle` — everything up to it is turn 1. */
const IDLE_1 = 'msg_0e75f5c20002xJe8PotMAa1bZy';

const target: AgentInstanceRef = {
  worktreeId: 'wt-2940',
  cliToolId: 'opencode-v2',
  instanceId: 'opencode-v2',
};

/** The document as it stood right after turn 1 ended (newest first). */
function documentAfterTurn1(): Record<string, unknown>[] {
  const index = DOCUMENT.data.findIndex((m) => m.id === IDLE_1);
  return DOCUMENT.data.slice(index);
}

let dir: string;
let server: Server | null;
let port: number;
let streams: ServerResponse[];
let messagesStatus: number;
let served: Record<string, unknown>[];
let messageRequests: string[];

async function startServer(onStream: (res: ServerResponse) => void = () => {}): Promise<void> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const password = readOpencodeV2Password(target);
    if (password === null || req.headers.authorization !== opencodeV2AuthorizationHeader(password)) {
      res.writeHead(401);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/openapi.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (url.pathname === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      streams.push(res);
      onStream(res);
      return;
    }
    if (url.pathname === `/api/session/${SESSION}/message`) {
      messageRequests.push(url.search);
      if (messagesStatus !== 200) {
        res.writeHead(messagesStatus);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: served, cursor: { previous: 'p', next: null } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
}

function send(res: ServerResponse, frame: unknown): void {
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function assistantRows(): Record<string, unknown>[] {
  return [...rows.values()].filter((row) => row.role === 'assistant');
}

/** The frames of turn `n` (1-based), in the order they were sent. */
function framesOfTurn(n: 1 | 2): Record<string, unknown>[] {
  const ends = FRAMES.map((f, i) => (f.type === 'session.execution.succeeded' ? i : -1)).filter(
    (i) => i >= 0
  );
  return n === 1 ? FRAMES.slice(0, ends[0] + 1) : FRAMES.slice(ends[0] + 1, ends[1] + 1);
}

beforeEach(() => {
  dir = makeTempDir('cm-2940-history-');
  vi.stubEnv(OPENCODE_V2_DIR_ENV, join(dir, 'opencode-v2'));
  writeOpencodeV2Password(target);
  rows.clear();
  createMessage.mockClear();
  streams = [];
  messageRequests = [];
  messagesStatus = 200;
  served = DOCUMENT.data;
  server = null;
});

afterEach(async () => {
  resetOpencodeV2Subscriptions();
  resetOpencodeV2HistoryQueue();
  for (const res of streams) res.destroy();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  vi.unstubAllEnvs();
  removeTempDir(dir);
});

describe('buildOpencodeV2TurnsFromMessages (Issue #2940)', () => {
  it('rebuilds the two measured turns, each closed by its idle, oldest first', () => {
    const turns = buildOpencodeV2TurnsFromMessages(DOCUMENT.data, SESSION);
    expect(turns.map((t) => [t.accumulator.userMessageId, t.closed])).toEqual([
      [USER_1, true],
      [USER_2, true],
    ]);
    // Turn 2 is two assistant messages (a tool step, then the answer).
    expect(turns[1].accumulator.assistantMessageIds.size).toBe(2);
    expect(turns[1].completedAt).toBe(1790588203993);
  });

  it('renders the text as the reply, the reasoning folded behind it, and the tool as a line', () => {
    const [first, second] = buildOpencodeV2TurnsFromMessages(DOCUMENT.data, SESSION).map((t) =>
      renderOpencodeTurn(t.accumulator)
    );
    expect(first.body.startsWith('ALPHA one\n')).toBe(true);
    expect(first.textParts).toBe(1);
    expect(second.body.startsWith('BETA two\n')).toBe(true);
    expect(second.body).toContain('- `read`');
    expect(second.toolParts).toBe(1);
    // Neither turn carries the other's text.
    expect(first.body).not.toContain('BETA');
    expect(second.body).not.toContain('ALPHA');
    expect(first.unknownPartTypes).toEqual([]);
  });

  it('keeps a turn with no idle yet open, and drops assistants whose user message is out of view', () => {
    const withoutLastIdle = DOCUMENT.data.slice(1);
    const turns = buildOpencodeV2TurnsFromMessages(withoutLastIdle, SESSION);
    expect(turns.map((t) => t.closed)).toEqual([true, false]);

    const headless = DOCUMENT.data.filter((m) => m.id !== USER_2 && m.id !== USER_1);
    expect(buildOpencodeV2TurnsFromMessages(headless, SESSION)).toEqual([]);
  });

  it('reads a body that is not a message list as no turns', () => {
    expect(buildOpencodeV2TurnsFromMessages([null, 1, 'x', { type: 'user' }], SESSION)).toEqual([]);
  });
});

describe('syncOpencodeV2History (Issue #2940)', () => {
  it('writes one assistant row per turn, keyed on the user message, and never twice', async () => {
    await startServer();
    served = documentAfterTurn1();
    expect(await syncOpencodeV2History(target, port, SESSION)).toBe(1);
    served = DOCUMENT.data;
    expect(await syncOpencodeV2History(target, port, SESSION)).toBe(1);
    // A repeated end of turn writes nothing new.
    expect(await syncOpencodeV2History(target, port, SESSION)).toBe(0);

    const saved = assistantRows();
    expect(saved.map((r) => r.requestId)).toEqual([
      opencodeTurnRequestId(USER_1),
      opencodeTurnRequestId(USER_2),
    ]);
    expect(saved.every((r) => r.cliToolId === 'opencode-v2' && r.instanceId === 'opencode-v2')).toBe(
      true
    );
    expect(String(saved[0].content).split('\n')[0]).toBe('ALPHA one');
    expect(String(saved[1].content).split('\n')[0]).toBe('BETA two');
    expect(String(saved[1].content)).not.toContain('ALPHA');
    // Dated at the turn's end (`time.completed` of its last assistant message).
    expect((saved[1].timestamp as Date).getTime()).toBe(1790588203993);
    expect(messageRequests[0]).toContain('order=desc');
  });

  it('two turn ends at once still write each turn once', async () => {
    await startServer();
    const results = await Promise.all([
      syncOpencodeV2History(target, port, SESSION),
      syncOpencodeV2History(target, port, SESSION),
    ]);
    expect(results.sort()).toEqual([0, 2]);
    expect(assistantRows()).toHaveLength(2);
  });

  it('answers 0 and writes nothing when the server refuses, is gone, or has no password', async () => {
    await startServer();
    messagesStatus = 500;
    await expect(syncOpencodeV2History(target, port, SESSION)).resolves.toBe(0);

    await new Promise<void>((done) => server!.close(() => done()));
    server = null;
    await expect(syncOpencodeV2History(target, port, SESSION)).resolves.toBe(0);

    vi.stubEnv(OPENCODE_V2_DIR_ENV, join(dir, 'elsewhere'));
    await expect(syncOpencodeV2History(target, port, SESSION)).resolves.toBe(0);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('answers 0 when the database write throws', async () => {
    await startServer();
    createMessage.mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY');
    });
    await expect(syncOpencodeV2History(target, port, SESSION)).resolves.toBe(0);
  });
});

describe('the subscription records the reply on the turn end (Issue #2940)', () => {
  it('only frames that end a turn trigger a read', () => {
    expect(recordOpencodeV2TurnEnd(target, 1, { type: 'session.text.ended', data: {} })).toBeNull();
    expect(
      recordOpencodeV2TurnEnd(target, 1, { type: 'session.execution.succeeded', data: {} })
    ).toBeNull();
  });

  it('two measured turns over the stream give two rows, neither holding the other', async () => {
    let stream: ServerResponse | null = null;
    await startServer((res) => {
      stream = res;
    });
    const events: NormalizedAgentEvent[] = [];
    openOpencodeV2Subscription(
      target,
      port,
      (event) => events.push(event),
      (raw) => opencodeV2AgentEventSource.normalizeEvent(raw)
    );
    await waitFor(() => stream !== null);

    served = documentAfterTurn1();
    for (const frame of framesOfTurn(1)) send(stream!, frame);
    await waitFor(() => assistantRows().length === 1);

    served = DOCUMENT.data;
    for (const frame of framesOfTurn(2)) send(stream!, frame);
    await waitFor(() => assistantRows().length === 2);

    const [first, second] = assistantRows();
    expect(String(first.content).split('\n')[0]).toBe('ALPHA one');
    expect(String(second.content).split('\n')[0]).toBe('BETA two');
    expect(String(second.content)).not.toContain('ALPHA');
    // The state the stream publishes is unchanged by the history read.
    expect(events.map((e) => e.event)).toEqual([
      'user_prompt_submit',
      'stop',
      'user_prompt_submit',
      'stop',
    ]);
    expect(isOpencodeV2StructuredHistoryLive(target)).toBe(true);
  });

  it('a failed read neither stops the stream nor the state it publishes', async () => {
    let stream: ServerResponse | null = null;
    await startServer((res) => {
      stream = res;
    });
    messagesStatus = 500;
    const events: NormalizedAgentEvent[] = [];
    openOpencodeV2Subscription(
      target,
      port,
      (event) => events.push(event),
      (raw) => opencodeV2AgentEventSource.normalizeEvent(raw)
    );
    await waitFor(() => stream !== null);

    for (const frame of framesOfTurn(1)) send(stream!, frame);
    await waitFor(() => events.length === 2 && messageRequests.length === 1);
    for (const frame of framesOfTurn(2)) send(stream!, frame);
    await waitFor(() => events.length === 4 && messageRequests.length === 2);

    expect(assistantRows()).toEqual([]);
    expect(getOpencodeV2Liveness(target).state).toBe('live');
  });
});
