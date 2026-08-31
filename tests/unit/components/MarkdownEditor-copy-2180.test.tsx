/**
 * Tests for the copy-confirmation timer of MarkdownEditor (Issue #2180).
 *
 * #162 landed the confirmation as a bare
 * `setTimeout(() => setCopied(false), COPY_FEEDBACK_RESET_MS)` — no id kept, so
 * nothing could cancel it. An editor closed inside those 2000 ms therefore left a
 * callback that still ran and still wrote state into a tree that was gone. In a
 * browser that is harmless (React drops the update on a torn-down root). Under
 * jsdom it is not: the callback outlives the test that armed it and fires against
 * an environment whose `window` has already been torn down, which surfaces as an
 * unhandled error charged to whichever test is running at the time — every test
 * green and vitest still exit 1, in a PR that never touched this file. #2174 did
 * exactly that to PR #2170 and PR #2173 from the 150 ms press timer; this window
 * is 2000 ms, and "copy the document, then close the editor" is an ordinary
 * thing to do.
 *
 * The visible half of the confirmation is already pinned in
 * `MarkdownEditor.test.tsx` ("Copy Content Button (Issue #162)"); what is pinned
 * HERE is that the timer is collected, plus the re-arm that keeps a second copy
 * from being cut short by the first copy's deadline.
 *
 * Mutation-checked: deleting the unmount `clearTimeout` in `useCopyFeedback`
 * reddens the unmount tests, deleting the re-arm `clearTimeout` reddens the
 * re-arm test.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import { MarkdownEditor } from '@/components/worktree/MarkdownEditor';
import { COPY_FEEDBACK_RESET_MS } from '@/config/ui-feedback-config';

const mockCopyToClipboard = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/clipboard-utils', () => ({
  copyToClipboard: (...args: unknown[]) => mockCopyToClipboard(...args),
}));

const FILE_CONTENT = '# Test Document\n\nThis is a test.';

const defaultProps = {
  worktreeId: 'test-worktree-123',
  filePath: 'docs/readme.md',
};

/** jsdom has no ResizeObserver; the preview pane constructs one on mount. */
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  mockCopyToClipboard.mockClear();
  mockCopyToClipboard.mockResolvedValue(undefined);
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, content: FILE_CONTENT }),
  }) as unknown as typeof fetch;
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  window.localStorage.clear();
  // `shouldAdvanceTime` keeps the mount fetch's promise chain resolving while
  // the copy timer stays under `advanceTimersByTime`'s control.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Wrap the feedback `setTimeout` so the test can see whether the scheduled
 * callback ever RAN, which is the only externally visible thing about it — its
 * sole effect is `setCopied(false)`, and React 19 swallows that on a torn-down
 * root rather than reporting it.
 *
 * Installed after `vi.useFakeTimers()` so it wraps the fake timer, and only
 * intercepts the 2000 ms feedback delay; the editor's own auto-save debounce and
 * every other caller are passed through untouched.
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

async function waitForCopyButton(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(screen.getByTestId('copy-content-button')).toBeInTheDocument();
  });
  return screen.getByTestId('copy-content-button');
}

/** The confirmed state swaps the Copy icon for a Check and adds `text-success`. */
function isConfirmed(): boolean {
  return screen.getByTestId('copy-content-button').classList.contains('text-success');
}

async function clickCopy(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('copy-content-button'));
  });
}

describe('MarkdownEditor copy confirmation survives unmount (Issue #2180)', () => {
  it('does not run the feedback callback after the editor unmounts', async () => {
    const feedback = trackFeedbackCallbacks();
    const { unmount } = render(<MarkdownEditor {...defaultProps} />);
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
    const { unmount } = render(<MarkdownEditor {...defaultProps} />);
    await waitForCopyButton();

    await clickCopy();
    expect(isConfirmed()).toBe(true);

    expect(() => {
      unmount();
      act(() => {
        vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS * 10);
      });
    }).not.toThrow();
    expect(feedback.ran).toBe(0);
  });
});

describe('MarkdownEditor copy confirmation re-arms from zero (Issue #2180)', () => {
  it('gives the second copy its own full window', async () => {
    render(<MarkdownEditor {...defaultProps} />);
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
    expect(isConfirmed()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS);
    });
    expect(isConfirmed()).toBe(false);
  });

  it('runs exactly one callback for two copies', async () => {
    const feedback = trackFeedbackCallbacks();
    render(<MarkdownEditor {...defaultProps} />);
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

describe('MarkdownEditor copy confirmation is otherwise unchanged (Issue #2180)', () => {
  it('copies the document and reverts after COPY_FEEDBACK_RESET_MS', async () => {
    render(<MarkdownEditor {...defaultProps} />);
    await waitForCopyButton();

    expect(isConfirmed()).toBe(false);
    await clickCopy();
    expect(mockCopyToClipboard).toHaveBeenCalledWith(FILE_CONTENT);
    expect(isConfirmed()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS - 1);
    });
    expect(isConfirmed()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(isConfirmed()).toBe(false);
  });

  it('shows nothing when the clipboard write rejects', async () => {
    mockCopyToClipboard.mockRejectedValueOnce(new Error('Clipboard API failed'));
    render(<MarkdownEditor {...defaultProps} />);
    await waitForCopyButton();

    await clickCopy();

    expect(isConfirmed()).toBe(false);
  });
});
