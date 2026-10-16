/**
 * A `terminal_subscribe` that is no longer wanted by the time its awaits
 * return leaves nothing behind (Issue #3733).
 *
 * `handleTerminalSubscribe` awaits the old subscription's teardown, the
 * ownership check and `transport.subscribe` before it registers, and the
 * dispatcher does not wait for it. Each case here holds one of those awaits,
 * does something to the socket meanwhile (disconnect, unsubscribe, another
 * subscribe), then lets it go, and judges by what the transport registry holds
 * and what reached the socket.
 *
 * The registry is a counter the fake transport keeps, so a subscriber that is
 * never released shows up as a count that does not return to where it was —
 * exactly what used to fill the 4-per-session limit until a restart.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WebSocket } from 'ws';

const mockGetWorktreeById = vi.fn();
const mockSubscribe = vi.fn();
const mockGetSubscriberCount = vi.fn();
const mockCaptureSnapshot = vi.fn();
const mockHasSession = vi.fn();
const mockGetSessionWorkingDirectory = vi.fn();

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: (...args: unknown[]) => mockHasSession(...args),
  getSessionWorkingDirectory: (...args: unknown[]) => mockGetSessionWorkingDirectory(...args),
}));
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn(() => ({})),
}));
vi.mock('@/lib/db', () => ({
  getWorktreeById: (...args: unknown[]) => mockGetWorktreeById(...args),
}));
vi.mock('@/lib/tmux/tmux-control-mode-flags', () => ({
  isTmuxControlModeEnabled: () => true,
}));
vi.mock('@/lib/tmux/control-mode-tmux-transport', () => ({
  getControlModeTmuxTransport: () => ({
    subscribe: (...args: unknown[]) => mockSubscribe(...args),
    sendInput: vi.fn(),
    resize: vi.fn(),
    getSubscriberCount: (...args: unknown[]) => mockGetSubscriberCount(...args),
    captureSnapshot: (...args: unknown[]) => mockCaptureSnapshot(...args),
  }),
}));

interface Handlers {
  onOutput: (data: string) => void;
  onExit: (event: { exitCode: number | null }) => void;
  onError: (error: Error) => void;
}

interface FakeSubscriber {
  cliToolId: string;
  handlers: Handlers;
  unsubscribe: Mock;
}

/** The registry: every subscriber `subscribe` handed out and not yet released. */
let live: FakeSubscriber[];
/** Every subscriber ever handed out, in order. */
let issued: FakeSubscriber[];
/** When set, the next `subscribe` waits for it before answering. */
let holdSubscribe: Promise<void> | null;

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((done) => (release = done));
  return { promise, release };
}

