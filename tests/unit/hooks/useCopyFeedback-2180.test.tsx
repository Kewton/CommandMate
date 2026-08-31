/**
 * Tests for useCopyFeedback (Issue #2180).
 *
 * The hook is the one owner of the "copied!" timer that `MarkdownEditor`,
 * `FileViewer`, `ReportTab`, `WorktreeInfoFields` and `FileToolbar` all render.
 * Its component-level consequences are pinned in the three `*-copy-2180` files;
 * what is pinned HERE is the contract itself, so a sixth copy button added later
 * inherits a tested one rather than re-deriving it:
 *
 *   1. The timer id is kept and cleared on unmount — the whole point of #2180.
 *      A callback that outlives its tree is inert in a browser and an unhandled
 *      error under jsdom, charged to an unrelated test (#2174 reddened PR #2170
 *      and PR #2173 exactly that way with the 150 ms press timer; this one holds
 *      a 2000 ms window open).
 *   2. A copy re-arms from zero rather than inheriting the previous copy's
 *      remaining time.
 *   3. `reset()` drops the confirmation AND the pending timer, so `FileViewer`
 *      closing its modal mid-confirmation leaves nothing behind either.
 *   4. `markCopied` is referentially stable, so callers can list it in a
 *      `useCallback` dep array without rebuilding their handlers every render.
 *
 * Mutation-checked: deleting the unmount `clearTimeout` reddens (1), deleting the
 * re-arm `clearTimeout` reddens (2), deleting the `clearTimeout` in `reset`
 * reddens (3).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCopyFeedback } from '@/hooks/useCopyFeedback';
import {
  COPY_FEEDBACK_RESET_MS,
  COPY_FEEDBACK_RESET_SHORT_MS,
} from '@/config/ui-feedback-config';

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
function trackFeedbackCallbacks(delayMs: number = COPY_FEEDBACK_RESET_MS): {
  ran: number;
  armed: number;
} {
  const counters = { ran: 0, armed: 0 };
  const passthrough = globalThis.setTimeout;

  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: number,
    ...args: unknown[]
  ) => {
    if (typeof handler === 'function' && timeout === delayMs) {
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

describe('useCopyFeedback collects its timer (Issue #2180)', () => {
  it('does not run the armed callback after unmount', () => {
    const feedback = trackFeedbackCallbacks();
    const { result, unmount } = renderHook(() => useCopyFeedback());

    act(() => {
      result.current.markCopied();
    });
    expect(feedback.armed).toBe(1);
    expect(feedback.ran).toBe(0);

    unmount();
    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS * 10);
    });

    expect(feedback.ran).toBe(0);
  });

  it('leaves nothing pending when unmounted without a copy', () => {
    const feedback = trackFeedbackCallbacks();
    const { unmount } = renderHook(() => useCopyFeedback());

    // The cleanup runs with a null ref; it must not throw or clear a stray id.
    expect(() => unmount()).not.toThrow();
    expect(feedback.armed).toBe(0);
  });
});

describe('useCopyFeedback re-arms from zero (Issue #2180)', () => {
  it('gives the second copy its own full duration', () => {
    const { result } = renderHook(() => useCopyFeedback());

    act(() => {
      result.current.markCopied();
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS - 500);
    });
    act(() => {
      result.current.markCopied();
    });

    // Past the FIRST copy's original deadline. Its timer was cleared, so the
    // confirmation is still up.
    act(() => {
      vi.advanceTimersByTime(500 + 1);
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS);
    });
    expect(result.current.copied).toBe(false);
  });

  it('runs exactly one callback for two copies', () => {
    const feedback = trackFeedbackCallbacks();
    const { result } = renderHook(() => useCopyFeedback());

    act(() => {
      result.current.markCopied();
    });
    act(() => {
      result.current.markCopied();
    });
    expect(feedback.armed).toBe(2);

    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS * 10);
    });
    expect(feedback.ran).toBe(1);
  });
});

describe('useCopyFeedback reset (Issue #2180)', () => {
  it('hides the confirmation immediately', () => {
    const { result } = renderHook(() => useCopyFeedback());

    act(() => {
      result.current.markCopied();
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      result.current.reset();
    });
    expect(result.current.copied).toBe(false);
  });

  it('drops the pending timer rather than leaving it to fire later', () => {
    const feedback = trackFeedbackCallbacks();
    const { result } = renderHook(() => useCopyFeedback());

    act(() => {
      result.current.markCopied();
    });
    act(() => {
      result.current.reset();
    });

    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS * 10);
    });
    // `reset` cleared the id, so nothing was left on the queue to run — the
    // same guarantee unmount gives, for the caller that resets a live
    // confirmation while staying mounted (FileViewer closing its modal).
    expect(feedback.ran).toBe(0);
  });

  it('does not resurrect a confirmation reset before its deadline', () => {
    const { result } = renderHook(() => useCopyFeedback());

    act(() => {
      result.current.markCopied();
    });
    act(() => {
      result.current.reset();
    });
    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS * 10);
    });

    expect(result.current.copied).toBe(false);
  });
});

describe('useCopyFeedback timing and identity (Issue #2180)', () => {
  it('confirms synchronously and clears exactly at COPY_FEEDBACK_RESET_MS', () => {
    const { result } = renderHook(() => useCopyFeedback());

    expect(result.current.copied).toBe(false);
    act(() => {
      result.current.markCopied();
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS - 1);
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.copied).toBe(false);
  });

  it('honours a caller-supplied duration', () => {
    // The parameter exists for the compact copy button, which uses the shorter
    // 1.5s window. Nothing in this Issue's scope passes it, so it is pinned here
    // rather than at a call site.
    const feedback = trackFeedbackCallbacks(COPY_FEEDBACK_RESET_SHORT_MS);
    const { result } = renderHook(() => useCopyFeedback(COPY_FEEDBACK_RESET_SHORT_MS));

    act(() => {
      result.current.markCopied();
    });
    expect(feedback.armed).toBe(1);

    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_SHORT_MS - 1);
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.copied).toBe(false);
  });

  it('keeps markCopied and reset referentially stable across renders', () => {
    const { result, rerender } = renderHook(() => useCopyFeedback());
    const firstMark = result.current.markCopied;
    const firstReset = result.current.reset;

    act(() => {
      result.current.markCopied();
    });
    rerender();

    // A new identity here would rebuild every caller's `useCallback` handler on
    // each copy, which is why callers may list them in their dep arrays.
    expect(result.current.markCopied).toBe(firstMark);
    expect(result.current.reset).toBe(firstReset);
  });

  it('gives each instance its own timer', () => {
    // FileViewer, WorktreeInfoFields and FileToolbar each call the hook TWICE.
    // Sharing one timer between two buttons is the bug this shape prevents.
    const { result } = renderHook(() => ({
      a: useCopyFeedback(),
      b: useCopyFeedback(),
    }));

    act(() => {
      result.current.a.markCopied();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      result.current.b.markCopied();
    });

    expect(result.current.a.copied).toBe(true);
    expect(result.current.b.copied).toBe(true);

    // `a`'s own 2000 ms deadline: it clears, `b` (armed 1000 ms later) does not.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.a.copied).toBe(false);
    expect(result.current.b.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.b.copied).toBe(false);
  });
});
