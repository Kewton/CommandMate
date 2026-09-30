/**
 * Issue #2937: the opencode-v2 probe reads its own server's SSE with the
 * production client, and the `hook-correlation` slot is judged from what it
 * received. A local HTTP server plays `opencode2 serve` (Basic auth,
 * `/openapi.json`, `/api/event`), so no opencode2 runs here.
 *
 * @vitest-environment node
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateServerEvents } from '@/lib/agent-health/server-events';
import { opencodeV2AuthorizationHeader } from '@/lib/hooks/sources/opencode-v2/client';
import { ServerEventRecorder } from '../../../../scripts/agent-health/opencode-v2-server';

const PASSWORD = 'probe-password';

interface FakeServe {
  port: number;
  /** Send one frame to every open `/api/event`. */
  emit: (type: string) => void;
  close: () => Promise<void>;
}

const servers: FakeServe[] = [];

async function fakeServe(): Promise<FakeServe> {
  const streams = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== opencodeV2AuthorizationHeader(PASSWORD)) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/openapi.json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (req.url === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': heartbeat\n\n');
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let id = 0;
  const fake: FakeServe = {
    port: (server.address() as AddressInfo).port,
    emit: (type) => {
      id += 1;
      const frame = JSON.stringify({ id: `evt_${id}`, type, data: {} });
      for (const res of streams) res.write(`data: ${frame}\n\n`);
    },
    close: async () => {
      for (const res of streams) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  servers.push(fake);
  return fake;
}

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

describe('ServerEventRecorder + evaluateServerEvents', () => {
  it('passes when started and succeeded arrive, and keeps every distinct type', async () => {
    const serve = await fakeServe();
    const recorder = new ServerEventRecorder();
    expect(await recorder.start(serve.port, PASSWORD, 1000)).toBe(true);
    for (const type of [
      'session.execution.started',
      'session.reasoning.delta',
      'session.reasoning.delta',
      'session.execution.succeeded',
    ]) {
      serve.emit(type);
    }
    await until(() => recorder.events.length === 4);
    await recorder.stop();

    const verdict = evaluateServerEvents(recorder.events, { streamError: recorder.error });
    expect(verdict.status).toBe('pass');
    expect(verdict.summary).toContain(
      '受け取った type: session.execution.started, session.reasoning.delta, session.execution.succeeded'
    );
  });

  it('fails when succeeded never comes, and names what did arrive', async () => {
    const serve = await fakeServe();
    const recorder = new ServerEventRecorder();
    await recorder.start(serve.port, PASSWORD, 1000);
    serve.emit('session.execution.started');
    serve.emit('session.execution.completed');
    await until(() => recorder.events.length === 2);
    await recorder.stop();

    const verdict = evaluateServerEvents(recorder.events, { streamError: recorder.error });
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toContain('session.execution.succeeded が未着');
    expect(verdict.evidence).toBe(
      '受け取った type: session.execution.started, session.execution.completed'
    );
  });

  it('stop() returns while the server keeps the stream open', async () => {
    const serve = await fakeServe();
    const recorder = new ServerEventRecorder();
    await recorder.start(serve.port, PASSWORD, 1000);
    await recorder.stop();
    expect(recorder.error).toBeNull();
  });

  it('reports a server that rejects the password', async () => {
    const serve = await fakeServe();
    const recorder = new ServerEventRecorder();
    expect(await recorder.start(serve.port, 'wrong', 300)).toBe(false);
    expect(recorder.error).toContain('HTTP 401');
    expect(evaluateServerEvents([], { streamError: recorder.error }).status).toBe('fail');
  });
});
