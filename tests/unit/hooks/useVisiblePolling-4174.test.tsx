/**
 * `useVisiblePolling` (Issue #4174): the shared shape of #4160's hidden-tab poll, and
 * the numbering that decides whether an answer may be taken.
 *
 * Positive controls: each "refused" case is what a bare setInterval would take.
 * Negative controls: the newest answer, and one from `refresh()`, are taken.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVisiblePolling, type VisiblePollingClaim } from '@/hooks/useVisiblePolling';

const TICK_MS = 1000;
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

async function switchTo(state: DocumentVisibilityState): Promise<void> {
  setVisibility(state);
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
  });
}

const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

/** A read that records the claim it was handed and does nothing else. */
function recordingRead() {
  const claims: VisiblePollingClaim[] = [];
  const read = vi.fn(async (claim: VisiblePollingClaim) => {
    claims.push(claim);
  });
  return { read, claims };
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
});
afterEach(() => {
  vi.useRealTimers();
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  else delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('[#4174] useVisiblePolling cadence', () => {
  it('reads on mount and on every visible tick (negative control)', async () => {
    const { read } = recordingRead();
    renderHook(() => useVisiblePolling(read, TICK_MS));
    await tick(TICK_MS * 2);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('hidden: no read; back: one read at once; going hidden reads nothing', async () => {
    const { read } = recordingRead();
    renderHook(() => useVisiblePolling(read, TICK_MS));
    await tick(0);
    read.mockClear();
    await switchTo('hidden');
    await tick(TICK_MS * 3);
    expect(read).not.toHaveBeenCalled();
    await switchTo('visible');
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('[#4174] useVisiblePolling claims', () => {
  it('the newest answer is taken, an older one after it is refused', async () => {
    const { read, claims } = recordingRead();
    renderHook(() => useVisiblePolling(read, TICK_MS));
    await tick(0);
    await switchTo('hidden');
    await switchTo('visible');
    expect(claims).toHaveLength(2);
    expect(claims[1]()).toBe(true);
    expect(claims[0]()).toBe(false);
  });

  it('answers in order are all taken (negative control), and a claim is taken once', async () => {
    const { read, claims } = recordingRead();
    renderHook(() => useVisiblePolling(read, TICK_MS));
    await tick(TICK_MS);
    expect(claims[0]()).toBe(true);
    expect(claims[1]()).toBe(true);
    expect(claims[1]()).toBe(false);
  });

  it('after unmount, an answer in flight is refused', async () => {
    const { read, claims } = recordingRead();
    const { unmount } = renderHook(() => useVisiblePolling(read, TICK_MS));
    await tick(0);
    unmount();
    expect(claims[0]()).toBe(false);
  });

  it('after the read changes (another target), the old target answer is refused', async () => {
    const a = recordingRead();
    const b = recordingRead();
    const { rerender } = renderHook(({ read }) => useVisiblePolling(read, TICK_MS), {
      initialProps: { read: a.read },
    });
    await tick(0);
    rerender({ read: b.read });
    await tick(0);
    expect(b.read).toHaveBeenCalledTimes(1);
    expect(a.claims[0]()).toBe(false);
    expect(b.claims[0]()).toBe(true);
  });

  it('refresh() is numbered too: an older tick answering after it is refused', async () => {
    const { read, claims } = recordingRead();
    const { result } = renderHook(() => useVisiblePolling(read, TICK_MS));
    await tick(0);
    act(() => result.current());
    expect(claims).toHaveLength(2);
    expect(claims[1]()).toBe(true);
    expect(claims[0]()).toBe(false);
  });

  it('refresh() while hidden asks nothing; coming back reads once', async () => {
    const { read } = recordingRead();
    const { result } = renderHook(() => useVisiblePolling(read, TICK_MS));
    await tick(0);
    read.mockClear();
    await switchTo('hidden');
    act(() => result.current());
    expect(read).not.toHaveBeenCalled();
    await switchTo('visible');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('refresh() while visible reads at once (negative control)', async () => {
    const { read } = recordingRead();
    const { result } = renderHook(() => useVisiblePolling(read, TICK_MS));
    await tick(0);
    read.mockClear();
    act(() => result.current());
    expect(read).toHaveBeenCalledTimes(1);
  });
});
