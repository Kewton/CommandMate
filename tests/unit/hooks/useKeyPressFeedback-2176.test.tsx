/**
 * Tests for useKeyPressFeedback (Issue #2176).
 *
 * The hook is the one owner of the press-highlight timer that
 * `OpencodeQuickKeys`, `TerminalEscapeHatch` and `NavigationButtons` all render.
 * Its component-level consequences are pinned in the three `*-2174` / `*-2176`
 * component files; what is pinned HERE is the contract itself, so a fourth strip
 * added later inherits a tested one rather than re-deriving it:
 *
 *   1. The timer id is kept and cleared on unmount — the whole point of #2174 /
 *      #2176. A callback that outlives its tree is inert in a browser and an
 *      unhandled error under jsdom, charged to an unrelated test.
 *   2. A press re-arms from zero rather than inheriting the previous press's
 *      remaining time.
 *   3. `markPressed` is referentially stable, so callers can list it in a
 *      `useCallback` dep array without rebuilding their handlers every render.
 *
 * Mutation-checked: deleting the unmount `clearTimeout` reddens (1), deleting the
 * re-arm `clearTimeout` reddens (2).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKeyPressFeedback } from '@/hooks/useKeyPressFeedback';
import { KEY_PRESS_FEEDBACK_RESET_MS } from '@/config/ui-feedback-config';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Wrap the feedback `setTimeout` so the test can see whether the scheduled
 * callback ever RAN. Its sole effect is a state write that React swallows on a
 * torn-down root, so counting the run is the only way to tell "cleared" from
 * "fired into nothing".
 */
function trackFeedbackCallbacks(): { ran: number; armed: number } {
  const counters = { ran: 0, armed: 0 };
  const passthrough = globalThis.setTimeout;

  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: number,
    ...args: unknown[]
  ) => {
    if (typeof handler === 'function' && timeout === KEY_PRESS_FEEDBACK_RESET_MS) {
      counters.armed += 1;
      return passthrough(() => {
        counters.ran += 1;
        (handler as () => void)();
      }, timeout);
    }
    return (passthrough as (...a: unknown[]) => unknown)(handler, timeout, ...args);
  }) as unknown as typeof setTimeout);

  return counters;
}

describe('useKeyPressFeedback collects its timer (Issue #2176)', () => {
  it('does not run the armed callback after unmount', () => {
    const feedback = trackFeedbackCallbacks();
    const { result, unmount } = renderHook(() => useKeyPressFeedback());

    act(() => {
      result.current.markPressed('Escape');
    });
    expect(feedback.armed).toBe(1);
    expect(feedback.ran).toBe(0);

    unmount();
    act(() => {
      vi.advanceTimersByTime(KEY_PRESS_FEEDBACK_RESET_MS * 10);
    });

    expect(feedback.ran).toBe(0);
  });

  it('leaves nothing pending when unmounted without a press', () => {
    const feedback = trackFeedbackCallbacks();
    const { unmount } = renderHook(() => useKeyPressFeedback());

    // The cleanup runs with a null ref; it must not throw or clear a stray id.
    expect(() => unmount()).not.toThrow();
    expect(feedback.armed).toBe(0);
  });
});

describe('useKeyPressFeedback re-arms from zero (Issue #2176)', () => {
  it('gives the second press its own full duration', () => {
    const { result } = renderHook(() => useKeyPressFeedback());

    act(() => {
      result.current.markPressed('Up');
    });
    expect(result.current.activeKey).toBe('Up');

    act(() => {
      vi.advanceTimersByTime(KEY_PRESS_FEEDBACK_RESET_MS - 50);
    });
    act(() => {
      result.current.markPressed('Down');
    });
    expect(result.current.activeKey).toBe('Down');

    // Past the FIRST press's original deadline. Its timer was cleared, so the
    // second press is still lit.
    act(() => {
      vi.advanceTimersByTime(50 + 1);
    });
    expect(result.current.activeKey).toBe('Down');

    act(() => {
      vi.advanceTimersByTime(KEY_PRESS_FEEDBACK_RESET_MS);
    });
    expect(result.current.activeKey).toBeNull();
  });

  it('runs exactly one callback for two presses', () => {
    const feedback = trackFeedbackCallbacks();
    const { result } = renderHook(() => useKeyPressFeedback());

    act(() => {
      result.current.markPressed('Up');
    });
    act(() => {
      result.current.markPressed('Up');
    });
    expect(feedback.armed).toBe(2);

    act(() => {
      vi.advanceTimersByTime(KEY_PRESS_FEEDBACK_RESET_MS * 10);
    });
    expect(feedback.ran).toBe(1);
  });
});

describe('useKeyPressFeedback timing and identity (Issue #2176)', () => {
  it('lights up synchronously and clears exactly at KEY_PRESS_FEEDBACK_RESET_MS', () => {
    const { result } = renderHook(() => useKeyPressFeedback());

    expect(result.current.activeKey).toBeNull();
    act(() => {
      result.current.markPressed('Enter');
    });
    expect(result.current.activeKey).toBe('Enter');

    act(() => {
      vi.advanceTimersByTime(KEY_PRESS_FEEDBACK_RESET_MS - 1);
    });
    expect(result.current.activeKey).toBe('Enter');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.activeKey).toBeNull();
  });

  it('keeps markPressed referentially stable across renders', () => {
    const { result, rerender } = renderHook(() => useKeyPressFeedback());
    const first = result.current.markPressed;

    act(() => {
      result.current.markPressed('Left');
    });
    rerender();

    // A new identity here would rebuild every caller's `useCallback` handler on
    // each press, which is why callers may list it in their dep arrays.
    expect(result.current.markPressed).toBe(first);
  });
});
