/**
 * What a history producer's `broadcastMessage` actually reaches
 * (Issue #2214, corrected by #2220).
 *
 * Every unit test around #2214 mocks `@/lib/ws-server`, which means all of them
 * are green whether or not a real socket ever sees the frame. This file removes
 * that mock: a real `WebSocketServer` on a real HTTP server, a real `ws` client
 * in a real room, and a producer driven end to end into a real SQLite row.
 *
 * ## What #2214 claimed here, and why it was wrong
 *
 * The first two cases used to be called "production topology", and the third
 * "`next dev` topology". Both names overstated what a Vitest file can observe.
 * Nothing here loads a Next route bundle; the instances below come from this
 * process's module registry and `vi.resetModules()`. What they actually
 * distinguish is **one module instance versus two** — and #2220 established that
 * the two-instance case is not a `next dev` curiosity but the shape of
 * production:
 *
 * ```
 * dist/server/server.js             -> require("./src/lib/ws-server")  // calls setupWebSocket
 * .next/server/app/api/**\/route.js  -> .next/server/chunks/<n>.js      // a second copy, never set up
 * ```
 *
 * So the third case was reproducing the *production* failure while its name
 * said `next dev`, and #2214's acceptance was scoped to a topology that does not
 * exist. The cases are renamed to what they test and the third one's expectation
 * is flipped: since #2220 a second instance's publish is carried to the socket
 * owner by the registry in `lib/realtime/publisher-registry`.
 *
 * The bridge's own behaviour — subscriber counts, room lifecycle, ownership
 * under re-registration, the version sequence — is covered in
 * `ws-publisher-bridge-2220.test.ts`. This file stays what it was: proof that a
 * *producer*, driven for real, lands on a socket.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as HTTPServer } from 'http';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { parsePermissionRequestPayload } from '@/lib/hooks/permission-request-payload';
import {
  resolvePermissionRequest,
  type PermissionRequestSession,
} from '@/lib/hooks/permission-decision-service';
import { setupWebSocket, closeWebSocket, broadcastMessage } from '@/lib/ws-server';
import { __resetRoomPublisherRegistryForTest } from '@/lib/realtime/publisher-registry';
import type { Worktree } from '@/types/models';

/** The producer reaches its database through this; hand it the in-memory one. */
let db: Database.Database;
vi.mock('@/lib/db/db-instance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/db-instance')>()),
  getDbInstance: () => db,
}));

const WORKTREE_ID = 'wt-2214-ws';
const ONE_HOUR_MS = 3_600_000;
const SESSION: PermissionRequestSession = {
  worktreeId: WORKTREE_ID,
  cliToolId: 'claude',
  instanceId: 'claude',
};

let httpServer: HTTPServer;
let wsUrl: string;
let client: WebSocket;
let received: Array<Record<string, unknown>>;

/** Envelope `handleBroadcast` wraps every server-originated frame in. */
interface BroadcastEnvelope {
  type: string;
  worktreeId: string;
  data: { type: string; message?: { id: string; promptData?: { status?: string } } };
}

function envelopes(): BroadcastEnvelope[] {
  return received.filter((m) => m.type === 'broadcast') as unknown as BroadcastEnvelope[];
}

/** Resolve once the client has received `count` broadcast frames, or time out. */
async function waitForEnvelopes(count: number, timeoutMs = 2_000): Promise<void> {
  await vi.waitFor(() => expect(envelopes().length).toBeGreaterThanOrEqual(count), {
    timeout: timeoutMs,
    interval: 20,
  });
}

