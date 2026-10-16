/**
 * OpenCode V2 latches the model only for the subscription that is still the
 * instance's (Issue #3733).
 *
 * `syncOpencodeV2History` reads the session's messages, then latches the model
 * that answered (#2964). A subscription closed or replaced while that read was
 * in flight used to latch anyway, so a restarted or stopped session showed the
 * old model and #2357's change edge fired for it. Here the read is held at the
 * HTTP server until the test has closed the subscription.
 *
 * The rows are a different matter: the turn did happen, so they are still
 * written, and `requestId` keeps a later sync from doubling them.
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
  resetOpencodeV2HistoryQueue,
  syncOpencodeV2History,
} from '@/lib/hooks/sources/opencode-v2/history';
import { recordOpencodeV2TurnEnd } from '@/lib/hooks/sources/opencode-v2/subscription';
import {
  OPENCODE_V2_DIR_ENV,
  readOpencodeV2Password,
  writeOpencodeV2Password,
} from '@/lib/hooks/sources/opencode-v2/secrets';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';
import {
  discardAgentEventState,
  getResolvedAgentModelInfo,
  onAgentModelChange,
  type AgentModelChange,
} from '@/lib/session/agent-event-state';

const FIXTURES = resolve(__dirname, '../../../../fixtures/opencode-v2-history-2940');
const DOCUMENT = JSON.parse(
  readFileSync(join(FIXTURES, 'session-messages-two-turns-2.0.18.json'), 'utf8')
) as { data: Record<string, unknown>[] };

const SESSION = 'ses_f18a0b80affeVVzGMUwUIzo15L';
const IDLE_1 = 'msg_0e75f5c20002xJe8PotMAa1bZy';
const MEASURED_MODEL = 'longcat-2.5-preview-free';

const target: AgentInstanceRef = {
  worktreeId: 'wt-3733',
  cliToolId: 'opencode-v2',
  instanceId: 'opencode-v2',
};

function documentWithTurn2On(model: string): Record<string, unknown>[] {
  const index = DOCUMENT.data.findIndex((m) => m.id === IDLE_1);
  return DOCUMENT.data.map((message, i) =>
    i < index && message.type === 'assistant'
      ? { ...message, model: { id: model, providerID: 'opencode' } }
      : message
  );
}

function resolvedModel(): string | null {
  return getResolvedAgentModelInfo(target.worktreeId, 'opencode-v2', 'opencode-v2').model;
}

let dir: string;
let server: Server | null;
let port: number;
let served: Record<string, unknown>[];
let changes: AgentModelChange[];
let unsubscribe: () => void;
/** Set to hold the next message read until `release` is called. */
let gate: Promise<void> | null;
let requested: () => void;
let requestSeen: Promise<void>;

async function startServer(): Promise<void> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const password = readOpencodeV2Password(target);
    if (password === null || req.headers.authorization !== opencodeV2AuthorizationHeader(password)) {
      res.writeHead(401);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === `/api/session/${SESSION}/message`) {
      const held = gate;
      gate = null;
      requested();
      void (held ?? Promise.resolve()).then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: served, cursor: { previous: 'p', next: null } }));
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

/** Hold the next read; resolves the returned function to let it answer. */
function holdNextRead(): () => void {
  let release: () => void = () => {};
  gate = new Promise<void>((done) => (release = done));
  requestSeen = new Promise<void>((done) => (requested = done));
  return release;
}

beforeEach(async () => {
  dir = makeTempDir('cm-3733-latch-');
  vi.stubEnv(OPENCODE_V2_DIR_ENV, join(dir, 'opencode-v2'));
  writeOpencodeV2Password(target);
  discardAgentEventState(target.worktreeId, 'opencode-v2', 'opencode-v2');
  rows.clear();
  createMessage.mockClear();
  served = DOCUMENT.data;
  gate = null;
  requested = () => {};
  requestSeen = Promise.resolve();
  changes = [];
  unsubscribe = onAgentModelChange((change) => {
    if (change.worktreeId === target.worktreeId) changes.push(change);
  });
  await startServer();
});

afterEach(async () => {
  unsubscribe();
  resetOpencodeV2HistoryQueue();
  discardAgentEventState(target.worktreeId, 'opencode-v2', 'opencode-v2');
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  vi.unstubAllEnvs();
  removeTempDir(dir);
});

describe('syncOpencodeV2History latches only for the current subscription (Issue #3733)', () => {
  it('skips the latch, and its change edge, when the subscription closed during the read', async () => {
    // A model already latched by the previous, live subscription.
    await syncOpencodeV2History(target, port, SESSION);
    expect(resolvedModel()).toBe(MEASURED_MODEL);
    rows.clear();
    createMessage.mockClear();

    let current = true;
    served = documentWithTurn2On('other-model');
    const release = holdNextRead();
    const sync = syncOpencodeV2History(target, port, SESSION, () => current);
    await requestSeen;
    current = false; // closed (or replaced) while the read is held
    release();
    const written = await sync;

    expect(resolvedModel()).toBe(MEASURED_MODEL);
    expect(changes).toEqual([]);
    // The rows are still saved, once each.
    expect(written).toBeGreaterThan(0);
    expect(createMessage).toHaveBeenCalledTimes(written);
    await syncOpencodeV2History(target, port, SESSION, () => false);
    expect(createMessage).toHaveBeenCalledTimes(written);
  });

  it('leaves a never-latched instance at null when its subscription closed during the read', async () => {
    let current = true;
    const release = holdNextRead();
    const sync = recordOpencodeV2TurnEnd(
      target,
      port,
      { type: 'session.execution.succeeded', data: { sessionID: SESSION } },
      () => current
    );
    expect(sync).not.toBeNull();
    await requestSeen;
    current = false;
    release();
    await sync;

    expect(resolvedModel()).toBeNull();
    expect(changes).toEqual([]);
  });

  it('still latches, and announces the switch, while the subscription stays current', async () => {
    await syncOpencodeV2History(target, port, SESSION, () => true);
    expect(resolvedModel()).toBe(MEASURED_MODEL);

    served = documentWithTurn2On('other-model');
    const release = holdNextRead();
    const sync = recordOpencodeV2TurnEnd(
      target,
      port,
      { type: 'session.execution.succeeded', data: { sessionID: SESSION } },
      () => true
    );
    await requestSeen;
    release();
    await sync;

    expect(resolvedModel()).toBe('other-model');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: MEASURED_MODEL, to: 'other-model' });
  });
});
