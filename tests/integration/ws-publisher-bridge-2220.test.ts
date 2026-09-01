/**
 * The publisher bridge, against a real socket (Issue #2220).
 *
 * ## What was broken
 *
 * `ws-server` keeps `wss`, `clients` and `rooms` in module scope, and only the
 * instance the custom server called `setupWebSocket()` on ever holds a socket.
 * A production build gives route handlers a *second* copy of that module —
 * `dist/server/server.js` requires `./src/lib/ws-server`, while every
 * `.next/server/app/api/**\/route.js` reaches `.next/server/chunks/<n>.js`,
 * where `setupWebSocket` is exported and never called. Everything published from
 * a route handler therefore went into a map that stayed empty for the life of
 * the process, and returned in silence. #2214 recorded that as a `next dev`
 * limitation; it was production.
 *
 * ## What this file proves
 *
 * A second module instance — `vi.resetModules()`, which gives the next `import`
 * a fresh module scope exactly as a separate chunk does — publishing into the
 * *owner's* real `WebSocketServer`, over a real socket, for all four bridged
 * capabilities:
 *
 * | capability          | why it has to cross                                        |
 * |---------------------|------------------------------------------------------------|
 * | `broadcast`         | every history row, status change and prompt answer          |
 * | `hasRoomSubscribers`| `terminal-broadcast` and `emitChatTurnProgress` return early on it, so bridging only `broadcast` fixes neither |
 * | `cleanupRooms`      | `/repositories` DELETE runs in a route bundle               |
 * | `migrateWorktreeRooms` | so does a rename                                         |
 *
 * plus the ownership rule (a superseded instance's `closeWebSocket()` must not
 * unseat the live publisher), single delivery, and the terminal snapshot's
 * version sequence — which only became a hazard *because* the bridge works: two
 * instances each counting from 1 would have the client's stale-frame guard drop
 * the newer frame.
 *
 * ## What it does not prove
 *
 * That a webpack chunk boundary behaves like `vi.resetModules()`. Nothing
 * runnable in Vitest can; a real custom server plus a real HTTP route needs a
 * tmux session and is not something to hang CI on. The direct evidence for the
 * production topology is the build artifact, recorded in
 * `dev-reports/decision/issue-2220.md`: both `dist/server/src/lib/ws-server.js`
 * and the `.next/server/chunks` copy reach the same `globalThis` key.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as HTTPServer } from 'http';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setupWebSocket, closeWebSocket, broadcast, hasRoomSubscribers } from '@/lib/ws-server';
import { __resetRoomPublisherRegistryForTest } from '@/lib/realtime/publisher-registry';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  observeWaitingEdge,
} from '@/lib/session/waiting-episode-state';
import type { CurrentOutputPayload } from '@/lib/session/current-output-builder';
import type { Worktree } from '@/types/models';

/**
 * The one payload builder too expensive for an integration test: it shells to tmux.
 *
 * Deliberately partial. `emitTerminalSnapshot` reads exactly the fields below
 * (`fullOutput`, `isRunning`, `thinking`, `isPromptWaiting`, `promptData` and
 * the three activity flags) and copies nothing else onto the wire, so filling in
 * the twenty-odd fields the detector populates would add no coverage and one
 * more thing to drift.
 */
const TERMINAL_PAYLOAD: Partial<CurrentOutputPayload> = {
  isRunning: true,
  cliToolId: 'claude',
  sessionStatus: 'running',
  sessionStatusReason: 'thinking_indicator',
  content: '',
  fullOutput: 'terminal out',
  thinking: true,
  isPromptWaiting: false,
  promptData: null,
  isSelectionListActive: false,
  isPagerActive: false,
  isUnclassifiedActive: false,
  lineCount: 1,
};

let db: Database.Database;
vi.mock('@/lib/db/db-instance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/db-instance')>()),
  getDbInstance: () => db,
}));

/**
 * Everything in this module stays real — `emitChatTurnProgress`, the throttle,
 * the version bookkeeping — except the tmux capture behind `buildCurrentOutput`.
 * Spreading the original matters: a bare factory would silently drop the other
 * exports and the failure would surface as an unrelated `undefined is not a
 * function` somewhere downstream.
 */
vi.mock('@/lib/session/current-output-builder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/current-output-builder')>();
  return {
    ...actual,
    buildCurrentOutput: vi.fn(async () => TERMINAL_PAYLOAD as CurrentOutputPayload),
  };
});

const WORKTREE_ID = 'wt-2220-bridge';
const RENAMED_ID = 'wt-2220-bridge-renamed';

let httpServer: HTTPServer;
let client: WebSocket;
let received: Array<Record<string, unknown>>;

interface Envelope {
  type: string;
  worktreeId: string;
  data: Record<string, unknown> & { type?: string };
}

function envelopes(): Envelope[] {
  return received.filter((m) => m.type === 'broadcast') as unknown as Envelope[];
}

/** Frames the server sends outside the `broadcast` envelope (terminal channel). */
function directFrames(type: string): Array<Record<string, unknown>> {
  return received.filter((m) => m.type === type);
}

