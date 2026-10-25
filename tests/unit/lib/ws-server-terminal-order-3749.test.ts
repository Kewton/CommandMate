/**
 * The old subscription's teardown neither swallows the next subscribe nor
 * speaks after it (Issue #3749).
 *
 * - `handleTerminalSubscribe` awaits `previous.unsubscribe()` before it goes
 *   on; a teardown that rejected used to end the handler there, so the new
 *   subscribe silently never happened.
 * - `handleTerminalUnsubscribe` sends `connected:false` after its teardown
 *   returns; a teardown slow enough for a re-subscribe to finish first used to
 *   deliver that `connected:false` AFTER the new `connected:true`, leaving the
 *   client believing it was disconnected while output kept streaming.
 * - `handleDisconnect` fires the teardown without awaiting it; a rejection
 *   there must not escape as an unhandled rejection.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WebSocket } from 'ws';

const mockGetWorktreeById = vi.fn();
const mockSubscribe = vi.fn();
const mockGetSubscriberCount = vi.fn();
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
    captureSnapshot: vi.fn(async () => ''),
  }),
}));

interface FakeSubscriber {
  cliToolId: string;
  unsubscribe: Mock;
}

/** The registry: every subscriber `subscribe` handed out and not yet released. */
let live: FakeSubscriber[];
/** Every subscriber ever handed out, in order. */
let issued: FakeSubscriber[];

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((done) => (release = done));
  return { promise, release };
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

const CONNECTED_CLAUDE = JSON.stringify({
  type: 'terminal_status',
  connected: true,
  worktreeId: 'wt-1',
  cliToolId: 'claude',
});
const DISCONNECTED = JSON.stringify({ type: 'terminal_status', connected: false });

/** The `terminal_status` frames the socket received, in order. */
function statusFrames(sendMock: Mock): string[] {
  return sendMock.mock.calls
    .map((call) => String(call[0]))
    .filter((frame) => frame.includes('"terminal_status"'));
}

async function loadServer(ws: WebSocket) {
  const { __internal } = await import('@/lib/ws-server');
  __internal.resetStateForTest();
  __internal.registerClientForTest(ws);
  return __internal;
}

describe('ws-server terminal teardown order (Issue #3749)', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    live = [];
    issued = [];
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    mockGetWorktreeById.mockReturnValue({ id: 'wt-1', path: '/nonexistent-3749/wt-1' });
    mockHasSession.mockResolvedValue(true);
    mockGetSessionWorkingDirectory.mockResolvedValue('/nonexistent-3749/wt-1');
    mockGetSubscriberCount.mockImplementation(() => live.length);
    mockSubscribe.mockImplementation(async (sessionName: string) => {
      const subscriber: FakeSubscriber = {
        cliToolId: sessionName.includes('claude') ? 'claude' : 'codex',
        unsubscribe: vi.fn(async () => {
          live = live.filter((s) => s !== subscriber);
        }),
      };
      live.push(subscriber);
      issued.push(subscriber);
      return { unsubscribe: subscriber.unsubscribe };
    });
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  describe("a rejected teardown of the previous subscription", () => {
    it('re-subscribe still registers the new subscription and says connected', async () => {
      const { ws, sendMock } = createMockWebSocket();
      const server = await loadServer(ws);
      await server.handleTerminalSubscribe(ws, subscribeMessage('codex'));
      issued[0].unsubscribe.mockRejectedValueOnce(new Error('control client gone'));
      sendMock.mockClear();

      await server.handleTerminalSubscribe(ws, subscribeMessage('claude'));

      expect(issued[0].unsubscribe).toHaveBeenCalledTimes(1);
      expect(server.getClientInfoForTest(ws)?.terminalSubscription?.cliToolId).toBe('claude');
      expect(live.map((s) => s.cliToolId)).toContain('claude');
      expect(sendMock).toHaveBeenCalledWith(CONNECTED_CLAUDE);
    });

    it('disconnect does not leak the rejection as an unhandled rejection', async () => {
      const { ws } = createMockWebSocket();
      const server = await loadServer(ws);
      // A plain function, not a vi.fn: vitest's mock attaches its own handler
      // to the promise it returns, which would mark the rejection handled.
      let calls = 0;
      mockSubscribe.mockImplementationOnce(async () => ({
        unsubscribe: () => {
          calls += 1;
          return Promise.reject(new Error('control client gone'));
        },
      }));
      await server.handleTerminalSubscribe(ws, subscribeMessage('codex'));

      server.handleDisconnect(ws);
      await flush();
      await flush();

      expect(calls).toBe(1);
      expect(unhandled).toEqual([]);
    });
  });

  describe('a slow teardown on terminal_unsubscribe', () => {
    it('re-subscribe finishing first: no connected:false arrives after its connected:true', async () => {
      const { ws, sendMock } = createMockWebSocket();
      const server = await loadServer(ws);
      await server.handleTerminalSubscribe(ws, subscribeMessage('codex'));
      const gate = deferred();
      issued[0].unsubscribe.mockImplementationOnce(async () => {
        await gate.promise;
        live = live.filter((s) => s !== issued[0]);
      });
      sendMock.mockClear();

      const unsubscribing = server.handleTerminalUnsubscribe(ws);
      await flush();
      await server.handleTerminalSubscribe(ws, subscribeMessage('claude'));
      gate.release();
      await unsubscribing;

      expect(statusFrames(sendMock)).toEqual([CONNECTED_CLAUDE]);
      expect(server.getClientInfoForTest(ws)?.terminalSubscription?.cliToolId).toBe('claude');
      expect(live.map((s) => s.cliToolId)).toEqual(['claude']);
    });

    it('control: with nothing meanwhile, connected:false is still sent once the teardown returns', async () => {
      const { ws, sendMock } = createMockWebSocket();
      const server = await loadServer(ws);
      await server.handleTerminalSubscribe(ws, subscribeMessage('codex'));
      const gate = deferred();
      issued[0].unsubscribe.mockImplementationOnce(async () => {
        await gate.promise;
      });
      sendMock.mockClear();

      const unsubscribing = server.handleTerminalUnsubscribe(ws);
      await flush();
      expect(sendMock).not.toHaveBeenCalled();
      gate.release();
      await unsubscribing;

      expect(statusFrames(sendMock)).toEqual([DISCONNECTED]);
    });

    it('control: a rejected teardown still answers connected:false', async () => {
      const { ws, sendMock } = createMockWebSocket();
      const server = await loadServer(ws);
      await server.handleTerminalSubscribe(ws, subscribeMessage('codex'));
      issued[0].unsubscribe.mockRejectedValueOnce(new Error('control client gone'));
      sendMock.mockClear();

      await server.handleTerminalUnsubscribe(ws);

      expect(statusFrames(sendMock)).toEqual([DISCONNECTED]);
    });
  });
});
