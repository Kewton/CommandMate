/**
 * The recovery sync on reconnect (Issue #4187, §5.1 R1〜R8c, C1〜C8).
 *
 * A turn of OpenCode V2 that closes while the event stream is down was written
 * only when a later turn of the same session ended. If none did, its reply
 * reached History never. Now a reconnect — a successful connection after an
 * earlier successful one — has the subscription read the sessions it had been
 * following when the stream was lost, once, after the pending resync.
 *
 * Driven against a loopback server with the real Basic auth (the shape of
 * `subscription.test.ts` and `history.test.ts`): `/api/event` is opened and
 * closed per connection, `/api/session/{id}/message` answers the measured
 * 2.0.18 document (`tests/fixtures/opencode-v2-history-2940`) and can be held
 * or failed, and the database is an in-memory map keyed like
 * `findMessageByRequestId`.
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
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  findMessageByRequestId: (_db: unknown, _worktreeId: string, requestId: string) =>
    rows.get(requestId) ?? null,
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
const broadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: (...a: unknown[]) => broadcastMessage(...a) }));
const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  };
  return { mockLogger };
});
vi.mock('@/lib/logger', () => ({ createLogger: vi.fn(() => mockLogger) }));

import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import { opencodeV2AuthorizationHeader } from '@/lib/hooks/sources/opencode-v2/client';
import {
  buildOpencodeV2TurnsFromMessages,
  resetOpencodeV2HistoryQueue,
} from '@/lib/hooks/sources/opencode-v2/history';
import {
  OPENCODE_V2_DIR_ENV,
  readOpencodeV2Password,
  writeOpencodeV2Password,
} from '@/lib/hooks/sources/opencode-v2/secrets';
import { opencodeV2AgentEventSource } from '@/lib/hooks/sources/opencode-v2/source';
import {
  closeOpencodeV2Subscription,
  openOpencodeV2Subscription,
  resetOpencodeV2Subscriptions,
  setOpencodeV2HistoryRecoveryRetryDelaysForTests,
} from '@/lib/hooks/sources/opencode-v2/subscription';
import { renderOpencodeTurn } from '@/lib/hooks/sources/opencode/transcript';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';
import {
  discardAgentEventState,
  getResolvedAgentModelInfo,
  onAgentModelChange,
  type AgentModelChange,
} from '@/lib/session/agent-event-state';
import { opencodeTurnRequestId } from '@/types/agent-transcript';

const FIXTURES = resolve(__dirname, '../../../../fixtures/opencode-v2-history-2940');
const DOCUMENT = JSON.parse(
  readFileSync(join(FIXTURES, 'session-messages-two-turns-2.0.18.json'), 'utf8')
) as { data: Record<string, unknown>[] };

const SESSION_A = 'ses_f18a0b80affeVVzGMUwUIzo15L';
const SESSION_B = 'ses_4187otherBBBBBBBBBBBBBBBB';
const USER_1 = 'msg_0e75f4826001x6PX1M8AIBrYGY';
const USER_2 = 'msg_0e75f74ec001P3u9WbSEfm7LEn';
const IDLE_1 = 'msg_0e75f5c20002xJe8PotMAa1bZy';

const target: AgentInstanceRef = {
  worktreeId: 'wt-4187-recovery',
  cliToolId: 'opencode-v2',
  instanceId: 'opencode-v2',
};

/** The document right after turn 1 ended (newest first). */
function documentAfterTurn1(): Record<string, unknown>[] {
  return DOCUMENT.data.slice(DOCUMENT.data.findIndex((m) => m.id === IDLE_1));
}