async function waitForEnvelopes(count: number, timeoutMs = 2_000): Promise<void> {
  await vi.waitFor(() => expect(envelopes().length).toBeGreaterThanOrEqual(count), {
    timeout: timeoutMs,
    interval: 20,
  });
}

/** Give the event loop enough turns for a frame that should NOT arrive to arrive. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 120));
}

function seedWorktree(id: string): void {
  const worktree: Worktree = {
    id,
    name: 'Bridge probe',
    path: `/test/${id}`,
    repositoryPath: '/test/repo',
    repositoryName: 'TestRepo',
    cliToolId: 'claude',
  };
  upsertWorktree(db, worktree);
}

async function listen(server: HTTPServer): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address();
  return `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

/** Connect, subscribe to `worktreeId`, and start recording every frame. */
async function connect(
  url: string,
  worktreeId: string,
): Promise<{ socket: WebSocket; frames: Array<Record<string, unknown>> }> {
  const frames: Array<Record<string, unknown>> = [];
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  socket.on('message', (data) => {
    frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  socket.send(JSON.stringify({ type: 'subscribe', worktreeId }));
  await settle();
  return { socket, frames };
}

/**
 * A second module instance of the realtime modules — the route-handler side.
 *
 * `vi.resetModules()` clears the module registry, so the imports below build a
 * fresh module scope: a new `rooms`, a new `clients`, a new `localRoomPublisher`.
 * What it does NOT clear is `globalThis`, which is the whole point — the
 * registry the owner wrote to is still there.
 */
async function routeBundle() {
  vi.resetModules();
  const wsServer = await import('@/lib/ws-server');
  const terminalBroadcast = await import('@/lib/realtime/terminal-broadcast');
  const currentOutputBuilder = await import('@/lib/session/current-output-builder');
  const registry = await import('@/lib/realtime/publisher-registry');
  // Guard against the whole file passing for the wrong reason: if the reset
  // stopped working, every "reached across instances" assertion below would be
  // a same-instance publish.
  expect(wsServer.broadcast).not.toBe(broadcast);
  return { wsServer, terminalBroadcast, currentOutputBuilder, registry };
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  seedWorktree(WORKTREE_ID);
  seedWorktree(RENAMED_ID);

  __resetRoomPublisherRegistryForTest();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();

  const owner = await import('@/lib/realtime/terminal-broadcast');
  owner.__resetTerminalBroadcastState();
  const builder = await import('@/lib/session/current-output-builder');
  builder.resetChatTurnProgressState();

  httpServer = createServer();
  setupWebSocket(httpServer);
  const url = await listen(httpServer);

  const connection = await connect(url, WORKTREE_ID);
  client = connection.socket;
  received = connection.frames;
});

afterEach(async () => {
  client.close();
  closeWebSocket();
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
  db.close();
  __resetRoomPublisherRegistryForTest();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  vi.resetModules();
});

describe('publish across module instances', () => {
  it('carries a second instance’s `broadcast` to the owner’s socket, once', async () => {
    const route = await routeBundle();

    route.wsServer.broadcast(WORKTREE_ID, { type: 'message', message: { id: 'from-route' } });

    await waitForEnvelopes(1);
    await settle();
    expect(envelopes()).toHaveLength(1);
    expect(envelopes()[0].data.message).toEqual({ id: 'from-route' });
  });

  it('does not deliver to a room the client never joined', async () => {
    // The negative control for every assertion above: the bridge must carry the
    // frame to the owner's *rooms*, not past them to every open socket.
    const route = await routeBundle();

    route.wsServer.broadcast('wt-nobody-subscribed', { type: 'message' });

    await settle();
    expect(envelopes()).toHaveLength(0);
  });
});

describe('subscriber counts across module instances', () => {
  it('answers for the owner’s rooms, not the caller’s empty one', async () => {
    const route = await routeBundle();

    expect(route.wsServer.hasRoomSubscribers(WORKTREE_ID)).toBe(true);
    expect(route.wsServer.hasRoomSubscribers('wt-nobody-subscribed')).toBe(false);
  });

  it('lets a second instance push a terminal_snapshot, continuing the owner’s version sequence', async () => {
    // The owner takes version 1.
    const owner = await import('@/lib/realtime/terminal-broadcast');
    await owner.broadcastTerminalSnapshot(WORKTREE_ID, 'claude', 'claude');
    await waitForEnvelopes(1);
    expect(envelopes()[0].data.version).toBe(1);

    // The route bundle's copy must clear `hasRoomSubscribers` — before #2220 it
    // returned false here and this second frame never existed — and must not
    // restart the counter, or the client's stale guard drops it.
    const route = await routeBundle();
    await route.terminalBroadcast.broadcastTerminalSnapshot(WORKTREE_ID, 'claude', 'claude');

    await waitForEnvelopes(2);
    expect(envelopes()[1].data.type).toBe('terminal_snapshot');
    expect(envelopes()[1].data.version).toBe(2);
  });

  it('lets a second instance push a chat_turn_progress frame', async () => {
    const route = await routeBundle();

    const published = await route.currentOutputBuilder.emitChatTurnProgress(
      { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude' },
      () => ({ turnKey: 'turn-2220', body: 'half an answer' }),
      1_760_000_000_000,
    );

    expect(published).toBe(true);
    await waitForEnvelopes(1);
    expect(envelopes()[0].data.type).toBe('chat_turn_progress');
    expect(envelopes()[0].data.body).toBe('half an answer');
  });
});

describe('room lifecycle across module instances', () => {
  it('lets a second instance clean up the owner’s room', async () => {
    const route = await routeBundle();

    route.wsServer.cleanupRooms([WORKTREE_ID]);

    expect(hasRoomSubscribers(WORKTREE_ID)).toBe(false);
    broadcast(WORKTREE_ID, { type: 'message', message: { id: 'after-cleanup' } });
    await settle();
    expect(envelopes()).toHaveLength(0);
  });

  it('lets a second instance migrate the owner’s room onto a renamed ID', async () => {
    const route = await routeBundle();

    const moved = route.wsServer.migrateWorktreeRooms([
      { oldId: WORKTREE_ID, newId: RENAMED_ID },
    ]);

    expect(moved).toEqual([{ oldId: WORKTREE_ID, newId: RENAMED_ID, subscribers: 1 }]);
    // The subscriber was told, so a browser holding the old ID can re-point.
    await vi.waitFor(() => expect(directFrames('worktree_renamed')).toHaveLength(1));

    // And the room really moved: the new ID reaches it, the old one does not.
    broadcast(RENAMED_ID, { type: 'message', message: { id: 'after-rename' } });
    await waitForEnvelopes(1);
    expect(envelopes()[0].worktreeId).toBe(RENAMED_ID);

    broadcast(WORKTREE_ID, { type: 'message', message: { id: 'to-the-old-id' } });
    await settle();
    expect(envelopes()).toHaveLength(1);
  });
});

describe('ownership when a second server takes over', () => {
  it('keeps the newer publisher when the superseded instance closes', async () => {
    // Instance 2 stands up its own server and claims the registry — the shape a
    // reload leaves behind.
    const route = await routeBundle();
    const secondServer = createServer();
    route.wsServer.setupWebSocket(secondServer);
    const secondUrl = await listen(secondServer);
    const second = await connect(secondUrl, WORKTREE_ID);

    // The superseded instance shuts down. Its own sockets go with it — that is
    // correct — but it must not take the registry entry it no longer owns.
    closeWebSocket();

    const third = await routeBundle();
    third.wsServer.broadcast(WORKTREE_ID, { type: 'message', message: { id: 'after-handover' } });

    await vi.waitFor(() =>
      expect(second.frames.filter((f) => f.type === 'broadcast')).toHaveLength(1),
    );
    expect(second.frames.filter((f) => f.type === 'broadcast')[0]).toMatchObject({
      worktreeId: WORKTREE_ID,
      data: { message: { id: 'after-handover' } },
    });

    second.socket.close();
    route.wsServer.closeWebSocket();
    await new Promise<void>((resolve, reject) => {
      secondServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('delivers the waiting edge exactly once after a handover', async () => {
    // #1788 registers its subscription in a single `globalThis` slot, so a
    // second `setupWebSocket` replaces rather than adds. If either half of that
    // regressed — a second listener, or a superseded `closeWebSocket` tearing
    // down the live one — this count would be 2 or 0 rather than 1.
    const route = await routeBundle();
    const secondServer = createServer();
    route.wsServer.setupWebSocket(secondServer);
    const secondUrl = await listen(secondServer);
    const second = await connect(secondUrl, WORKTREE_ID);

    closeWebSocket();

    observeWaitingEdge({
      worktreeId: WORKTREE_ID,
      cliToolId: 'claude',
      waiting: true,
      kind: 'prompt',
      now: 1_760_000_000_000,
    });

    await settle();
    const statusFrames = second.frames
      .filter((f) => f.type === 'broadcast')
      .filter((f) => (f.data as { type?: string }).type === 'session_status_changed');
    expect(statusFrames).toHaveLength(1);

    second.socket.close();
    route.wsServer.closeWebSocket();
    await new Promise<void>((resolve, reject) => {
      secondServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('stops routing once the owner withdraws, and says so', async () => {
    const route = await routeBundle();
    // The owner leaves without a successor: `closeWebSocket` withdraws with the
    // token it holds, which is still the current generation.
    closeWebSocket();

    expect(route.registry.getRoomPublisher()).toBeNull();

    route.wsServer.broadcast(WORKTREE_ID, { type: 'message', message: { id: 'into-the-void' } });

    await settle();
    expect(envelopes()).toHaveLength(0);
    // Silence with a counter behind it: the browser still reports its socket as
    // `connected` in this state, so the log line is the only symptom there is.
    const stats = route.registry.getUnroutedPublishStats();
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.operations.broadcast).toBeGreaterThanOrEqual(1);
  });
});