/** Hold the next ownership check (its first tmux read) until released. */
function holdOwnership(): () => void {
  const gate = deferred();
  mockHasSession.mockImplementationOnce(async () => {
    await gate.promise;
    return true;
  });
  return gate.release;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function createMockWebSocket(): { ws: WebSocket; sendMock: Mock } {
  const sendMock = vi.fn();
  const ws = { readyState: 1, send: sendMock } as unknown as WebSocket;
  return { ws, sendMock };
}

function subscribeMessage(cliToolId: string) {
  return { type: 'terminal_subscribe' as const, worktreeId: 'wt-1', cliToolId };
}

const CONNECTED_CODEX = JSON.stringify({
  type: 'terminal_status',
  connected: true,
  worktreeId: 'wt-1',
  cliToolId: 'codex',
});
const CONNECTED_CLAUDE = JSON.stringify({
  type: 'terminal_status',
  connected: true,
  worktreeId: 'wt-1',
  cliToolId: 'claude',
});

async function loadServer(ws: WebSocket) {
  const { __internal } = await import('@/lib/ws-server');
  __internal.resetStateForTest();
  __internal.registerClientForTest(ws);
  return __internal;
}

describe('ws-server terminal subscribe lifetime (Issue #3733)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    live = [];
    issued = [];
    holdSubscribe = null;
    mockGetWorktreeById.mockReturnValue({ id: 'wt-1', path: '/nonexistent-3733/wt-1' });
    mockHasSession.mockResolvedValue(true);
    mockGetSessionWorkingDirectory.mockResolvedValue('/nonexistent-3733/wt-1');
    mockGetSubscriberCount.mockImplementation(() => live.length);
    mockCaptureSnapshot.mockResolvedValue('snapshot output');
    mockSubscribe.mockImplementation(async (sessionName: string, handlers: Handlers) => {
      const held = holdSubscribe;
      holdSubscribe = null;
      const subscriber: FakeSubscriber = {
        cliToolId: sessionName.includes('claude') ? 'claude' : 'codex',
        handlers,
        unsubscribe: vi.fn(async () => {
          live = live.filter((s) => s !== subscriber);
        }),
      };
      live.push(subscriber);
      issued.push(subscriber);
      if (held) await held;
      return { unsubscribe: subscriber.unsubscribe };
    });
  });

  describe('disconnect while subscribing', () => {
    it('during the ownership check: nothing is registered and nothing is sent', async () => {
      const { ws, sendMock } = createMockWebSocket();
      const server = await loadServer(ws);
      const release = holdOwnership();

      const pending = server.handleTerminalSubscribe(ws, subscribeMessage('codex'));
      await flush();
      server.handleDisconnect(ws);
      release();
      await pending;

      expect(live).toHaveLength(0);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('during transport.subscribe: the subscriber it got is released and nothing is sent', async () => {
      const { ws, sendMock } = createMockWebSocket();
      const server = await loadServer(ws);
      const gate = deferred();
      holdSubscribe = gate.promise;

      const pending = server.handleTerminalSubscribe(ws, subscribeMessage('codex'));
      await flush();
      expect(live).toHaveLength(1);
      server.handleDisconnect(ws);
      gate.release();
      await pending;

      expect(live).toHaveLength(0);
      expect(issued[0].unsubscribe).toHaveBeenCalledTimes(1);
      issued[0].handlers.onOutput('late output');
      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  describe('terminal_unsubscribe while subscribing', () => {
    it('during the ownership check: not registered, no output follows', async () => {
      const { ws, sendMock } = createMockWebSocket();
      const server = await loadServer(ws);
      const release = holdOwnership();

      const pending = server.handleTerminalSubscribe(ws, subscribeMessage('codex'));
      await flush();
      await server.handleTerminalUnsubscribe(ws);
      release();
      await pending;

      expect(server.getClientInfoForTest(ws)?.terminalSubscription).toBeNull();
      expect(live).toHaveLength(0);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('during transport.subscribe: released, and its output never reaches the socket', async () => {
      const { ws, sendMock } = createMockWebSocket();
      const server = await loadServer(ws);
      const gate = deferred();
      holdSubscribe = gate.promise;

      const pending = server.handleTerminalSubscribe(ws, subscribeMessage('codex'));
      await flush();
      await server.handleTerminalUnsubscribe(ws);
      gate.release();
      await pending;

      expect(server.getClientInfoForTest(ws)?.terminalSubscription).toBeNull();
      expect(live).toHaveLength(0);
      issued[0].handlers.onOutput('late output');
      issued[0].handlers.onExit({ exitCode: 0 });
      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  describe('a second subscribe on the same socket', () => {
    it('A held, B completes, then A returns: A is released and B stays', async () => {
      const { ws, sendMock } = createMockWebSocket();
      const server = await loadServer(ws);
      const releaseA = holdOwnership();

      const pendingA = server.handleTerminalSubscribe(ws, subscribeMessage('codex'));
      await flush();
      await server.handleTerminalSubscribe(ws, subscribeMessage('claude'));
      releaseA();
      await pendingA;

      expect(live.map((s) => s.cliToolId)).toEqual(['claude']);
      expect(server.getClientInfoForTest(ws)?.terminalSubscription?.cliToolId).toBe('claude');
      expect(sendMock).toHaveBeenCalledWith(CONNECTED_CLAUDE);
      expect(sendMock).not.toHaveBeenCalledWith(CONNECTED_CODEX);
    });

    it('A returns first, then B: A is released and B is registered', async () => {
      const { ws, sendMock } = createMockWebSocket();
      const server = await loadServer(ws);
      const gateA = deferred();
      holdSubscribe = gateA.promise;

      const pendingA = server.handleTerminalSubscribe(ws, subscribeMessage('codex'));
      await flush();
      const releaseB = holdOwnership();
      const pendingB = server.handleTerminalSubscribe(ws, subscribeMessage('claude'));
      await flush();
      gateA.release();
      await pendingA;
      expect(issued[0].unsubscribe).toHaveBeenCalledTimes(1);
      expect(server.getClientInfoForTest(ws)?.terminalSubscription).toBeNull();
      releaseB();
      await pendingB;

      expect(live.map((s) => s.cliToolId)).toEqual(['claude']);
      expect(server.getClientInfoForTest(ws)?.terminalSubscription?.cliToolId).toBe('claude');
      expect(sendMock).toHaveBeenCalledWith(CONNECTED_CLAUDE);
      expect(sendMock).not.toHaveBeenCalledWith(CONNECTED_CODEX);
    });
  });

  describe("the old subscription's onError fallback", () => {
    it('after an unsubscribe: neither the snapshot nor the error is sent', async () => {
      const { ws, sendMock } = createMockWebSocket();
      const server = await loadServer(ws);
      await server.handleTerminalSubscribe(ws, subscribeMessage('codex'));
      await server.handleTerminalUnsubscribe(ws);
      sendMock.mockClear();

      issued[0].handlers.onError(new Error('parser failed'));
      await flush();

      expect(sendMock).not.toHaveBeenCalled();
    });

    it('after a re-subscribe: the old fallback says nothing; the new one still works', async () => {
      const { ws, sendMock } = createMockWebSocket();
      const server = await loadServer(ws);
      await server.handleTerminalSubscribe(ws, subscribeMessage('codex'));
      await server.handleTerminalSubscribe(ws, subscribeMessage('claude'));
      sendMock.mockClear();

      issued[0].handlers.onError(new Error('old parser failed'));
      await flush();
      expect(sendMock).not.toHaveBeenCalled();

      issued[1].handlers.onError(new Error('new parser failed'));
      await flush();
      expect(sendMock).toHaveBeenCalledWith(JSON.stringify({
        type: 'terminal_error',
        error: 'new parser failed',
        fallback: true,
      }));
    });

    it('when the unsubscribe lands while the fallback is reading the pane', async () => {
      const { ws, sendMock } = createMockWebSocket();
      const server = await loadServer(ws);
      await server.handleTerminalSubscribe(ws, subscribeMessage('codex'));
      const gate = deferred();
      mockCaptureSnapshot.mockImplementationOnce(async () => {
        await gate.promise;
        return 'snapshot output';
      });
      sendMock.mockClear();

      issued[0].handlers.onError(new Error('parser failed'));
      await flush();
      await server.handleTerminalUnsubscribe(ws);
      sendMock.mockClear();
      gate.release();
      await flush();

      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  describe('controls: nothing happens meanwhile', () => {
    it('a held ownership check that simply finishes still registers and says connected', async () => {
      const { ws, sendMock } = createMockWebSocket();
      const server = await loadServer(ws);
      const release = holdOwnership();

      const pending = server.handleTerminalSubscribe(ws, subscribeMessage('codex'));
      await flush();
      release();
      await pending;

      expect(live).toHaveLength(1);
      expect(server.getClientInfoForTest(ws)?.terminalSubscription?.cliToolId).toBe('codex');
      expect(sendMock).toHaveBeenCalledWith(CONNECTED_CODEX);
      issued[0].handlers.onOutput('hello');
      expect(sendMock).toHaveBeenLastCalledWith(JSON.stringify({ type: 'terminal_output', data: 'hello' }));
    });

    it('the subscriber limit still refuses the fifth subscriber', async () => {
      const sockets = Array.from({ length: 5 }, () => createMockWebSocket());
      const { __internal: server } = await import('@/lib/ws-server');
      server.resetStateForTest();
      for (const { ws } of sockets) server.registerClientForTest(ws);

      for (const { ws } of sockets) {
        await server.handleTerminalSubscribe(ws, subscribeMessage('codex'));
      }

      expect(live).toHaveLength(4);
      expect(sockets[4].sendMock).toHaveBeenCalledWith(JSON.stringify({
        type: 'terminal_error',
        error: 'Terminal subscriber limit reached',
      }));
    });
  });
});
