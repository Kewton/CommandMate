/**
 * Tests for the copy-confirmation timer of ReportTab (Issue #2180).
 *
 * #636 landed the confirmation as a bare
 * `setTimeout(() => setCopied(false), COPY_FEEDBACK_RESET_MS)` — no id kept, so
 * nothing could cancel it. A Review screen left inside those 2000 ms therefore
 * left a callback that still ran and still wrote state into a tree that was gone.
 * In a browser that is harmless (React drops the update on a torn-down root).
 * Under jsdom it is not: the callback outlives the test that armed it and fires
 * against an environment whose `window` has already been torn down, which
 * surfaces as an unhandled error charged to whichever test is running at the
 * time — every test green and vitest still exit 1, in a PR that never touched
 * this file. #2174 did exactly that to PR #2170 and PR #2173 from the 150 ms
 * press timer; this window is 2000 ms, and "copy the report, then switch tabs"
 * is exactly what the button is for.
 *
 * What is asserted, in order of what would hurt most if it regressed:
 *
 *   1. The armed callback does NOT run after unmount. This is the issue.
 *   2. A second copy re-arms from zero instead of inheriting the first copy's
 *      pending timer.
 *   3. The visible behaviour is unchanged: the caption reads "Copied!" once the
 *      clipboard write resolves and goes back to "Copy" exactly
 *      `COPY_FEEDBACK_RESET_MS` later, with the report text on the clipboard.
 *
 * Mutation-checked: deleting the unmount `clearTimeout` in `useCopyFeedback`
 * reddens (1), deleting the re-arm `clearTimeout` reddens (2).
 *
 * Real dictionary rather than the echo mock used by `ReportTab.test.tsx`: this
 * file asserts the button's rendered caption, and the echo mock would keep
 * "Copied!" green even for a key that does not exist.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import ReportTab from '@/components/review/ReportTab';
import { COPY_FEEDBACK_RESET_MS } from '@/config/ui-feedback-config';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const mockCopyToClipboard = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/clipboard-utils', () => ({
  copyToClipboard: (...args: unknown[]) => mockCopyToClipboard(...args),
}));

const REPORT_CONTENT = '## Today\n\n- shipped the thing\n';

const REPORT = {
  date: '2026-08-31',
  content: REPORT_CONTENT,
  generatedByTool: 'claude',
  model: null,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
};

beforeEach(() => {
  mockCopyToClipboard.mockClear();
  mockCopyToClipboard.mockResolvedValue(undefined);
  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/daily-summary/status')) {
      return Promise.resolve({ ok: true, json: async () => ({ generating: false }) });
    }
    if (url.includes('/api/templates')) {
      return Promise.resolve({ ok: true, json: async () => ({ templates: [] }) });
    }
    if (url.includes('/api/daily-summary')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ report: REPORT, messageCount: 12 }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }) as unknown as typeof fetch;
  // `shouldAdvanceTime` keeps the mount fetches' promise chains resolving while
  // the copy timer stays under `advanceTimersByTime`'s control.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Wrap the feedback `setTimeout` so the test can see whether the scheduled
 * callback ever RAN, which is the only externally visible thing about it — its
 * sole effect is `setCopied(false)`, and React 19 swallows that on a torn-down
 * root rather than reporting it.
 *
 * Installed after `vi.useFakeTimers()` so it wraps the fake timer, and only
 * intercepts the 2000 ms feedback delay; `useGenerationStatus`' 5s status poll
 * is a `setInterval` and every other caller is passed through untouched.
 *
 * Copied rather than shared with the sibling #2180 files: the helper is eight
 * lines of test scaffolding and this Issue's scope stops at the component and
 * hook test directories.
 */
function trackFeedbackCallbacks(): { ran: number; armed: number } {
  const counters = { ran: 0, armed: 0 };
  const passthrough = globalThis.setTimeout;

  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: number,
    ...args: unknown[]
  ) => {
    if (typeof handler === 'function' && timeout === COPY_FEEDBACK_RESET_MS) {
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

/** Wait for the report fetch to land, which is what renders the copy button. */
async function waitForCopyButton(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('copy-report-button')).toBeInTheDocument();
  });
}

function caption(): string {
  return screen.getByTestId('copy-report-button').textContent ?? '';
}

async function clickCopy(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('copy-report-button'));
  });
}

describe('ReportTab copy confirmation survives unmount (Issue #2180)', () => {
  it('does not run the feedback callback after the tab unmounts', async () => {
    const feedback = trackFeedbackCallbacks();
    const { unmount } = render(<ReportTab />);
    await waitForCopyButton();

    await clickCopy();
    expect(feedback.armed).toBe(1);
    expect(feedback.ran).toBe(0);

    unmount();

    // The id was kept and cleared on unmount, so draining the whole queue never
    // reaches the callback. Without that clear it runs here, writing state into
    // a tree that no longer exists — and, once the file's jsdom is torn down,
    // into an environment that no longer exists either.
    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS * 10);
    });
    expect(feedback.ran).toBe(0);
  });

  it('unmounting mid-confirmation throws nothing', async () => {
    const feedback = trackFeedbackCallbacks();
    const { unmount } = render(<ReportTab />);
    await waitForCopyButton();

    await clickCopy();
    expect(caption()).toBe('Copied!');

    expect(() => {
      unmount();
      act(() => {
        vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS * 10);
      });
    }).not.toThrow();
    expect(feedback.ran).toBe(0);
  });
});

describe('ReportTab copy confirmation re-arms from zero (Issue #2180)', () => {
  it('gives the second copy its own full window', async () => {
    render(<ReportTab />);
    await waitForCopyButton();

    await clickCopy();
    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS - 500);
    });
    await clickCopy();

    // Past the FIRST copy's original deadline. Its timer was cleared, so the
    // confirmation is still up.
    act(() => {
      vi.advanceTimersByTime(500 + 1);
    });
    expect(caption()).toBe('Copied!');

    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS);
    });
    expect(caption()).toBe('Copy');
  });

  it('runs exactly one callback for two copies', async () => {
    const feedback = trackFeedbackCallbacks();
    render(<ReportTab />);
    await waitForCopyButton();

    await clickCopy();
    await clickCopy();
    expect(feedback.armed).toBe(2);

    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS * 10);
    });
    expect(feedback.ran).toBe(1);
  });
});

describe('ReportTab copy confirmation is otherwise unchanged (Issue #2180)', () => {
  it('copies the report and reverts after COPY_FEEDBACK_RESET_MS', async () => {
    render(<ReportTab />);
    await waitForCopyButton();

    expect(caption()).toBe('Copy');
    await clickCopy();
    expect(mockCopyToClipboard).toHaveBeenCalledWith(REPORT_CONTENT);
    expect(caption()).toBe('Copied!');

    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS - 1);
    });
    expect(caption()).toBe('Copied!');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(caption()).toBe('Copy');
  });
});
