/**
 * The SSE subscription to an OpenCode V2 instance's own server (Issue #2934, D5).
 *
 * Driven against a real loopback HTTP server that speaks the wire format
 * measured on 2.0.18: Basic auth on every route, `data: {…}` frames and
 * `: heartbeat` comments on `GET /api/event`.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  closeOpencodeV2Subscription,
  getOpencodeV2Liveness,
  isOpencodeV2Subscribed,
  openOpencodeV2Subscription,
  resetOpencodeV2Subscriptions,
} from '@/lib/hooks/sources/opencode-v2/subscription';
import {
  createOpencodeV2SseParser,
  opencodeV2AuthorizationHeader,
  probeOpencodeV2Server,
} from '@/lib/hooks/sources/opencode-v2/client';
import {
  OPENCODE_V2_DIR_ENV,
  readOpencodeV2Password,
  removeOpencodeV2Password,
  writeOpencodeV2Password,
} from '@/lib/hooks/sources/opencode-v2/secrets';
import { opencodeV2AgentEventSource } from '@/lib/hooks/sources/opencode-v2/source';
import type { AgentInstanceRef, NormalizedAgentEvent } from '@/lib/hooks/sources/types';

const FIXTURES = resolve(__dirname, '../../../../fixtures/opencode-v2-live-2934');
const measured = JSON.parse(
  readFileSync(join(FIXTURES, 'sse-measured-turn.json'), 'utf8')
) as Record<string, unknown>[];
const reconstructed = JSON.parse(
  readFileSync(join(FIXTURES, 'sse-reconstructed.json'), 'utf8')
) as Record<string, unknown>[];

const target: AgentInstanceRef = {
  worktreeId: 'wt-2934-sub',
  cliToolId: 'opencode-v2',
  instanceId: 'opencode-v2',
};

let dir: string;
let server: Server;
let port: number;
let streams: ServerResponse[];
let authHeaders: (string | undefined)[];

async function startServer(onStream: (res: ServerResponse) => void): Promise<void> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    authHeaders.push(req.headers.authorization);
    const password = readOpencodeV2Password(target);
    if (password === null || req.headers.authorization !== opencodeV2AuthorizationHeader(password)) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url === '/openapi.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      streams.push(res);
      onStream(res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
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

beforeEach(() => {
  dir = makeTempDir('cm-2934-sub-');
  vi.stubEnv(OPENCODE_V2_DIR_ENV, join(dir, 'opencode-v2'));
  writeOpencodeV2Password(target);
  streams = [];
  authHeaders = [];
});

afterEach(async () => {
  resetOpencodeV2Subscriptions();
  for (const res of streams) res.destroy();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  vi.unstubAllEnvs();
  removeTempDir(dir);
});

describe('openOpencodeV2Subscription (Issue #2934 D5)', () => {
  it('authenticates, goes live, and delivers every mapped frame to its own instance', async () => {
    await startServer((res) => {
      res.write(': heartbeat\n\n');
      // location-less (measured) and location-carrying (reconstructed) alike,
      // plus a type Phase 1 ignores.
      send(res, measured[0]);
      send(res, reconstructed.find((f) => f.type === 'session.reasoning.delta'));
      send(res, reconstructed.find((f) => f.type === 'permission.asked'));
      send(res, measured[1]);
    });

    const events: NormalizedAgentEvent[] = [];
    openOpencodeV2Subscription(
      target,
      port,
      (event) => events.push(event),
      (raw) => opencodeV2AgentEventSource.normalizeEvent(raw)
    );

    await waitFor(() => events.length === 3);
    expect(events.map((e) => [e.event, e.detail])).toEqual([
      ['user_prompt_submit', null],
      ['notification', 'permission_prompt'],
      ['stop', null],
    ]);
    expect(getOpencodeV2Liveness(target).state).toBe('live');
    const password = readOpencodeV2Password(target) as string;
    expect(authHeaders.every((h) => h === opencodeV2AuthorizationHeader(password))).toBe(true);
  });

  it('opens once per instance', async () => {
    await startServer(() => {});
    const noop = (): void => {};
    const normalize = (): null => null;
    openOpencodeV2Subscription(target, port, noop, normalize);
    openOpencodeV2Subscription(target, port, noop, normalize);
    await waitFor(() => streams.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(streams).toHaveLength(1);
  });

  it('reconnects after the server drops the stream', async () => {
    await startServer((res) => {
      if (streams.length === 1) res.end();
      else send(res, measured[0]);
    });
    const events: NormalizedAgentEvent[] = [];
    openOpencodeV2Subscription(
      target,
      port,
      (event) => events.push(event),
      (raw) => opencodeV2AgentEventSource.normalizeEvent(raw)
    );
    await waitFor(() => events.length === 1, 8_000);
    expect(streams.length).toBeGreaterThanOrEqual(2);
  });

  it('ends itself when the password file is gone (the session was killed)', async () => {
    await startServer((res) => res.end());
    openOpencodeV2Subscription(target, port, () => {}, () => null);
    await waitFor(() => streams.length >= 1);
    removeOpencodeV2Password(target);
    await waitFor(() => !isOpencodeV2Subscribed(target), 8_000);
    expect(getOpencodeV2Liveness(target)).toMatchObject({
      state: 'lost',
      reason: 'password-file-missing',
    });
  });

  it('closes on request and says unknown afterwards', async () => {
    await startServer(() => {});
    openOpencodeV2Subscription(target, port, () => {}, () => null);
    await waitFor(() => streams.length === 1);
    await closeOpencodeV2Subscription(target);
    expect(isOpencodeV2Subscribed(target)).toBe(false);
    expect(getOpencodeV2Liveness(target)).toEqual({ state: 'unknown' });
  });
});

describe('probeOpencodeV2Server', () => {
  it('tells a server that holds this password from one that does not, and from nothing', async () => {
    await startServer(() => {});
    const password = readOpencodeV2Password(target) as string;
    expect(await probeOpencodeV2Server(port, password)).toEqual({ kind: 'healthy' });
    expect(await probeOpencodeV2Server(port, 'wrong')).toEqual({ kind: 'rejected', status: 401 });
    await new Promise<void>((done) => server.close(() => done()));
    server = undefined as unknown as Server;
    expect(await probeOpencodeV2Server(port, password)).toEqual({ kind: 'unreachable' });
  });
});

describe('createOpencodeV2SseParser', () => {
  it('splits frames on blank lines, across chunk boundaries and CRLF', () => {
    const parser = createOpencodeV2SseParser();
    expect(parser.push('data: {"a"')).toEqual([]);
    expect(parser.push(':1}\r\n\r\n: heartbeat\n\ndata: {"b":2}\n')).toEqual([
      { kind: 'frame', data: '{"a":1}' },
      { kind: 'heartbeat' },
    ]);
    expect(parser.flush()).toEqual([{ kind: 'frame', data: '{"b":2}' }]);
  });
});
