/**
 * Tests for the press-feedback timer of NavigationButtons (Issue #2176).
 *
 * #473 landed the press highlight as a bare `setTimeout(() => setActiveKey(null),
 * KEY_PRESS_FEEDBACK_RESET_MS)` — no id kept, so nothing could cancel it. A
 * toolbar unmounted inside those 150 ms therefore left a callback that still ran
 * and still wrote state into a tree that was gone. In a browser that is harmless
 * (React drops the update on a torn-down root). Under jsdom it is not: the
 * callback outlives the test that armed it and fires against an environment whose
 * `window` has already been torn down, which surfaces as an unhandled error
 * charged to whichever test is running at the time — every test green and vitest
 * still exit 1, in a PR that never touched this file. #2174 did exactly that to
 * PR #2170 and PR #2173 from the sibling `OpencodeQuickKeys`; this file had simply
 * not been pressed-then-unmounted by any test yet.
 *
 * This toolbar arms the timer from TWO routes — a click and the arrow keys
 * `handleKeyDown` intercepts — so both are exercised below. Unmount collection is
 * the same for either, because both go through the one `sendKeys`.
 *
 * What is asserted, in order of what would hurt most if it regressed:
 *
 *   1. The armed callback does NOT run after unmount, from either route, and
 *      nothing is left on the timer queue. This is the issue.
 *   2. A second press re-arms from zero instead of inheriting the first press's
 *      pending timer — what keeps a held-down arrow key from having its last
 *      highlight cut short by the first press's deadline.
 *   3. The visible behaviour is unchanged: the highlight is on synchronously at
 *      press time, off exactly `KEY_PRESS_FEEDBACK_RESET_MS` later, and the key
 *      request still goes out with the same body.
 *
 * Mutation-checked: deleting the unmount `clearTimeout` in
 * `useKeyPressFeedback` reddens (1), deleting the re-arm `clearTimeout` reddens (2).
 *
 * Real dictionary rather than the echo mock, matching `NavigationButtons.test.tsx`
 * — the toolbar resolves its caption and `aria-label` through t().
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NavigationButtons } from '@/components/worktree/NavigationButtons';
import { KEY_PRESS_FEEDBACK_RESET_MS } from '@/config/ui-feedback-config';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) })
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Wrap the feedback `setTimeout` so the test can see whether the scheduled
 * callback ever RAN, which is the only externally visible thing about it — its
 * sole effect is `setActiveKey(null)`, and React 19 swallows that on a torn-down
 * root rather than reporting it.
 *
 * Installed after `vi.useFakeTimers()` so it wraps the fake timer, and only
 * intercepts the 150 ms feedback delay; `useSpecialKeys`' own 100 ms refresh
 * timer and every other caller are passed through untouched.
 *
 * Copied rather than shared with the sibling #2174 / #2176 files: the helper is
 * eight lines of test scaffolding and this Issue's scope stops at the component
 * and hook test directories.
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

/** The pressed-state class this toolbar renders on the active button. */
function isHighlighted(ariaLabel: string): boolean {
  return screen.getByLabelText(ariaLabel).className.includes('bg-accent-500');
}

