/**
 * Tests for the copy-confirmation timers of FileViewer (Issue #2180).
 *
 * #162 landed both confirmations as a bare
 * `setTimeout(() => setCopied(false), COPY_FEEDBACK_RESET_MS)` — no id kept, so
 * nothing could cancel it. A viewer closed inside those 2000 ms therefore left a
 * callback that still ran and still wrote state into a tree that was gone. In a
 * browser that is harmless (React drops the update on a torn-down root). Under
 * jsdom it is not: the callback outlives the test that armed it and fires against
 * an environment whose `window` has already been torn down, which surfaces as an
 * unhandled error charged to whichever test is running at the time — every test
 * green and vitest still exit 1, in a PR that never touched this file. #2174 did
 * exactly that to PR #2170 and PR #2173 from the 150 ms press timer; this window
 * is 2000 ms, and "copy, then close the viewer" is an ordinary thing to do.
 *
 * This viewer is the reason the fix is one hook instance PER BUTTON rather than
 * per component: it shows TWO independent confirmations, content and path.
 *
 * What is asserted, in order of what would hurt most if it regressed:
 *
 *   1. The armed callback does NOT run after unmount, from either button. This
 *      is the issue.
 *   2. The two confirmations do not interfere: copying the path mid-window does
 *      not cut the content confirmation short, and each clears on its own
 *      deadline. A single shared timer would fail this.
 *   3. The visible behaviour is unchanged: the check mark appears once the
 *      clipboard write resolves and reverts exactly `COPY_FEEDBACK_RESET_MS`
 *      later, and the clipboard still receives the same text.
 *
 * Mutation-checked: deleting the unmount `clearTimeout` in `useCopyFeedback`
 * reddens (1); collapsing the two hook instances into one reddens (2).
 *
 * Real dictionary rather than the echo mock, matching `FileViewer.test.tsx` —
 * the path button is only reachable through its translated `aria-label`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import { FileViewer } from '@/components/worktree/FileViewer';
import { COPY_FEEDBACK_RESET_MS } from '@/config/ui-feedback-config';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const mockCopyToClipboard = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/clipboard-utils', () => ({
  copyToClipboard: (...args: unknown[]) => mockCopyToClipboard(...args),
}));

const FILE_PATH = 'src/components/Foo.tsx';
const FILE_CONTENT = 'const x = 1;\n';

const baseProps = {
  isOpen: true,
  onClose: vi.fn(),
  worktreeId: 'test-wt',
  filePath: FILE_PATH,
};

beforeEach(() => {
  mockCopyToClipboard.mockClear();
  mockCopyToClipboard.mockResolvedValue(undefined);
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      path: FILE_PATH,
      content: FILE_CONTENT,
      extension: 'tsx',
      worktreePath: '/wt',
    }),
  }) as unknown as typeof fetch;
  // `shouldAdvanceTime` keeps the mount fetch's promise chain resolving while
  // the copy timers stay under `advanceTimersByTime`'s control.
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
 * intercepts the 2000 ms feedback delay; every other caller is passed through
 * untouched.
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

/** Wait for the mount fetch to land, which is what renders the toolbar. */
async function waitForToolbar(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('copy-content-button')).toBeInTheDocument();
  });
}

function contentButton(): HTMLElement {
  return screen.getByTestId('copy-content-button');
}

function pathButton(): HTMLElement {
  return screen.getByLabelText('Copy file path');
}

/**
 * The confirmed state is a `Check` icon carrying `text-success`; the idle state
 * is a plain `Copy` / `ClipboardCopy` icon that does not.
 */
function isConfirmed(button: HTMLElement): boolean {
  return button.querySelector('.text-success') !== null;
}

async function click(button: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(button);
  });
}

describe('FileViewer copy confirmation survives unmount (Issue #2180)', () => {
  it('does not run the content-copy callback after the viewer unmounts', async () => {
    const feedback = trackFeedbackCallbacks();
    const { unmount } = render(<FileViewer {...baseProps} />);
    await waitForToolbar();

    await click(contentButton());
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

  it('does not run the path-copy callback after the viewer unmounts', async () => {
    const feedback = trackFeedbackCallbacks();
    const { unmount } = render(<FileViewer {...baseProps} />);
    await waitForToolbar();

    await click(pathButton());
    expect(feedback.armed).toBe(1);

    unmount();
    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS * 10);
    });
    expect(feedback.ran).toBe(0);
  });

  it('collects both timers when the viewer is closed with both confirmations up', async () => {
    const feedback = trackFeedbackCallbacks();
    const { unmount } = render(<FileViewer {...baseProps} />);
    await waitForToolbar();

    await click(contentButton());
    await click(pathButton());
    expect(feedback.armed).toBe(2);

    expect(() => {
      unmount();
      act(() => {
        vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS * 10);
      });
    }).not.toThrow();
    expect(feedback.ran).toBe(0);
  });
});

describe('FileViewer content and path confirmations are independent (Issue #2180)', () => {
  it('does not cut the content confirmation short when the path is copied', async () => {
    render(<FileViewer {...baseProps} />);
    await waitForToolbar();

    await click(contentButton());
    expect(isConfirmed(contentButton())).toBe(true);

    // Half-way through the content window, copy the path too.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await click(pathButton());
    expect(isConfirmed(pathButton())).toBe(true);
    // One shared timer would have been re-armed by this second copy, leaving the
    // content confirmation to clear 1000 ms late (or never).
    expect(isConfirmed(contentButton())).toBe(true);

    // Content's OWN deadline: it clears, the path's does not.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(isConfirmed(contentButton())).toBe(false);
    expect(isConfirmed(pathButton())).toBe(true);

    // The path's own deadline, 1000 ms after the content's.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(isConfirmed(pathButton())).toBe(false);
  });

  it('does not cut the path confirmation short when the content is copied', async () => {
    render(<FileViewer {...baseProps} />);
    await waitForToolbar();

    await click(pathButton());
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await click(contentButton());

    expect(isConfirmed(pathButton())).toBe(true);
    expect(isConfirmed(contentButton())).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(isConfirmed(pathButton())).toBe(false);
    expect(isConfirmed(contentButton())).toBe(true);
  });
});

describe('FileViewer copy confirmation is otherwise unchanged (Issue #2180)', () => {
  it('confirms the content copy and reverts after COPY_FEEDBACK_RESET_MS', async () => {
    render(<FileViewer {...baseProps} />);
    await waitForToolbar();

    expect(isConfirmed(contentButton())).toBe(false);
    await click(contentButton());
    expect(mockCopyToClipboard).toHaveBeenCalledWith(FILE_CONTENT);
    expect(isConfirmed(contentButton())).toBe(true);

    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS - 1);
    });
    expect(isConfirmed(contentButton())).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(isConfirmed(contentButton())).toBe(false);
  });

  it('confirms the path copy and reverts after COPY_FEEDBACK_RESET_MS', async () => {
    render(<FileViewer {...baseProps} />);
    await waitForToolbar();

    await click(pathButton());
    expect(mockCopyToClipboard).toHaveBeenCalledWith(FILE_PATH);
    expect(isConfirmed(pathButton())).toBe(true);

    act(() => {
      vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS - 1);
    });
    expect(isConfirmed(pathButton())).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(isConfirmed(pathButton())).toBe(false);
  });

  it('shows nothing when the clipboard write rejects', async () => {
    mockCopyToClipboard.mockRejectedValueOnce(new Error('Clipboard API failed'));
    render(<FileViewer {...baseProps} />);
    await waitForToolbar();

    await click(contentButton());

    expect(isConfirmed(contentButton())).toBe(false);
  });
});
