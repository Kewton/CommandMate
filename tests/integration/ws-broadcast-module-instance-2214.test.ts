/**
 * What a history producer's `broadcastMessage` actually reaches (Issue #2214).
 *
 * Every unit test around #2214 mocks `@/lib/ws-server`, which means all of them
 * are green whether or not a real socket ever sees the frame. This file removes
 * that mock: a real `WebSocketServer` on a real HTTP server, a real `ws` client
 * in a real room, and a producer driven end to end into a real SQLite row.
 *
 * It exists for one design fact that no mock can express. `broadcastMessage`
 * writes to `rooms`, a plain module-scope `Map` in `src/lib/ws-server.ts`, and
 * only the module instance the custom server called `setupWebSocket` on holds
 * live sockets — `setupWebSocket`'s own comment says the listener it registers
 * "must be the closure holding *this* bundle's `rooms` map".
 *
 *  - **In production** there is one bundle: `server.ts` starts the custom server
 *    and every route handler shares its module registry, so a producer reached
 *    from a route publishes into the same `rooms` the sockets live in. That is
 *    the topology the first two tests pin, and #2214's acceptance is scoped to
 *    it.
 *  - **Under `next dev`** routes are bundled separately, so a producer reached
 *    from a route bundle can hold a *different* instance of this module, with an
 *    empty `rooms`, and its push is a silent no-op. The pane still catches up on
 *    its next history poll (15 s since #2195). The last test pins that too, so
 *    the limitation is a stated fact with a test behind it rather than a
 *    footnote — and so a future cross-bundle bridge (out of scope here; it needs
 *    its own Issue) has an assertion to flip rather than a comment to find.
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
  vi.resetModules();
});

describe('production topology: one bundle, one `rooms`', () => {
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

describe('`next dev` topology: a second module instance', () => {
  it('publishes into its own empty `rooms`, reaching nobody', async () => {
    // A route bundle's copy of the module. `vi.resetModules()` gives the next
    // import a fresh registry entry, which is the same thing a separate webpack
    // bundle gives a route handler: same source, different module scope, and —
    // crucially — a different `rooms`.
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

    await waitForEnvelopes(1);
    // Known limitation, deliberately pinned: only the server bundle's frame
    // arrives. Closing the gap needs a cross-bundle bridge (or a `globalThis`
    // home for `rooms`) — a change larger than #2214, and its own Issue. When
    // that lands, this expectation becomes 2 and the `id` filter goes away.
    expect(envelopes()).toHaveLength(1);
    expect(envelopes()[0].data.message?.id).toBe('msg-from-server-bundle');
  });
});