describe('NavigationButtons press feedback survives unmount (Issue #2176)', () => {
  it('does not run the feedback callback after the toolbar unmounts', () => {
    const feedback = trackFeedbackCallbacks();
    const { unmount } = render(<NavigationButtons worktreeId="w-1" cliToolId="codex" />);

    fireEvent.click(screen.getByLabelText('Escape'));
    expect(feedback.armed).toBe(1);
    expect(feedback.ran).toBe(0);

    unmount();

    // The id was kept and cleared on unmount, so draining the whole queue never
    // reaches the callback. Without that clear it runs here, writing state into
    // a tree that no longer exists — and, once the file's jsdom is torn down,
    // into an environment that no longer exists either.
    act(() => {
      vi.advanceTimersByTime(KEY_PRESS_FEEDBACK_RESET_MS * 10);
    });
    expect(feedback.ran).toBe(0);
  });

  it('collects the timer armed through the intercepted arrow keys too', () => {
    const feedback = trackFeedbackCallbacks();
    const { unmount } = render(<NavigationButtons worktreeId="w-1" cliToolId="codex" />);

    // The keyboard route never touches a button: `handleKeyDown` on the toolbar
    // maps the physical key and calls the same `sendKeys`.
    fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'ArrowDown' });
    expect(feedback.armed).toBe(1);
    expect(isHighlighted('Down')).toBe(true);

    unmount();
    act(() => {
      vi.advanceTimersByTime(KEY_PRESS_FEEDBACK_RESET_MS * 10);
    });
    expect(feedback.ran).toBe(0);
  });

  it('unmounting mid-press throws nothing, for every key including the pager set', () => {
    const feedback = trackFeedbackCallbacks();

    // showPagerKeys gives the widest toolbar: the six base keys plus #1017's
    // PgUp/PgDn/Home/End/q. All eleven go through the one `sendKeys`.
    const ariaLabels = [
      'Left',
      'Up',
      'Down',
      'Right',
      'Enter',
      'Escape',
      'Page Up',
      'Page Down',
      'Home',
      'End',
      'Quit pager',
    ];
    for (const ariaLabel of ariaLabels) {
      const { unmount } = render(
        <NavigationButtons worktreeId="w-1" cliToolId="codex" showPagerKeys />
      );
      fireEvent.click(screen.getByLabelText(ariaLabel));

      expect(() => {
        unmount();
        act(() => {
          vi.advanceTimersByTime(KEY_PRESS_FEEDBACK_RESET_MS * 10);
        });
      }).not.toThrow();
    }

    expect(feedback.armed).toBe(ariaLabels.length);
    expect(feedback.ran).toBe(0);
  });
});

describe('NavigationButtons press feedback re-arms from zero (Issue #2176)', () => {
  it('keeps the second press highlighted for its own full duration', () => {
    render(<NavigationButtons worktreeId="w-1" cliToolId="codex" />);

    fireEvent.click(screen.getByLabelText('Up'));
    expect(isHighlighted('Up')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(KEY_PRESS_FEEDBACK_RESET_MS - 50);
    });
    fireEvent.click(screen.getByLabelText('Down'));
    expect(isHighlighted('Down')).toBe(true);
    expect(isHighlighted('Up')).toBe(false);

    // Past the FIRST press's original deadline. Its timer was cleared, so the
    // second press's highlight is still on.
    act(() => {
      vi.advanceTimersByTime(50 + 1);
    });
    expect(isHighlighted('Down')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(KEY_PRESS_FEEDBACK_RESET_MS);
    });
    expect(isHighlighted('Down')).toBe(false);
  });

  it('arms exactly one feedback timer per press', () => {
    const feedback = trackFeedbackCallbacks();
    render(<NavigationButtons worktreeId="w-1" cliToolId="codex" />);

    fireEvent.click(screen.getByLabelText('Up'));
    fireEvent.click(screen.getByLabelText('Up'));
    expect(feedback.armed).toBe(2);

    // Two presses armed two timers, but the first was cleared by the second, so
    // draining the queue runs exactly one callback.
    act(() => {
      vi.advanceTimersByTime(KEY_PRESS_FEEDBACK_RESET_MS * 10);
    });
    expect(feedback.ran).toBe(1);
  });
});

describe('NavigationButtons press feedback is otherwise unchanged (Issue #2176)', () => {
  it('highlights synchronously and clears after KEY_PRESS_FEEDBACK_RESET_MS', () => {
    render(<NavigationButtons worktreeId="w-1" cliToolId="codex" />);
    const button = screen.getByLabelText('Escape');

    fireEvent.click(button);
    expect(button.className).toContain('bg-accent-500');
    expect(button.className).toContain('scale-95');

    act(() => {
      vi.advanceTimersByTime(KEY_PRESS_FEEDBACK_RESET_MS - 1);
    });
    expect(button.className).toContain('bg-accent-500');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(button.className).not.toContain('bg-accent-500');
    expect(button.className).toContain('bg-surface');
  });

  it('still sends the same key, in the same one request', () => {
    render(<NavigationButtons worktreeId="w-1" cliToolId="codex" instanceId="codex-3" />);

    fireEvent.click(screen.getByLabelText('Escape'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/worktrees/w-1/special-keys');
    expect(JSON.parse(String(init.body))).toEqual({
      cliToolId: 'codex',
      keys: ['Escape'],
      instanceId: 'codex-3',
    });
  });
});