function seedWorktree(): void {
  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'Broadcast probe',
    path: '/test/broadcast-probe',
    repositoryPath: '/test/repo',
    repositoryName: 'TestRepo',
    cliToolId: 'claude',
  };
  upsertWorktree(db, worktree);
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  seedWorktree();
  clearAllAutoYesStates();
  clearAutoYesPolicyCache();
  // Issue #2220: the registry lives on `globalThis`, so a leftover owner from an
  // earlier file in the same worker would route this file's publishes into a
  // dead server. Claim it from a clean slate.
  __resetRoomPublisherRegistryForTest();

  httpServer = createServer();
  setupWebSocket(httpServer);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      const address = httpServer.address();
      wsUrl = `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 3000}`;
      resolve();
    });
  });

  received = [];
  client = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    client.on('open', () => resolve());
    client.on('error', reject);
  });
  client.on('message', (data) => {
    received.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  client.send(JSON.stringify({ type: 'subscribe', worktreeId: WORKTREE_ID }));
  // The room is joined on the server's next turn; give it one before publishing.
  await new Promise((resolve) => setTimeout(resolve, 100));
});

afterEach(async () => {
  client.close();
  closeWebSocket();
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
  db.close();
  clearAllAutoYesStates();
  __resetRoomPublisherRegistryForTest();
  vi.resetModules();
});

describe('a producer and the socket owner in one module instance', () => {
  it('delivers a producer-written row to a subscribed socket', async () => {
    setAutoYesEnabled(WORKTREE_ID, 'claude', true, ONE_HOUR_MS);
    const payload = parsePermissionRequestPayload({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'git status', description: 'run a command' },
      prompt_id: 'prompt-2214',
    });
    expect(payload).not.toBeNull();

    expect(resolvePermissionRequest(SESSION, payload).behavior).toBe('allow');

    // Nothing is mocked between here and the socket: the row is in SQLite and
    // the frame went out over TCP.
    await waitForEnvelopes(1);
    const frame = envelopes()[0];
    expect(frame.worktreeId).toBe(WORKTREE_ID);
    expect(frame.data.type).toBe('message');
    expect(frame.data.message?.promptData?.status).toBe('answered');

    const rows = db
      .prepare(`SELECT id FROM chat_messages WHERE worktree_id = ?`)
      .all(WORKTREE_ID) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(frame.data.message?.id).toBe(rows[0].id);
  });

  it('delivers a `message_updated` frame from the same instance', async () => {
    // The sweep's event type, published directly: `worktree-status-helper`
    // reaches this exact function through the same import specifier.
    broadcastMessage('message_updated', {
      worktreeId: WORKTREE_ID,
      message: { id: 'msg-swept', promptData: { status: 'answered' } },
    });

    await waitForEnvelopes(1);
    expect(envelopes()[0].data.type).toBe('message_updated');
    expect(envelopes()[0].data.message?.id).toBe('msg-swept');
  });
});

describe('a producer in a second module instance', () => {
  it('reaches the owner’s socket through the publisher registry, exactly once', async () => {
    // A route handler's copy of the module. `vi.resetModules()` gives the next
    // import a fresh registry entry, which is the same thing a separate webpack
    // chunk gives a route handler: same source, different module scope, and —
    // before #2220 — a different, permanently empty `rooms`.
    vi.resetModules();
    const routeBundle = await import('@/lib/ws-server');
    expect(routeBundle.broadcastMessage).not.toBe(broadcastMessage);

    routeBundle.broadcastMessage('message', {
      worktreeId: WORKTREE_ID,
      message: { id: 'msg-from-route-bundle' },
    });

    // A positive control from the instance that owns the sockets, published
    // second. Without it, "nothing arrived" would also pass on a client that
    // never joined the room, and this test would prove nothing at all.
    broadcastMessage('message', {
      worktreeId: WORKTREE_ID,
      message: { id: 'msg-from-server-bundle' },
    });

    await waitForEnvelopes(2);
    // Both arrive, in the order they were published — this is the assertion
    // #2214 left at 1 and #2220 flipped. The length also pins the other half of
    // the contract: the route bundle's frame is delivered *once*, not once by
    // the bridge and again by a second publisher.
    expect(envelopes()).toHaveLength(2);
    expect(envelopes().map((e) => e.data.message?.id)).toEqual([
      'msg-from-route-bundle',
      'msg-from-server-bundle',
    ]);
  });
});
