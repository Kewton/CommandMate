/**
 * Server Readiness Tests
 * Issue #1195: Guided quickstart for `npx commandmate`
 *
 * `net` is mocked and fake timers are used: no real sockets, no real waiting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import { waitForServer } from '../../../../src/cli/utils/server-ready';

vi.mock('net');

type SocketEvent = 'connect' | 'error' | 'timeout';

interface MockSocket {
  once: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  emit: (event: SocketEvent) => void;
}

function createMockSocket(options: { destroyThrows?: boolean } = {}): MockSocket {
  const handlers = new Map<string, () => void>();
  const socket: MockSocket = {
    once: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler);
      return socket;
    }),
    setTimeout: vi.fn(() => socket),
    destroy: vi.fn(() => {
      if (options.destroyThrows) {
        throw new Error('socket already destroyed');
      }
      return socket;
    }),
    emit: (event: SocketEvent) => handlers.get(event)?.(),
  };
  return socket;
}

/**
 * Mock `net.connect` so that the Nth connection emits behaviors[N-1].
 * The last entry repeats for any further attempts.
 */
function mockConnectSequence(behaviors: SocketEvent[]): MockSocket[] {
  const sockets: MockSocket[] = [];

  vi.mocked(net.connect).mockImplementation(((): net.Socket => {
    const socket = createMockSocket();
    sockets.push(socket);
    const behavior = behaviors[sockets.length - 1] ?? behaviors[behaviors.length - 1];
    // Emit after the caller registered its listeners (microtask, never faked)
    void Promise.resolve().then(() => socket.emit(behavior));
    return socket as unknown as net.Socket;
  }) as unknown as typeof net.connect);

  return sockets;
}

describe('waitForServer', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should return true when the connection succeeds immediately', async () => {
    mockConnectSequence(['connect']);

    const result = await waitForServer('127.0.0.1', 3000, { timeoutMs: 1000, intervalMs: 300 });

    expect(result).toBe(true);
    expect(net.connect).toHaveBeenCalledTimes(1);
  });

  it('should connect to the given host and port', async () => {
    mockConnectSequence(['connect']);

    await waitForServer('192.168.1.5', 3100, { timeoutMs: 1000, intervalMs: 300 });

    expect(net.connect).toHaveBeenCalledWith(expect.objectContaining({ host: '192.168.1.5', port: 3100 }));
  });

  it('should return false when every attempt fails until the timeout', async () => {
    mockConnectSequence(['error']);

    const promise = waitForServer('127.0.0.1', 3000, { timeoutMs: 1000, intervalMs: 300 });
    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).resolves.toBe(false);
    expect(vi.mocked(net.connect).mock.calls.length).toBeGreaterThan(1);
  });

  it('should return true when a later attempt succeeds', async () => {
    mockConnectSequence(['error', 'error', 'connect']);

    const promise = waitForServer('127.0.0.1', 3000, { timeoutMs: 5000, intervalMs: 300 });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBe(true);
    expect(net.connect).toHaveBeenCalledTimes(3);
  });

  it('should treat a socket timeout event as a failed attempt', async () => {
    mockConnectSequence(['timeout', 'connect']);

    const promise = waitForServer('127.0.0.1', 3000, { timeoutMs: 5000, intervalMs: 300 });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBe(true);
    expect(net.connect).toHaveBeenCalledTimes(2);
  });

  it('should not throw when the timeout is reached', async () => {
    mockConnectSequence(['error']);

    const promise = waitForServer('127.0.0.1', 3000, { timeoutMs: 500, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(1000);

    const settled = await promise.then(
      (value) => ({ state: 'resolved', value }),
      () => ({ state: 'rejected', value: undefined })
    );

    expect(settled).toEqual({ state: 'resolved', value: false });
  });

  it('should not throw when net.connect throws synchronously', async () => {
    vi.mocked(net.connect).mockImplementation((() => {
      throw new Error('EACCES');
    }) as unknown as typeof net.connect);

    const promise = waitForServer('127.0.0.1', 3000, { timeoutMs: 300, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBe(false);
  });

  it('should settle once when the socket emits error after connect', async () => {
    const sockets: MockSocket[] = [];
    vi.mocked(net.connect).mockImplementation(((): net.Socket => {
      const socket = createMockSocket();
      sockets.push(socket);
      void Promise.resolve().then(() => {
        socket.emit('connect');
        socket.emit('error');
      });
      return socket as unknown as net.Socket;
    }) as unknown as typeof net.connect);

    const result = await waitForServer('127.0.0.1', 3000, { timeoutMs: 1000, intervalMs: 300 });

    expect(result).toBe(true);
    expect(sockets[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('should not throw when destroying the socket fails', async () => {
    vi.mocked(net.connect).mockImplementation(((): net.Socket => {
      const socket = createMockSocket({ destroyThrows: true });
      void Promise.resolve().then(() => socket.emit('connect'));
      return socket as unknown as net.Socket;
    }) as unknown as typeof net.connect);

    await expect(
      waitForServer('127.0.0.1', 3000, { timeoutMs: 1000, intervalMs: 300 })
    ).resolves.toBe(true);
  });

  it('should destroy every socket it opens', async () => {
    const sockets = mockConnectSequence(['error', 'error', 'connect']);

    const promise = waitForServer('127.0.0.1', 3000, { timeoutMs: 5000, intervalMs: 300 });
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(sockets).toHaveLength(3);
    for (const socket of sockets) {
      expect(socket.destroy).toHaveBeenCalled();
    }
  });

  it('should bound each attempt with a socket timeout', async () => {
    const sockets = mockConnectSequence(['connect']);

    await waitForServer('127.0.0.1', 3000, { timeoutMs: 1000, intervalMs: 300 });

    expect(sockets[0].setTimeout).toHaveBeenCalledWith(expect.any(Number));
  });

  it('should not exceed the timeout budget', async () => {
    mockConnectSequence(['error']);

    const promise = waitForServer('127.0.0.1', 3000, { timeoutMs: 1000, intervalMs: 300 });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBe(false);
  });

  it('should use default timeout and interval when options are omitted', async () => {
    mockConnectSequence(['connect']);

    const result = await waitForServer('127.0.0.1', 3000);

    expect(result).toBe(true);
  });

  it('should keep polling for the default 30s timeout when options are omitted', async () => {
    mockConnectSequence(['error']);

    const promise = waitForServer('127.0.0.1', 3000);
    await vi.advanceTimersByTimeAsync(29000);

    // Still polling before the 30s default deadline
    expect(vi.mocked(net.connect).mock.calls.length).toBeGreaterThan(1);

    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBe(false);
  });
});