let dir: string;
let server: Server | null;
let port: number;
/** Per connection (0-based), what the server does with the opened stream. */
let onStream: (res: ServerResponse, index: number) => void;
let streams: ServerResponse[];
let probeStatuses: number[];
let documents: Record<string, Record<string, unknown>[]>;
/** Statuses for the next message reads, in order; empty = `defaultMessagesStatus`. */
let messagesStatuses: number[];
let defaultMessagesStatus: number;
let messageReads: string[];
let resyncReads: number;
/** Pending resync entries (`GET /api/permission/request`). */
let pendingPermissions: Record<string, unknown>[];
/** Set to hold the next read of that kind until released. */
let holdMessages: Promise<void> | null;
let holdResync: Promise<void> | null;
let events: number;
let modelChanges: AgentModelChange[];
let unsubscribe: () => void;

async function startServer(): Promise<void> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const password = readOpencodeV2Password(target);
    if (password === null || req.headers.authorization !== opencodeV2AuthorizationHeader(password)) {
      res.writeHead(401);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/openapi.json') {
      const status = probeStatuses.shift() ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (url.pathname === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // The real server answers the headers at once; Node holds them until the
      // first write, which a connection that says nothing would never make.
      res.flushHeaders();
      const index = streams.length;
      streams.push(res);
      onStream(res, index);
      return;
    }
    if (url.pathname === '/api/permission/request' || url.pathname === '/api/form') {
      const isPermission = url.pathname === '/api/permission/request';
      if (isPermission) resyncReads += 1;
      const held = isPermission ? holdResync : null;
      if (isPermission) holdResync = null;
      void (held ?? Promise.resolve()).then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: isPermission ? pendingPermissions : [] }));
      });
      return;
    }
    const match = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (match) {
      const sessionId = decodeURIComponent(match[1]);
      messageReads.push(sessionId);
      const status = messagesStatuses.shift() ?? defaultMessagesStatus;
      // The document as it is when asked, even if the answer is held.
      const document = documents[sessionId] ?? [];
      const held = holdMessages;
      holdMessages = null;
      void (held ?? Promise.resolve()).then(() => {
        if (status !== 200) {
          res.writeHead(status);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ data: document, cursor: { previous: 'p', next: null } })
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
}

function hold(): () => void {
  let release: () => void = () => {};
  const gate = new Promise<void>((done) => (release = done));
  holdMessages = gate;
  return release;
}

function holdNextResync(): () => void {
  let release: () => void = () => {};
  holdResync = new Promise<void>((done) => (release = done));
  return release;
}

let frameSeq = 0;
function send(res: ServerResponse, type: string, sessionId: string): void {
  frameSeq += 1;
  res.write(
    `data: ${JSON.stringify({ id: `evt_4187_${frameSeq}`, type, data: { sessionID: sessionId } })}\n\n`
  );
}

const started = (res: ServerResponse, sessionId: string): void =>
  send(res, 'session.execution.started', sessionId);
const ended = (res: ServerResponse, sessionId: string): void =>
  send(res, 'session.execution.succeeded', sessionId);

function open(): void {
  openOpencodeV2Subscription(
    target,
    port,
    () => {
      events += 1;
    },
    (raw) => opencodeV2AgentEventSource.normalizeEvent(raw)
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function assistantRows(): Record<string, unknown>[] {
  return [...rows.values()].filter((row) => row.role === 'assistant');
}

function resolvedModel(): string | null {
  return getResolvedAgentModelInfo(target.worktreeId, 'opencode-v2', 'opencode-v2').model;
}

function warned(event: string): unknown[][] {
  return mockLogger.warn.mock.calls.filter(([name]) => name === event);
}

beforeEach(async () => {
  dir = makeTempDir('cm-4187-recovery-');
  vi.stubEnv(OPENCODE_V2_DIR_ENV, join(dir, 'opencode-v2'));
  writeOpencodeV2Password(target);
  discardAgentEventState(target.worktreeId, 'opencode-v2', 'opencode-v2');
  modelChanges = [];
  unsubscribe = onAgentModelChange((change) => {
    if (change.worktreeId === target.worktreeId) modelChanges.push(change);
  });
  rows.clear();
  createMessage.mockClear();
  broadcastMessage.mockClear();
  mockLogger.warn.mockClear();
  onStream = () => {};
  streams = [];
  probeStatuses = [];
  documents = { [SESSION_A]: DOCUMENT.data };
  messagesStatuses = [];
  defaultMessagesStatus = 200;
  messageReads = [];
  resyncReads = 0;
  pendingPermissions = [];
  holdMessages = null;
  holdResync = null;
  events = 0;
  server = null;
  setOpencodeV2HistoryRecoveryRetryDelaysForTests([50, 50, 50]);
  await startServer();
});

afterEach(async () => {
  unsubscribe();
  resetOpencodeV2Subscriptions();
  resetOpencodeV2HistoryQueue();
  setOpencodeV2HistoryRecoveryRetryDelaysForTests(null);
  for (const res of streams) res.destroy();
  server?.closeAllConnections();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  discardAgentEventState(target.worktreeId, 'opencode-v2', 'opencode-v2');
  vi.unstubAllEnvs();
  removeTempDir(dir);
});

/**
 * Connection 1 records turn 1 live, then drops after turn 2 closed in the
 * document only. Resolves once turn 1's row is in.
 */
async function liveTurn1ThenDrop(): Promise<void> {
  documents[SESSION_A] = documentAfterTurn1();
  let first: ServerResponse | null = null;
  onStream = (res, index) => {
    if (index === 0) first = res;
  };
  open();
  await waitFor(() => first !== null);
  ended(first!, SESSION_A);
  await waitFor(() => assistantRows().length === 1);
  documents[SESSION_A] = DOCUMENT.data;
}

// Real sockets and a 500 ms reconnect backoff: room for a loaded machine.
describe('the recovery sync on reconnect (Issue #4187)', { timeout: 15_000 }, () => {
  it('R1: a turn that closed while the stream was down is written on reconnect, with nothing after', async () => {
    await liveTurn1ThenDrop();
    const before = messageReads.length;
    streams[0].end();
    await waitFor(() => assistantRows().length === 2);

    const expected = renderOpencodeTurn(
      buildOpencodeV2TurnsFromMessages(DOCUMENT.data, SESSION_A)[1].accumulator
    ).body;
    const row = rows.get(opencodeTurnRequestId(USER_2));
    expect(row?.content).toBe(expected);
    expect(String(row?.content).split('\n')[0]).toBe('BETA two');
    expect(messageReads.length - before).toBe(1);
    expect(streams.length).toBe(2);
  });

  it('R2: the next ordinary turn end after the recovery writes nothing more', async () => {
    await liveTurn1ThenDrop();
    streams[0].end();
    await waitFor(() => assistantRows().length === 2 && streams.length === 2);
    const reads = messageReads.length;
    ended(streams[1], SESSION_A);
    await waitFor(() => messageReads.length === reads + 1);
    await settle(100);
    expect(assistantRows()).toHaveLength(2);
    expect(createMessage).toHaveBeenCalledTimes(2);
  });

  it('R2b: an ordinary sync arriving during the recovery read still gives one row, one broadcast', async () => {
    await liveTurn1ThenDrop();
    const changesBefore = modelChanges.length;
    const release = hold();
    const reads = messageReads.length;
    streams[0].end();
    await waitFor(() => messageReads.length === reads + 1 && streams.length === 2);
    ended(streams[1], SESSION_A);
    await settle(100);
    release();
    await waitFor(() => messageReads.length === reads + 2);
    await settle(100);
    expect(assistantRows()).toHaveLength(2);
    expect(
      broadcastMessage.mock.calls.filter(
        ([, payload]) =>
          (payload as { message: { requestId: string } }).message.requestId ===
          opencodeTurnRequestId(USER_2)
      )
    ).toHaveLength(1);
    expect(modelChanges.length - changesBefore).toBeLessThanOrEqual(1);
  });

  it('R3: the first connection does not recover', async () => {
    onStream = (res) => started(res, SESSION_A);
    open();
    await waitFor(() => events >= 1);
    await settle(400);
    expect(messageReads).toEqual([]);
  });

  it('R3b: nor does the first successful connection after a failed attempt', async () => {
    probeStatuses = [503];
    onStream = (res) => started(res, SESSION_A);
    open();
    await waitFor(() => events >= 1, 8_000);
    await settle(400);
    expect(messageReads).toEqual([]);
  });

  it('R3c: each reconnect recovers once', async () => {
    onStream = (res, index) => {
      if (index === 0) {
        started(res, SESSION_A);
        setTimeout(() => res.end(), 100);
      } else if (index === 1) {
        void waitFor(() => messageReads.length === 1).then(() => res.end());
      }
    };
    open();
    await waitFor(() => streams.length === 3 && messageReads.length === 2, 8_000);
    await settle(400);
    expect(messageReads).toEqual([SESSION_A, SESSION_A]);
    expect(assistantRows()).toHaveLength(2);
  });

  it('R3d: heartbeats do not recover', async () => {
    onStream = (res) => {
      started(res, SESSION_A);
      for (let i = 1; i <= 5; i += 1) setTimeout(() => res.write(': heartbeat\n\n'), i * 50);
    };
    open();
    await waitFor(() => events >= 1);
    await settle(500);
    expect(messageReads).toEqual([]);
  });

  it('R4: a reconnect with no session ever seen reads nothing', async () => {
    onStream = (res, index) => {
      res.write(': heartbeat\n\n');
      if (index === 0) setTimeout(() => res.end(), 100);
    };
    open();
    await waitFor(() => streams.length === 2);
    await settle(400);
    expect(messageReads).toEqual([]);
  });

  it('R5: a subscription opened again does not read the closed one’s sessions', async () => {
    onStream = (res, index) => {
      if (index === 0) started(res, SESSION_A);
      if (index === 1) setTimeout(() => res.end(), 100);
    };
    open();
    await waitFor(() => events >= 1);
    await closeOpencodeV2Subscription(target);
    open();
    await waitFor(() => streams.length === 3);
    await settle(400);
    expect(messageReads).toEqual([]);
  });

  it('R6: a resync frame of another session does not push the lost session out', async () => {
    pendingPermissions = [];
    onStream = (res, index) => {
      if (index === 0) {
        started(res, SESSION_A);
        setTimeout(() => {
          pendingPermissions = [{ id: 'per_4187', sessionID: SESSION_B, permission: 'edit' }];
          res.end();
        }, 100);
      }
    };
    open();
    await waitFor(() => assistantRows().length === 2, 8_000);
    expect(messageReads).toContain(SESSION_A);
    expect([...rows.keys()].sort()).toEqual(
      [opencodeTurnRequestId(USER_1), opencodeTurnRequestId(USER_2)].sort()
    );
  });

  it('R6b: a sync of a session that is no longer current writes but does not latch its model', async () => {
    let stream: ServerResponse | null = null;
    onStream = (res) => {
      stream = res;
    };
    open();
    await waitFor(() => stream !== null);
    const release = hold();
    ended(stream!, SESSION_A);
    await waitFor(() => messageReads.length === 1);
    const before = events;
    started(stream!, SESSION_B);
    await waitFor(() => events > before);
    release();
    await waitFor(() => assistantRows().length === 2);
    await settle(50);
    expect(resolvedModel()).toBeNull();
    expect(modelChanges).toEqual([]);
  });

  it('R7: a subscription closed during the resync does not start the recovery', async () => {
    let release: () => void = () => {};
    onStream = (res, index) => {
      if (index === 0) {
        started(res, SESSION_A);
        setTimeout(() => {
          release = holdNextResync();
          res.end();
        }, 100);
      }
    };
    open();
    await waitFor(() => streams.length === 2 && resyncReads === 2);
    await closeOpencodeV2Subscription(target);
    release();
    await settle(400);
    expect(messageReads).toEqual([]);
  });

  it('R7b: closed during the recovery read, the rows are written and the model is not latched', async () => {
    let release: () => void = () => {};
    onStream = (res, index) => {
      if (index === 0) {
        started(res, SESSION_A);
        setTimeout(() => {
          release = hold();
          res.end();
        }, 100);
      }
    };
    open();
    await waitFor(() => messageReads.length === 1);
    await closeOpencodeV2Subscription(target);
    release();
    await waitFor(() => assistantRows().length === 2);
    await settle(50);
    expect(resolvedModel()).toBeNull();
    expect(modelChanges).toEqual([]);
  });

  it('R8: a failed recovery read is tried again', async () => {
    messagesStatuses = [500];
    onStream = (res, index) => {
      if (index === 0) {
        started(res, SESSION_A);
        setTimeout(() => res.end(), 100);
      }
    };
    open();
    await waitFor(() => assistantRows().length === 2, 8_000);
    expect(messageReads).toEqual([SESSION_A, SESSION_A]);
  });

  it('R8b: it gives up after three retries, and says so once', async () => {
    defaultMessagesStatus = 500;
    onStream = (res, index) => {
      if (index === 0) {
        started(res, SESSION_A);
        setTimeout(() => res.end(), 100);
      }
    };
    open();
    await waitFor(() => messageReads.length === 4, 8_000);
    await settle(400);
    expect(messageReads).toHaveLength(4);
    expect(warned('opencode-v2-history-recovery-failed')).toHaveLength(1);
    expect(assistantRows()).toEqual([]);
  });

  it('R9: an older recovery read that succeeds keeps a loss of the same session during it', async () => {
    // Connection 1's recovery read is held; meanwhile turn 2 closes and the
    // stream is lost again. The held read (of the document without turn 2)
    // succeeds before the next reconnect, which must still read turn 2.
    documents[SESSION_A] = documentAfterTurn1();
    onStream = (res, index) => {
      if (index === 0) {
        started(res, SESSION_A);
        setTimeout(() => res.end(), 100);
      }
    };
    const release = hold();
    open();
    await waitFor(() => messageReads.length === 1 && streams.length === 2, 8_000);
    documents[SESSION_A] = DOCUMENT.data;
    streams[1].end();
    await settle(50);
    expect(streams.length).toBe(2);
    release();
    await waitFor(() => assistantRows().length === 1);
    expect(rows.has(opencodeTurnRequestId(USER_1))).toBe(true);
    await waitFor(() => assistantRows().length === 2, 8_000);
    expect(rows.has(opencodeTurnRequestId(USER_2))).toBe(true);
    expect(streams.length).toBe(3);
  });

  it('R9b: with no loss during it, a successful recovery read takes the session out', async () => {
    documents[SESSION_A] = documentAfterTurn1();
    onStream = (res, index) => {
      if (index === 0) {
        started(res, SESSION_A);
        setTimeout(() => res.end(), 100);
      }
    };
    const release = hold();
    open();
    await waitFor(() => messageReads.length === 1 && streams.length === 2, 8_000);
    release();
    await waitFor(() => assistantRows().length === 1);
    await settle(400);
    expect(messageReads).toEqual([SESSION_A]);
    expect(streams.length).toBe(2);
  });

  it('R8c: closing during the wait before a retry stops the retries', async () => {
    setOpencodeV2HistoryRecoveryRetryDelaysForTests([400, 400, 400]);
    defaultMessagesStatus = 500;
    onStream = (res, index) => {
      if (index === 0) {
        started(res, SESSION_A);
        setTimeout(() => res.end(), 100);
      }
    };
    open();
    await waitFor(() => messageReads.length === 1, 8_000);
    await settle(50);
    await closeOpencodeV2Subscription(target);
    await settle(1_000);
    expect(messageReads).toHaveLength(1);
  });
});
