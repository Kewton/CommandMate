/**
 * Tests for the two evidence-only connectivity reads (Issue #2503).
 *
 * #2501 established that `navigator.onLine === true` is never proof of a
 * connection. #2503 acts on "we are back" by putting a message on the wire, so
 * it needs the half of the verdict that is actual evidence — a live socket or a
 * completed exchange — rather than `status`, which blurs "the server answered"
 * together with "the socket is still opening".
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  isServerConfirmedReachable,
  isConnectionKnownDown,
  resolveConnectivityStatus,
  type ConnectivitySignals,
} from '@/hooks/useConnectivity';

const signals = (over: Partial<ConnectivitySignals> = {}): ConnectivitySignals => ({
  browserOnline: true,
  realtimeStatus: 'disconnected',
  serverReachable: null,
  ...over,
});

describe('isServerConfirmedReachable', () => {
  it('accepts a live WebSocket', () => {
    expect(isServerConfirmedReachable(signals({ realtimeStatus: 'connected' }))).toBe(true);
  });

  it('accepts a completed HTTP exchange even with live push down', () => {
    expect(
      isServerConfirmedReachable(
        signals({ realtimeStatus: 'disconnected', serverReachable: true })
      )
    ).toBe(true);
  });

  it('never accepts navigator.onLine on its own', () => {
    // The captive portal: associated, believed online, nothing gets through.
    expect(
      isServerConfirmedReachable(
        signals({ browserOnline: true, realtimeStatus: 'connecting', serverReachable: null })
      )
    ).toBe(false);
  });

  it('rejects a measured-unreachable server', () => {
    expect(isServerConfirmedReachable(signals({ serverReachable: false }))).toBe(false);
  });

  it('rejects an unmeasured connection, whatever the socket is doing', () => {
    for (const realtimeStatus of ['connecting', 'disconnected', 'error'] as const) {
      expect(isServerConfirmedReachable(signals({ realtimeStatus })), realtimeStatus).toBe(
        false
      );
    }
  });

  it('is stricter than the "reconnecting" verdict it overlaps with', () => {
    // Both of these resolve to `reconnecting`, and only one of them is evidence.
    const answered = signals({ realtimeStatus: 'disconnected', serverReachable: true });
    const merelyOpening = signals({ realtimeStatus: 'connecting', serverReachable: null });

    expect(resolveConnectivityStatus(answered)).toBe('reconnecting');
    expect(resolveConnectivityStatus(merelyOpening)).toBe('reconnecting');
    expect(isServerConfirmedReachable(answered)).toBe(true);
    expect(isServerConfirmedReachable(merelyOpening)).toBe(false);
  });

  it('reads the socket even when a stale probe says unreachable', () => {
    // Matches resolveConnectivityStatus, which lets a live socket outrank a
    // stale `serverReachable: false`.
    const stale = signals({ realtimeStatus: 'connected', serverReachable: false });
    expect(resolveConnectivityStatus(stale)).toBe('online');
    expect(isServerConfirmedReachable(stale)).toBe(true);
  });
});

describe('isConnectionKnownDown', () => {
  it('trusts a device that says it is off the network', () => {
    expect(isConnectionKnownDown(signals({ browserOnline: false }))).toBe(true);
  });

  it('trusts an exchange that came back unreachable', () => {
    expect(isConnectionKnownDown(signals({ serverReachable: false }))).toBe(true);
  });

  it('does not call an unmeasured connection down', () => {
    // A closed socket with nothing measured is what a page can sit in without
    // anything having touched the network. #2503 withholds a failure on this
    // verdict, so guessing here would hide a genuine send failure behind a
    // spinner that never resolves.
    for (const realtimeStatus of ['connecting', 'disconnected', 'error'] as const) {
      expect(isConnectionKnownDown(signals({ realtimeStatus })), realtimeStatus).toBe(false);
    }
  });

  it('is stricter than the "offline" verdict it overlaps with', () => {
    const unmeasured = signals({ realtimeStatus: 'disconnected', serverReachable: null });
    expect(resolveConnectivityStatus(unmeasured)).toBe('offline');
    expect(isConnectionKnownDown(unmeasured)).toBe(false);
  });

  it('never overlaps with confirmed reachability', () => {
    const cases: ConnectivitySignals[] = [
      signals({ realtimeStatus: 'connected' }),
      signals({ serverReachable: true }),
      signals({ browserOnline: false }),
      signals({ serverReachable: false }),
      signals({ realtimeStatus: 'connecting' }),
    ];
    for (const c of cases) {
      expect(isServerConfirmedReachable(c) && isConnectionKnownDown(c)).toBe(false);
    }
  });
});
