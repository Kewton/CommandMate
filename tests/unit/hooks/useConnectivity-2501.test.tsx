/**
 * @vitest-environment jsdom
 */

/**
 * Tests for useConnectivity (Issue #2501).
 *
 * The property under test throughout is the asymmetry: `navigator.onLine` can
 * confirm "offline" but never "online", so every online verdict has to be
 * backed by something the server actually answered.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const realtime = vi.hoisted(() => ({
  status: 'disconnected' as 'connecting' | 'connected' | 'disconnected' | 'error',
}));

vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: () => ({
    status: realtime.status,
    connected: realtime.status === 'connected',
    subscribe: () => {},
    unsubscribe: () => {},
    addListener: () => () => {},
  }),
}));

import {
  useConnectivity,
  resolveConnectivityStatus,
  probeServerReachable,
  reportServerReachability,
  DEFAULT_PROBE_URL,
  DEFAULT_SURFACE_DELAY_MS,
  type ConnectivitySignals,
} from '@/hooks/useConnectivity';

/** Replace navigator.onLine, which jsdom exposes as a non-writable getter. */
function setBrowserOnline(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

/** A fetch stub that always answers — i.e. the server is reachable. */
function answeringFetch() {
  return vi.fn(async () => new Response('{}', { status: 200 }));
}

/** A fetch stub that fails at the transport layer — server unreachable. */
function failingFetch() {
  return vi.fn(async () => {
    throw new TypeError('Failed to fetch');
  });
}

const signals = (over: Partial<ConnectivitySignals> = {}): ConnectivitySignals => ({
  browserOnline: true,
  realtimeStatus: 'connected',
  serverReachable: null,
  ...over,
});

describe('resolveConnectivityStatus', () => {
  it('trusts navigator.onLine === false as proof of being offline', () => {
    expect(
      resolveConnectivityStatus(
        signals({ browserOnline: false, realtimeStatus: 'connected', serverReachable: true })
      )
    ).toBe('offline');
  });

  it('treats a live WebSocket as proof the server answered', () => {
    expect(resolveConnectivityStatus(signals({ realtimeStatus: 'connected' }))).toBe('online');
  });

  it('never reports online from navigator.onLine alone when the server is unreachable', () => {
    // The captive-portal case: the device is happily associated, and nothing
    // it sends reaches the server.
    expect(
      resolveConnectivityStatus(
        signals({ browserOnline: true, realtimeStatus: 'connecting', serverReachable: false })
      )
    ).toBe('offline');
  });

  it('reports reconnecting when the server answers but live push is down', () => {
    expect(
      resolveConnectivityStatus(
        signals({ realtimeStatus: 'disconnected', serverReachable: true })
      )
    ).toBe('reconnecting');
  });

  it('falls back to the realtime status while reachability is unmeasured', () => {
    expect(
      resolveConnectivityStatus(signals({ realtimeStatus: 'connecting', serverReachable: null }))
    ).toBe('reconnecting');
    expect(
      resolveConnectivityStatus(signals({ realtimeStatus: 'disconnected', serverReachable: null }))
    ).toBe('offline');
    expect(
      resolveConnectivityStatus(signals({ realtimeStatus: 'error', serverReachable: null }))
    ).toBe('offline');
  });

  it('lets a live WebSocket outrank a stale unreachable reading', () => {
    expect(
      resolveConnectivityStatus(
        signals({ realtimeStatus: 'connected', serverReachable: false })
      )
    ).toBe('online');
  });
});

describe('probeServerReachable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('counts any HTTP response as reachable, including an error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(probeServerReachable('/api/capabilities', 1000)).resolves.toBe(true);
  });

  it('counts a 401 as reachable — the auth middleware is the server answering', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(probeServerReachable('/api/capabilities', 1000)).resolves.toBe(true);
  });

  it('counts a transport failure as unreachable', async () => {
    vi.stubGlobal('fetch', failingFetch());
    await expect(probeServerReachable('/api/capabilities', 1000)).resolves.toBe(false);
  });

  it('counts a request that never answers as unreachable once it times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      )
    );
    const pending = probeServerReachable('/api/capabilities', 200);
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBe(false);
  });

  it('shares one request between callers that overlap, then probes afresh', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = probeServerReachable('/api/capabilities', 1000);
    const second = probeServerReachable('/api/capabilities', 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch?.(new Response('{}', { status: 200 }));
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    // Settled, so the next caller is a real request rather than a cached answer.
    vi.stubGlobal('fetch', answeringFetch());
    await probeServerReachable('/api/capabilities', 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requests the probe endpoint without touching a cache', async () => {
    const fetchMock = answeringFetch();
    vi.stubGlobal('fetch', fetchMock);
    await probeServerReachable();
    expect(fetchMock).toHaveBeenCalledWith(
      DEFAULT_PROBE_URL,
      expect.objectContaining({ method: 'GET', cache: 'no-store' })
    );
  });
});

