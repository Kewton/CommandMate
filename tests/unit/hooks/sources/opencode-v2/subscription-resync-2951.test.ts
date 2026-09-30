/**
 * Every connection of the OpenCode V2 subscription first replays what the
 * server is still waiting on (Issue #2951).
 *
 * An approval raised while the stream was down (or before CommandMate started
 * listening) is otherwise never announced to the ingest, so neither the panel
 * nor Auto-Yes sees it. Driven against a real loopback HTTP server, as
 * `subscription.test.ts` is.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  openOpencodeV2Subscription,
  resetOpencodeV2Subscriptions,
} from '@/lib/hooks/sources/opencode-v2/subscription';
import { opencodeV2AuthorizationHeader } from '@/lib/hooks/sources/opencode-v2/client';
import {
  OPENCODE_V2_DIR_ENV,
  readOpencodeV2Password,
  writeOpencodeV2Password,
} from '@/lib/hooks/sources/opencode-v2/secrets';
import { opencodeV2AgentEventSource } from '@/lib/hooks/sources/opencode-v2/source';
import type { AgentInstanceRef, NormalizedAgentEvent } from '@/lib/hooks/sources/types';

const target: AgentInstanceRef = {
  worktreeId: 'wt-2951-sub',
  cliToolId: 'opencode-v2',
  instanceId: 'opencode-v2',
};

const SESSION = 'ses_2951probeSession000000000';
const PERMISSION = {
  id: 'per_2951probePermission0000000',
  sessionID: SESSION,
  action: 'edit',
  resources: ['hello.txt'],
  save: ['*'],
  metadata: {},
};
const FORM = {
  id: 'frm_2951probeForm00000000000000',
  sessionID: SESSION,
  title: 'Questions',
  fields: [
    {
      key: 'q0',
      title: 'Favourite colour?',
      type: 'string',
      options: [{ value: 'blue', label: 'Blue' }],
      custom: true,
    },
  ],
};

let dir: string;
let server: Server | null;
let port: number;
let streams: ServerResponse[];

async function startServer(onStream: (res: ServerResponse) => void): Promise<void> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const password = readOpencodeV2Password(target);
    if (password === null || req.headers.authorization !== opencodeV2AuthorizationHeader(password)) {
      res.writeHead(401);
      res.end();
      return;
    }
    const json = (value: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/openapi.json') return json({});
    if (req.url === '/api/permission/request') return json({ data: [PERMISSION] });
    if (req.url === '/api/form') return json({ data: [FORM] });
    if (req.url === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      streams.push(res);
      onStream(res);
      return;
    }
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

beforeEach(() => {
  dir = makeTempDir('cm-2951-sub-');
  vi.stubEnv(OPENCODE_V2_DIR_ENV, join(dir, 'opencode-v2'));
  writeOpencodeV2Password(target);
  streams = [];
  server = null;
});

afterEach(async () => {
  resetOpencodeV2Subscriptions();
  for (const res of streams) res.destroy();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  vi.unstubAllEnvs();
  removeTempDir(dir);
});

describe('openOpencodeV2Subscription replays the pending lists (Issue #2951)', () => {
  it('announces a pending approval and question on connecting, before any live frame', async () => {
    await startServer((res) => res.write(': heartbeat\n\n'));
    const events: NormalizedAgentEvent[] = [];
    openOpencodeV2Subscription(
      target,
      port,
      (event) => events.push(event),
      (raw) => opencodeV2AgentEventSource.normalizeEvent(raw)
    );

    await waitFor(() => events.length === 2);
    expect(events.map((event) => [event.event, event.detail, event.conversationId])).toEqual([
      ['notification', 'permission_prompt', SESSION],
      ['notification', 'question_prompt', SESSION],
    ]);
    expect(events.map((event) => opencodeV2AgentEventSource.eventIdentityOf(event.raw))).toEqual([
      PERMISSION.id,
      FORM.id,
    ]);
    // The replayed question carries its form, so the ingest reads it off the
    // frame (and so its `custom`) without asking the server again.
    expect(opencodeV2AgentEventSource.parseQuestion(events[1].raw)?.questions[0].custom).toBe(true);
  });

  it('replays again on a re-connection', async () => {
    await startServer((res) => {
      if (streams.length === 1) res.end();
      else res.write(': heartbeat\n\n');
    });
    const events: NormalizedAgentEvent[] = [];
    openOpencodeV2Subscription(
      target,
      port,
      (event) => events.push(event),
      (raw) => opencodeV2AgentEventSource.normalizeEvent(raw)
    );
    await waitFor(() => events.length >= 4, 8_000);
    expect(streams.length).toBeGreaterThanOrEqual(2);
  }, 10_000);
});
