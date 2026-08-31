/**
 * Tests for the press-feedback timer of TerminalEscapeHatch (Issue #2176).
 *
 * #1494 landed the press highlight as a bare `setTimeout(() => setActiveKey(null),
 * KEY_PRESS_FEEDBACK_RESET_MS)` — no id kept, so nothing could cancel it. A hatch
 * unmounted inside those 150 ms therefore left a callback that still ran and still
 * wrote state into a tree that was gone. In a browser that is harmless (React
 * drops the update on a torn-down root). Under jsdom it is not: the callback
 * outlives the test that armed it and fires against an environment whose `window`
 * has already been torn down, which surfaces as an unhandled error charged to
 * whichever test is running at the time — every test green and vitest still
 * exit 1, in a PR that never touched this file. #2174 did exactly that to PR
 * #2170 and PR #2173 from the sibling `OpencodeQuickKeys`; this file had simply
 * not been pressed-then-unmounted by any test yet.
 *
 * This hatch is the most exposed of the three strips: it is rendered only while a
 * TUI overlay is unclassified, so the Esc that dismisses the overlay is also what
 * unmounts the hatch — press and unmount are one gesture here, not a race.
 *
 * What is asserted, in order of what would hurt most if it regressed:
 *
 *   1. The armed callback does NOT run after unmount, and nothing is left on the
 *      timer queue. This is the issue.
 *   2. A second press re-arms from zero instead of inheriting the first press's
 *      pending timer.
 *   3. The visible behaviour is unchanged: the highlight is on synchronously at
 *      press time, off exactly `KEY_PRESS_FEEDBACK_RESET_MS` later, and the key
 *      request still goes out with the same body.
 *
 * Mutation-checked: deleting the unmount `clearTimeout` in
 * `useKeyPressFeedback` reddens (1), deleting the re-arm `clearTimeout` reddens (2).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TerminalEscapeHatch } from '@/components/worktree/TerminalEscapeHatch';
import { KEY_PRESS_FEEDBACK_RESET_MS } from '@/config/ui-feedback-config';

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

/** The pressed-state class this hatch renders on the active button. */
function isHighlighted(ariaLabel: string): boolean {
  return screen.getByLabelText(ariaLabel).className.includes('bg-amber-500');
}

describe('TerminalEscapeHatch press feedback survives unmount (Issue #2176)', () => {
  it('does not run the feedback callback after the hatch unmounts', () => {
    const feedback = trackFeedbackCallbacks();
    const { unmount } = render(<TerminalEscapeHatch worktreeId="w-1" cliToolId="claude" />);

    fireEvent.click(screen.getByLabelText('Send Escape'));
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

  it('unmounting mid-press throws nothing, for every key on the pad', () => {
    const feedback = trackFeedbackCallbacks();

    // Codex gets the widest pad: the five navigation keys, Esc, and the pager q.
    const ariaLabels = [
      'Send Left',
      'Send Up',
      'Send Down',
      'Send Right',
      'Send Enter',
      'Send Escape',
      'Send q (quit)',
    ];
    for (const ariaLabel of ariaLabels) {
      const { unmount } = render(<TerminalEscapeHatch worktreeId="w-1" cliToolId="codex" />);
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

describe('TerminalEscapeHatch press feedback re-arms from zero (Issue #2176)', () => {
  it('keeps the second press highlighted for its own full duration', () => {
    render(<TerminalEscapeHatch worktreeId="w-1" cliToolId="claude" />);

    fireEvent.click(screen.getByLabelText('Send Left'));
    expect(isHighlighted('Send Left')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(KEY_PRESS_FEEDBACK_RESET_MS - 50);
    });
    fireEvent.click(screen.getByLabelText('Send Right'));
    expect(isHighlighted('Send Right')).toBe(true);
    expect(isHighlighted('Send Left')).toBe(false);

    // Past the FIRST press's original deadline. Its timer was cleared, so the
    // second press's highlight is still on.
    act(() => {
      vi.advanceTimersByTime(50 + 1);
    });
    expect(isHighlighted('Send Right')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(KEY_PRESS_FEEDBACK_RESET_MS);
    });
    expect(isHighlighted('Send Right')).toBe(false);
  });

  it('arms exactly one feedback timer per press', () => {
    const feedback = trackFeedbackCallbacks();
    render(<TerminalEscapeHatch worktreeId="w-1" cliToolId="claude" />);

    fireEvent.click(screen.getByLabelText('Send Up'));
    fireEvent.click(screen.getByLabelText('Send Up'));
    expect(feedback.armed).toBe(2);

    // Two presses armed two timers, but the first was cleared by the second, so
    // draining the queue runs exactly one callback.
    act(() => {
      vi.advanceTimersByTime(KEY_PRESS_FEEDBACK_RESET_MS * 10);
    });
    expect(feedback.ran).toBe(1);
  });
});

describe('TerminalEscapeHatch press feedback is otherwise unchanged (Issue #2176)', () => {
  it('highlights synchronously and clears after KEY_PRESS_FEEDBACK_RESET_MS', () => {
    render(<TerminalEscapeHatch worktreeId="w-1" cliToolId="claude" />);
    const button = screen.getByLabelText('Send Escape');

    fireEvent.click(button);
    expect(button.className).toContain('bg-amber-500');
    expect(button.className).toContain('scale-95');

    act(() => {
      vi.advanceTimersByTime(KEY_PRESS_FEEDBACK_RESET_MS - 1);
    });
    expect(button.className).toContain('bg-amber-500');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(button.className).not.toContain('bg-amber-500');
    expect(button.className).toContain('bg-white');
  });

  it('still sends the same key, in the same one request', () => {
    render(<TerminalEscapeHatch worktreeId="w-1" cliToolId="codex" instanceId="codex-3" />);

    fireEvent.click(screen.getByLabelText('Send q (quit)'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/worktrees/w-1/special-keys');
    expect(JSON.parse(String(init.body))).toEqual({
      cliToolId: 'codex',
      keys: ['q'],
      instanceId: 'codex-3',
    });
  });
});