describe('useConnectivity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    realtime.status = 'disconnected';
    setBrowserOnline(true);
    vi.stubGlobal('fetch', answeringFetch());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows nothing while the live connection is healthy', () => {
    realtime.status = 'connected';
    const { result } = renderHook(() => useConnectivity());

    expect(result.current.status).toBe('online');
    expect(result.current.isOnline).toBe(true);
    expect(result.current.shouldSurface).toBe(false);
  });

  it('stays quiet until the degraded verdict has held for the settle window', async () => {
    realtime.status = 'connecting';
    const { result } = renderHook(() => useConnectivity({ probe: false }));

    expect(result.current.status).toBe('reconnecting');
    expect(result.current.shouldSurface).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_SURFACE_DELAY_MS - 1);
    });
    expect(result.current.shouldSurface).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(result.current.shouldSurface).toBe(true);
  });

  it('goes offline the moment the device reports it, even with a live socket', async () => {
    realtime.status = 'connected';
    const { result } = renderHook(() => useConnectivity({ surfaceDelayMs: 0 }));
    expect(result.current.status).toBe('online');

    setBrowserOnline(false);
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });

    expect(result.current.status).toBe('offline');
    expect(result.current.shouldSurface).toBe(true);
  });

  it('clears the indicator as soon as the connection comes back', async () => {
    const { result, rerender } = renderHook(() => useConnectivity({ surfaceDelayMs: 0 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.shouldSurface).toBe(true);

    realtime.status = 'connected';
    await act(async () => {
      rerender();
    });

    expect(result.current.status).toBe('online');
    expect(result.current.shouldSurface).toBe(false);
    expect(result.current.lastReachableAt).not.toBeNull();
  });

  it('does not claim to be online when navigator.onLine lies and the server is gone', async () => {
    // navigator.onLine is true and the socket is mid-reconnect, which on its
    // own reads as "reconnecting". The probe is what establishes the truth.
    realtime.status = 'connecting';
    vi.stubGlobal('fetch', failingFetch());
    const { result } = renderHook(() => useConnectivity({ probeDelayMs: 10, surfaceDelayMs: 0 }));

    expect(result.current.status).toBe('reconnecting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(result.current.signals.browserOnline).toBe(true);
    expect(result.current.signals.serverReachable).toBe(false);
    expect(result.current.status).toBe('offline');
    expect(result.current.isOnline).toBe(false);
  });

  it('reports reconnecting when the server answers a probe but push is still down', async () => {
    realtime.status = 'disconnected';
    const { result } = renderHook(() => useConnectivity({ probeDelayMs: 10, surfaceDelayMs: 0 }));

    expect(result.current.status).toBe('offline');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(result.current.status).toBe('reconnecting');
    expect(result.current.isReconnecting).toBe(true);
  });

  it('keeps probing on the interval while the verdict stays degraded', async () => {
    const fetchMock = failingFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() =>
      useConnectivity({ probeDelayMs: 10, probeIntervalMs: 100, surfaceDelayMs: 0 })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(220);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not probe while the device itself says it is offline', async () => {
    const fetchMock = answeringFetch();
    vi.stubGlobal('fetch', fetchMock);
    setBrowserOnline(false);
    renderHook(() => useConnectivity({ probeDelayMs: 10, surfaceDelayMs: 0 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not probe while the live connection is healthy', async () => {
    const fetchMock = answeringFetch();
    vi.stubGlobal('fetch', fetchMock);
    realtime.status = 'connected';
    renderHook(() => useConnectivity({ probeDelayMs: 10 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops reachability back to unmeasured when the browser claims to be back', async () => {
    realtime.status = 'connecting';
    vi.stubGlobal('fetch', failingFetch());
    const { result } = renderHook(() => useConnectivity({ probeDelayMs: 10, surfaceDelayMs: 0 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(result.current.signals.serverReachable).toBe(false);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    // "Back online" is a hint, not evidence: the stale `false` is cleared but
    // nothing is claimed until a probe or the socket answers.
    expect(result.current.signals.serverReachable).toBeNull();
    expect(result.current.isOnline).toBe(false);
  });

  it('accepts reachability reported by an ordinary API call', async () => {
    realtime.status = 'disconnected';
    const { result } = renderHook(() => useConnectivity({ probe: false, surfaceDelayMs: 0 }));

    expect(result.current.status).toBe('offline');

    await act(async () => {
      reportServerReachability(true);
    });
    expect(result.current.status).toBe('reconnecting');

    await act(async () => {
      reportServerReachability(false);
    });
    expect(result.current.status).toBe('offline');
  });

  it('runs a probe on demand via recheck()', async () => {
    const fetchMock = answeringFetch();
    vi.stubGlobal('fetch', fetchMock);
    realtime.status = 'disconnected';
    const { result } = renderHook(() => useConnectivity({ probe: false, surfaceDelayMs: 0 }));

    await act(async () => {
      result.current.recheck();
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.signals.serverReachable).toBe(true);
  });

  it('stops probing once unmounted', async () => {
    const fetchMock = failingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = renderHook(() =>
      useConnectivity({ probeDelayMs: 10, probeIntervalMs: 50, surfaceDelayMs: 0 })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    const callsBeforeUnmount = fetchMock.mock.calls.length;

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(fetchMock.mock.calls.length).toBe(callsBeforeUnmount);
  });
});
