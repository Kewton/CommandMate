/**
 * Server Readiness Polling
 * Issue #1195: Guided quickstart for `npx commandmate`
 *
 * Polls a TCP endpoint until it accepts a connection or the timeout elapses.
 * Never throws: a timeout is reported as `false` so callers can degrade
 * gracefully (e.g. print the URL anyway) instead of failing the command.
 *
 * @module server-ready
 */

import { connect, Socket } from 'net';

export interface WaitForServerOptions {
  /** Total time to wait before giving up (ms) */
  timeoutMs?: number;
  /** Delay between connection attempts (ms) */
  intervalMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_INTERVAL_MS = 300;

/**
 * Wait until a TCP endpoint accepts a connection.
 *
 * @param host - Host to connect to
 * @param port - Port to connect to
 * @param options - Timeout and polling interval overrides
 * @returns true if the server accepted a connection, false on timeout
 */
export async function waitForServer(
  host: string,
  port: number,
  options: WaitForServerOptions = {}
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const attemptTimeout = Math.max(deadline - Date.now(), 1);

    if (await tryConnect(host, port, attemptTimeout)) {
      return true;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }

    await delay(Math.min(intervalMs, remaining));
  }
}

/**
 * Attempt a single TCP connection.
 *
 * @returns true if the connection was established
 */
function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: Socket;

    try {
      socket = connect({ host, port });
    } catch {
      // Never propagate: an unusable endpoint is just a failed attempt
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (connected: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.destroy();
      } catch {
        // Socket already gone
      }
      resolve(connected);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
