/**
 * The reachability probe in a hidden tab (Issue #4160).
 *
 * A hidden tab whose socket dropped does not reconnect (`useWebSocket`), so its verdict
 * stays degraded and the probe used to run every 15 seconds for as long as it was hidden.
 * Once the server has answered, another answer tells nobody anything, so it rests. While
 * the server has not answered it goes on: with the socket waiting and the polls resting,
 * the probe is the only thing that can notice recovery and let a parked message go out.
 *
 * Positive controls: the "rests" tests fail on the code before this Issue.
 * Negative controls: visible probing, and a hidden tab with the server down still probes.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: () => ({
    status: 'disconnected',
    connected: false,
    subscribe: () => {},
    unsubscribe: () => {},
    addListener: () => () => {},
  }),
}));

import {
  useConnectivity,
  isServerConfirmedReachable,
  DEFAULT_PROBE_DELAY_MS,
  DEFAULT_PROBE_INTERVAL_MS,
} from '@/hooks/useConnectivity';

const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

async function changeVisibility(state: DocumentVisibilityState): Promise<void> {
  setVisibility(state);
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
  });
}

const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const answering = () => vi.fn(async () => new Response('{}', { status: 200 }));
const failing = () => vi.fn(async () => { throw new TypeError('Failed to fetch'); });

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  else delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('[#4160] the probe while the tab is hidden', () => {
  it('visible, socket down, server answering: it keeps probing (negative control)', async () => {
    const fetchSpy = answering();
    vi.stubGlobal('fetch', fetchSpy);
    renderHook(() => useConnectivity());
    await tick(DEFAULT_PROBE_DELAY_MS);
    fetchSpy.mockClear();
    await tick(DEFAULT_PROBE_INTERVAL_MS * 2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('hidden, and the server has answered: it rests', async () => {
    const fetchSpy = answering();
    vi.stubGlobal('fetch', fetchSpy);
    renderHook(() => useConnectivity());
    await tick(DEFAULT_PROBE_DELAY_MS);
    fetchSpy.mockClear();
    await changeVisibility('hidden');
    await tick(DEFAULT_PROBE_INTERVAL_MS * 3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('back: it checks again within the probe delay, and goes on', async () => {
    const fetchSpy = answering();
    vi.stubGlobal('fetch', fetchSpy);
    renderHook(() => useConnectivity());
    await tick(DEFAULT_PROBE_DELAY_MS);
    await changeVisibility('hidden');
    await tick(DEFAULT_PROBE_INTERVAL_MS);
    fetchSpy.mockClear();
    await changeVisibility('visible');
    await tick(DEFAULT_PROBE_DELAY_MS);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await tick(DEFAULT_PROBE_INTERVAL_MS);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('hidden with the server down: it goes on, and recovery is noticed (negative control)', async () => {
    const down = failing();
    vi.stubGlobal('fetch', down);
    const { result } = renderHook(() => useConnectivity());
    await tick(DEFAULT_PROBE_DELAY_MS);
    await changeVisibility('hidden');
    down.mockClear();
    await tick(DEFAULT_PROBE_INTERVAL_MS * 2);
    expect(down).toHaveBeenCalledTimes(2);
    expect(isServerConfirmedReachable(result.current.signals)).toBe(false);

    const up = answering();
    vi.stubGlobal('fetch', up);
    await tick(DEFAULT_PROBE_INTERVAL_MS);
    expect(up).toHaveBeenCalledTimes(1);
    expect(isServerConfirmedReachable(result.current.signals)).toBe(true);
    // Answered: from here it rests.
    await tick(DEFAULT_PROBE_INTERVAL_MS * 2);
    expect(up).toHaveBeenCalledTimes(1);
  });

  it('mounted hidden with nothing measured: it asks once, then rests', async () => {
    setVisibility('hidden');
    const fetchSpy = answering();
    vi.stubGlobal('fetch', fetchSpy);
    renderHook(() => useConnectivity());
    await tick(DEFAULT_PROBE_DELAY_MS);
    await tick(DEFAULT_PROBE_INTERVAL_MS * 2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
