/**
 * useFilePolling: mounted/enabled while hidden starts no timer (Issue #4190).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFilePolling } from '@/hooks/useFilePolling';

const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
}
async function switchTo(state: DocumentVisibilityState): Promise<void> {
  setVisibility(state);
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
  });
}
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
function restoreVisibility(): void {
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  else delete (document as unknown as Record<string, unknown>).visibilityState;
  if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
  else delete (document as unknown as Record<string, unknown>).hidden;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  restoreVisibility();
});

describe('useFilePolling hidden mount (Issue #4190)', () => {
  it('starts no timer when mounted hidden, then reads once and polls on visible', async () => {
    setVisibility('hidden');
    const onPoll = vi.fn();
    renderHook(() => useFilePolling({ intervalMs: 1000, enabled: true, onPoll }));
    await tick(5000);
    expect(onPoll).not.toHaveBeenCalled();

    await switchTo('visible');
    expect(onPoll).toHaveBeenCalledTimes(1);
    await tick(1000);
    expect(onPoll).toHaveBeenCalledTimes(2);
  });

  it('starts no timer when enabled flips on while hidden', async () => {
    setVisibility('hidden');
    const onPoll = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useFilePolling({ intervalMs: 1000, enabled, onPoll }),
      { initialProps: { enabled: false } },
    );
    rerender({ enabled: true });
    await tick(3000);
    expect(onPoll).not.toHaveBeenCalled();
    await switchTo('visible');
    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  it('control: a visible mount still polls on the interval', async () => {
    setVisibility('visible');
    const onPoll = vi.fn();
    renderHook(() => useFilePolling({ intervalMs: 1000, enabled: true, onPoll }));
    await tick(3000);
    expect(onPoll).toHaveBeenCalledTimes(3);
  });
});
