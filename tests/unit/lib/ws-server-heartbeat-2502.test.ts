/**
 * Server-side WebSocket heartbeat (Issue #2502).
 *
 * Before this, `ws-server.ts` contained neither a ping nor an interval. A phone
 * that lost signal, a laptop that slept, a tunnel that was torn down — none of
 * them produce a TCP RST, so the server kept the `ClientInfo`, the room
 * membership and any terminal subscription for that socket indefinitely, and
 * every broadcast was written into a socket nobody was reading.
 *
 * ## Why the liveness half runs against real sockets
 *
 * The recipe's load-bearing claim is that a peer answers a protocol ping
 * *without being asked to* — that is what makes silence evidence about the
 * network rather than about the client's code. A hand-rolled mock cannot show
 * that: it pongs because the test told it to. So the pong path is driven
 * through a real `http.Server` and a real `ws` client, which auto-pongs for the
 * same reason a browser does. The sweep's own branching (terminate vs. ping,
 * room cleanup, the interval) is cheaper to pin down with a stub client, and
 * that is what the second block does.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import {
  WS_HEARTBEAT_MESSAGE_TYPE,
  WS_SERVER_HEARTBEAT_INTERVAL_MS,
} from '@/config/websocket-config';

// Keep ws-server's transitive server-only imports inert (mirrors ws-server-version.test.ts).
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: vi.fn() }) },
}));
vi.mock('@/lib/tmux/tmux-control-mode-flags', () => ({
  isTmuxControlModeEnabled: () => false,
}));
vi.mock('@/lib/tmux/control-mode-tmux-transport', () => ({
  getControlModeTmuxTransport: () => ({
    subscribe: vi.fn(),
    sendInput: vi.fn(),
    resize: vi.fn(),
    getSubscriberCount: vi.fn(() => 0),
    captureSnapshot: vi.fn(),
  }),
}));

import { __internal, closeWebSocket, hasRoomSubscribers, setupWebSocket } from '@/lib/ws-server';

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('ws-server heartbeat over real sockets (#2502)', () => {
  let server: Server;
  let client: WebSocket;
  /** Every text frame the client received. */
  let frames: string[];
  /** Whether the client saw a protocol-level ping. */
  let pinged: boolean;

  const serverSideClients = () => __internal.listClientsForTest();

  beforeEach(async () => {
    server = createServer();
    setupWebSocket(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    frames = [];
    pinged = false;
    client = new WebSocket(`ws://127.0.0.1:${port}`);
    client.on('message', (data) => frames.push(data.toString()));
    client.on('ping', () => {
      pinged = true;
    });
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    await waitFor(() => serverSideClients().length === 1, 'the server to register the client');
  });

  afterEach(async () => {
    client.removeAllListeners();
    if (client.readyState === WebSocket.OPEN) client.terminate();
    closeWebSocket();
    __internal.resetStateForTest();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('pings each client and sends an application beat alongside it', async () => {
    __internal.runHeartbeatSweep();

    await waitFor(() => pinged, 'a protocol ping to reach the client');
    // The protocol ping alone only ever teaches the SERVER something: a browser
    // answers it in the network layer and hands page JavaScript nothing. The
    // extra frame is what the tab's own liveness check can see.
    await waitFor(
      () => frames.some((f) => JSON.parse(f).type === WS_HEARTBEAT_MESSAGE_TYPE),
      'an application-level heartbeat frame',
    );
  });

  it('clears the liveness flag when it pings, and restores it on the pong', async () => {
    // The flag is the whole state machine: cleared by the sweep, set by the
    // peer. A sweep that forgot to clear it could never conclude anything.
    __internal.runHeartbeatSweep();
    expect(serverSideClients()[0].isAlive).toBe(false);

    // Nothing in this test answers the ping — the `ws` client does it by itself,
    // exactly as a browser would.
    await waitFor(() => serverSideClients()[0]?.isAlive === true, 'the automatic pong');
  });

  it('leaves a client that answered alone on the following sweep', async () => {
    __internal.runHeartbeatSweep();
    await waitFor(() => serverSideClients()[0]?.isAlive === true, 'the automatic pong');

    __internal.runHeartbeatSweep();

    expect(serverSideClients()).toHaveLength(1);
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('terminates and forgets a client that answered nothing for a full interval', async () => {
    // Stand in for a half-open path: the ping went out on the previous sweep and
    // no pong came back, which is indistinguishable from the flag never being
    // restored.
    serverSideClients()[0].isAlive = false;

    __internal.runHeartbeatSweep();

    expect(serverSideClients()).toHaveLength(0);
    await waitFor(() => client.readyState === WebSocket.CLOSED, 'the client socket to close');
  });

  it('drops a terminated client out of the rooms it had joined', async () => {
    client.send(JSON.stringify({ type: 'subscribe', worktreeId: 'wt-2502' }));
    await waitFor(() => hasRoomSubscribers('wt-2502'), 'the subscription to land');

    serverSideClients()[0].isAlive = false;
    __internal.runHeartbeatSweep();

    // The leak this closes: a room that still lists a dead socket makes every
    // later broadcast a write into nothing, and keeps `hasRoomSubscribers`
    // answering yes so upstream pollers never stand down.
    expect(hasRoomSubscribers('wt-2502')).toBe(false);
  });
});

describe('ws-server heartbeat scheduling (#2502)', () => {
  /** A stub peer: enough surface for the sweep, and nothing that answers back. */
  function stubClient() {
    const ws = {
      readyState: WebSocket.OPEN,
      ping: vi.fn(),
      send: vi.fn(),
      terminate: vi.fn(),
    };
    return ws as unknown as WebSocket & {
      ping: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    __internal.resetStateForTest();
  });

  afterEach(() => {
    __internal.stopHeartbeat();
    __internal.resetStateForTest();
    vi.useRealTimers();
  });

  it('sweeps on the configured interval once started', () => {
    const ws = stubClient();
    __internal.registerClientForTest(ws);
    __internal.startHeartbeat();

    vi.advanceTimersByTime(WS_SERVER_HEARTBEAT_INTERVAL_MS - 1);
    expect(ws.ping).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(ws.ping).toHaveBeenCalledTimes(1);
  });

  it('terminates on the sweep after the one that went unanswered', () => {
    const ws = stubClient();
    __internal.registerClientForTest(ws);
    __internal.startHeartbeat();

    // First interval: asked. A client is never killed on the sweep that pings
    // it — it has had no chance to answer yet.
    vi.advanceTimersByTime(WS_SERVER_HEARTBEAT_INTERVAL_MS);
    expect(ws.terminate).not.toHaveBeenCalled();

    // Second interval: no pong arrived in between.
    vi.advanceTimersByTime(WS_SERVER_HEARTBEAT_INTERVAL_MS);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(__internal.getClientInfoForTest(ws)).toBeUndefined();
  });

  it('stops sweeping when told to', () => {
    const ws = stubClient();
    __internal.registerClientForTest(ws);
    __internal.startHeartbeat();
    __internal.stopHeartbeat();

    vi.advanceTimersByTime(WS_SERVER_HEARTBEAT_INTERVAL_MS * 5);
    expect(ws.ping).not.toHaveBeenCalled();
  });

  it('replaces the previous sweep rather than stacking a second one', () => {
    // CI shares one process across the suite, and HMR restarts the server in
    // place; two live intervals would halve the effective grace period.
    const ws = stubClient();
    __internal.registerClientForTest(ws);
    __internal.startHeartbeat();
    __internal.startHeartbeat();

    vi.advanceTimersByTime(WS_SERVER_HEARTBEAT_INTERVAL_MS);
    expect(ws.ping).toHaveBeenCalledTimes(1);
  });

  it('skips the application beat for a socket that is not open', () => {
    const ws = stubClient();
    (ws as unknown as { readyState: number }).readyState = WebSocket.CLOSING;
    __internal.registerClientForTest(ws);

    __internal.runHeartbeatSweep();

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('survives a peer whose ping throws', () => {
    const ws = stubClient();
    ws.ping.mockImplementation(() => {
      throw new Error('socket already destroyed');
    });
    const other = stubClient();
    __internal.registerClientForTest(ws);
    __internal.registerClientForTest(other);

    expect(() => __internal.runHeartbeatSweep()).not.toThrow();
    // The sweep is a loop over every connection; one bad socket must not stop
    // the rest from being probed.
    expect(other.ping).toHaveBeenCalledTimes(1);
  });
});
