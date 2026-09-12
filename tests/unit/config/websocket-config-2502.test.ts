/**
 * The heartbeat constants are a protocol, not a bag of numbers (Issue #2502).
 *
 * Server and client each read half of this file, and the halves only work
 * together at particular ratios: the client's patience has to cover more than
 * one server beat, and it has to be measured often enough that "disconnected"
 * arrives while the user is still looking at the screen. A future tweak to any
 * single value can satisfy its own side and silently break the pair, which is
 * what these relations exist to catch — a plain `toBe(30000)` per constant
 * would not.
 */
import { describe, expect, it } from 'vitest';
import {
  WS_CLIENT_LIVENESS_CHECK_INTERVAL_MS,
  WS_CLIENT_LIVENESS_TIMEOUT_MS,
  WS_HALF_OPEN_CLOSE_CODE,
  WS_HEARTBEAT_MESSAGE_TYPE,
  WS_RECONNECT_BASE_DELAY_MS,
  WS_RECONNECT_JITTER_RATIO,
  WS_RECONNECT_MAX_DELAY_MS,
  WS_SERVER_HEARTBEAT_INTERVAL_MS,
} from '@/config/websocket-config';

describe('websocket heartbeat constants (#2502)', () => {
  it('gives the client enough patience to absorb a lost beat', () => {
    // Strictly more than two beats: at exactly 2x, a beat that is merely late
    // (a GC pause, a backgrounded tab, a slow tunnel) tears down a live socket.
    expect(WS_CLIENT_LIVENESS_TIMEOUT_MS).toBeGreaterThan(WS_SERVER_HEARTBEAT_INTERVAL_MS * 2);
  });

  it('measures that silence several times inside the timeout', () => {
    // The check interval is also the detection lag: a half-open socket is found
    // somewhere between the timeout and the timeout plus one interval.
    expect(WS_CLIENT_LIVENESS_CHECK_INTERVAL_MS).toBeLessThan(WS_CLIENT_LIVENESS_TIMEOUT_MS / 4);
    expect(WS_CLIENT_LIVENESS_CHECK_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('keeps the server beat short enough for proxy idle timeouts', () => {
    // Cloudflare Quick Tunnel / Tailscale Serve cut idle upgrades around 100s;
    // the beat is what keeps a quiet socket from looking idle to them at all.
    expect(WS_SERVER_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(60_000);
    expect(WS_SERVER_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('jitters the backoff without inverting or erasing it', () => {
    expect(WS_RECONNECT_JITTER_RATIO).toBeGreaterThan(0);
    // At >= 1 the low end of the window reaches 0 and the backoff stops backing
    // off — the herd it exists to spread would hammer the server instead.
    expect(WS_RECONNECT_JITTER_RATIO).toBeLessThan(1);
  });

  it('keeps the backoff window ordered', () => {
    expect(WS_RECONNECT_BASE_DELAY_MS).toBeGreaterThan(0);
    expect(WS_RECONNECT_MAX_DELAY_MS).toBeGreaterThan(WS_RECONNECT_BASE_DELAY_MS);
  });

  it('uses a close code browsers will actually accept', () => {
    // 1000 and 3000-4999 are the only codes `close()` takes from page script;
    // anything else throws InvalidAccessError and the socket is never released.
    expect(WS_HALF_OPEN_CLOSE_CODE).toBeGreaterThanOrEqual(4000);
    expect(WS_HALF_OPEN_CLOSE_CODE).toBeLessThanOrEqual(4999);
  });

  it('names the beat with a type the client can match on', () => {
    expect(WS_HEARTBEAT_MESSAGE_TYPE).toBe('heartbeat');
  });
});
