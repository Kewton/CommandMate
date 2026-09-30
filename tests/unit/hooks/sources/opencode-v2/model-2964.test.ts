/**
 * OpenCode V2 publishes the model that answered (Issue #2964).
 *
 * The model is read off the assistant messages of
 * `GET /api/session/{id}/message` — the document `./history` already reads at
 * each turn's end — and latched where v1's hook-borne model goes, so
 * `getResolvedAgentModelInfo` (what `current-output` and `capture --json`
 * publish) answers it and #2357's change edge fires when it moves.
 *
 * The HTTP side is a real loopback server with the same Basic auth as the real
 * one, driven with the document measured on 2.0.18
 * (`tests/fixtures/opencode-v2-history-2940`).
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
import { opencodeV2AuthorizationHeader } from '@/lib/hooks/sources/opencode-v2/client';
import {
  readLatestOpencodeV2AssistantModel,
  resetOpencodeV2HistoryQueue,
  syncOpencodeV2History,
} from '@/lib/hooks/sources/opencode-v2/history';
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
/** The first turn's closing `idle` — everything from it on (newest first) is turn 1. */
const IDLE_1 = 'msg_0e75f5c20002xJe8PotMAa1bZy';
/** What every assistant message of the capture was answered by. */
const MEASURED_MODEL = 'longcat-2.5-preview-free';

const target: AgentInstanceRef = {
  worktreeId: 'wt-2964',
  cliToolId: 'opencode-v2',
  instanceId: 'opencode-v2',
};

function documentAfterTurn1(): Record<string, unknown>[] {
  const index = DOCUMENT.data.findIndex((m) => m.id === IDLE_1);
  return DOCUMENT.data.slice(index);
}

/** The full document, with turn 2's assistant messages answered by `model`. */
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

beforeEach(() => {
  dir = makeTempDir('cm-2964-model-');
  vi.stubEnv(OPENCODE_V2_DIR_ENV, join(dir, 'opencode-v2'));
  writeOpencodeV2Password(target);
  discardAgentEventState(target.worktreeId, 'opencode-v2', 'opencode-v2');
  served = DOCUMENT.data;
  server = null;
  changes = [];
  unsubscribe = onAgentModelChange((change) => {
    if (change.worktreeId === target.worktreeId) changes.push(change);
  });
});

afterEach(async () => {
  unsubscribe();
  resetOpencodeV2HistoryQueue();
  discardAgentEventState(target.worktreeId, 'opencode-v2', 'opencode-v2');
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  vi.unstubAllEnvs();
  removeTempDir(dir);
});

describe('readLatestOpencodeV2AssistantModel (Issue #2964)', () => {
  it('names the measured model, bare — no providerID folded in', () => {
    expect(readLatestOpencodeV2AssistantModel(DOCUMENT.data)).toBe(MEASURED_MODEL);
  });

  it('takes the newest assistant message whatever order the page is in', () => {
    const switched = documentWithTurn2On('other-model');
    expect(readLatestOpencodeV2AssistantModel(switched)).toBe('other-model');
    expect(readLatestOpencodeV2AssistantModel([...switched].reverse())).toBe('other-model');
  });

  it('answers null, without throwing, when no assistant message names a model', () => {
    expect(readLatestOpencodeV2AssistantModel([])).toBeNull();
    expect(readLatestOpencodeV2AssistantModel(DOCUMENT.data.filter((m) => m.type !== 'assistant'))).toBeNull();
    expect(
      readLatestOpencodeV2AssistantModel([null, 1, 'x', { type: 'assistant' }, { type: 'assistant', model: {} }])
    ).toBeNull();
  });
});

describe('syncOpencodeV2History publishes the model (Issue #2964)', () => {
  it('is null before the first turn has been read', () => {
    expect(resolvedModel()).toBeNull();
  });

  it('latches the model that answered, and announces a switch on the next turn', async () => {
    await startServer();
    served = documentAfterTurn1();
    await syncOpencodeV2History(target, port, SESSION);
    expect(resolvedModel()).toBe(MEASURED_MODEL);
    // The first sighting is the starting model, announced to nobody (#2357).
    expect(changes).toEqual([]);

    served = documentWithTurn2On('other-model');
    await syncOpencodeV2History(target, port, SESSION);
    expect(resolvedModel()).toBe('other-model');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      cliToolId: 'opencode-v2',
      instanceId: 'opencode-v2',
      from: MEASURED_MODEL,
      to: 'other-model',
      source: 'hook',
    });

    // The same model again is not a change.
    await syncOpencodeV2History(target, port, SESSION);
    expect(changes).toHaveLength(1);
  });

  it('leaves the model null and throws nothing when the document has no assistant yet', async () => {
    await startServer();
    served = DOCUMENT.data.filter((m) => m.type === 'user');
    await expect(syncOpencodeV2History(target, port, SESSION)).resolves.toBe(0);
    expect(resolvedModel()).toBeNull();
  });

  it('keeps the last model when a later read names none (latch, never clear)', async () => {
    await startServer();
    await syncOpencodeV2History(target, port, SESSION);
    served = DOCUMENT.data.filter((m) => m.type === 'user');
    await syncOpencodeV2History(target, port, SESSION);
    expect(resolvedModel()).toBe(MEASURED_MODEL);
  });
});
