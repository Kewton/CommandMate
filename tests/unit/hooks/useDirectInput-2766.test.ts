/**
 * `useDirectInput` keeps direct input in the order it was typed (Issue #2766).
 *
 * The bug this suite is written against does not look like a bug in a browser
 * that is behaving: fire one `fetch` per `keydown`, as `useSpecialKeys` does,
 * and `abcdefghij` usually arrives as `abcdefghij`. It arrives as something
 * else exactly when it matters — a slow tunnel, a busy server, a `Ctrl+A`
 * overtaking the `Enter` that was meant to follow it — and tmux keeps no
 * sequence number to repair it with. The pane read what landed.
 *
 * So the invariant is structural rather than statistical, and every test below
 * drives `fetch` by hand instead of letting it settle on its own:
 *
 *  - **at most one request is open at a time**, and what the user typed while
 *    it was open leaves in the NEXT one, in order;
 *  - a batch never exceeds `MAX_DIRECT_INPUT_EVENTS`, which the route rejects;
 *  - a failure throws the queue away rather than replaying it into whatever is
 *    on screen by then;
 *  - nothing is written into an unmounted tree (#2176).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useDirectInput, DIRECT_INPUT_ERROR_KEY } from '@/hooks/useDirectInput';
import { MAX_DIRECT_INPUT_EVENTS, type DirectInputEvent } from '@/types/direct-input';
import { NAV_KEY_REFRESH_DELAY_MS } from '@/config/ui-feedback-config';

const WORKTREE_ID = 'wt-2766';

interface PendingCall {
  url: string;
  body: { cliToolId: string; events: DirectInputEvent[]; instanceId?: string };
  /** Settle this request as the server would. */
  settle: (init?: { ok?: boolean; status?: number }) => void;
  /** Settle it the way a dropped connection does. */
  fail: (error?: unknown) => void;
}

let calls: PendingCall[] = [];

/**
 * A `fetch` that never resolves by itself.
 *
 * Every assertion about ordering here depends on the test deciding WHEN a
 * response lands; an auto-resolving stub would make "one at a time" true by
 * accident on a fast machine and flaky on a slow one.
 */
function installManualFetch(): void {
  global.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    let settle!: PendingCall['settle'];
    let fail!: PendingCall['fail'];
    const promise = new Promise<Response>((resolve, reject) => {
      settle = ({ ok = true, status = 200 } = {}) =>
        resolve({ ok, status, json: async () => ({ success: ok }) } as Response);
      fail = (error = new Error('network down')) => reject(error);
    });
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')),
      settle,
      fail,
    });
    return promise;
  }) as unknown as typeof fetch;
}

/** `n` distinguishable text events, so a reordering is visible in the diff. */
function textEvents(n: number, offset = 0): DirectInputEvent[] {
  return Array.from({ length: n }, (_, i) => ({ type: 'text', text: `k${offset + i}` }) as const);
}

/** Every event that has actually left, flattened in request order. */
function sentEvents(): DirectInputEvent[] {
  return calls.flatMap((call) => call.body.events);
}

beforeEach(() => {
  calls = [];
  installManualFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('[#2766] the request body', () => {
  it('posts to the direct-input route with the events it was given', async () => {
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'command-code'));

    act(() => result.current.send([{ type: 'key', key: 'C-a' }]));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`/api/worktrees/${WORKTREE_ID}/direct-input`);
    expect(calls[0].body).toEqual({
      cliToolId: 'command-code',
      events: [{ type: 'key', key: 'C-a' }],
    });
    await act(async () => calls[0].settle());
  });

  it('omits instanceId for the primary instance and carries it for any other', async () => {
    // Issue #869's rule, restated byte-for-byte: `instanceId === cliToolId` is
    // the primary and must produce the SAME body a pre-#869 caller produced.
    const primary = renderHook(() => useDirectInput(WORKTREE_ID, 'command-code', 'command-code'));
    act(() => primary.result.current.send([{ type: 'text', text: 'a' }]));
    expect(calls[0].body.instanceId).toBeUndefined();
    expect(Object.keys(calls[0].body).sort()).toEqual(['cliToolId', 'events']);
    await act(async () => calls[0].settle());

    const secondary = renderHook(() => useDirectInput(WORKTREE_ID, 'command-code', 'command-code-2'));
    act(() => secondary.result.current.send([{ type: 'text', text: 'a' }]));
    expect(calls[1].body.instanceId).toBe('command-code-2');
    await act(async () => calls[1].settle());
  });

  it('sends nothing at all for an empty event list', async () => {
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'command-code'));
    act(() => result.current.send([]));
    expect(calls).toHaveLength(0);
  });
});

describe('[#2766] ordering', () => {
  it('holds keys typed during a request and sends them as one batch, in order', async () => {
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'command-code'));

    act(() => result.current.send([{ type: 'text', text: 'a' }]));
    expect(calls).toHaveLength(1);

    // Three more presses while the first request is still open. Each one would
    // be its own `fetch` under the `useSpecialKeys` shape, and the four would
    // then race.
    act(() => result.current.send([{ type: 'text', text: 'b' }]));
    act(() => result.current.send([{ type: 'text', text: 'c' }]));
    act(() => result.current.send([{ type: 'key', key: 'Enter' }]));
    expect(calls).toHaveLength(1);

    await act(async () => calls[0].settle());

    expect(calls).toHaveLength(2);
    expect(calls[1].body.events).toEqual([
      { type: 'text', text: 'b' },
      { type: 'text', text: 'c' },
      { type: 'key', key: 'Enter' },
    ]);
    await act(async () => calls[1].settle());
    expect(calls).toHaveLength(2);
  });

  it('keeps exactly one request open while ten keys are typed back to back', async () => {
    // The acceptance criterion's `abcdefghij` inside a second, with the network
    // never getting a chance to drain between presses. Ten `send` calls, and
    // the count of requests is what says whether they raced: one open now, one
    // carrying the other nine afterwards.
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'command-code'));
    const typed = textEvents(10);

    act(() => {
      for (const event of typed) result.current.send([event]);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.events).toEqual([typed[0]]);

    await act(async () => calls[0].settle());
    expect(calls).toHaveLength(2);
    expect(calls[1].body.events).toEqual(typed.slice(1));

    await act(async () => calls[1].settle());
    expect(calls).toHaveLength(2);
    expect(sentEvents()).toEqual(typed);
  });

  it('splits an over-long queue across requests and still flies one at a time', async () => {
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'command-code'));

    act(() => result.current.send([{ type: 'text', text: 'first' }]));
    expect(calls).toHaveLength(1);

    const overflow = textEvents(MAX_DIRECT_INPUT_EVENTS + 2);
    act(() => result.current.send(overflow));
    // Still one: the queue does not get its own connection.
    expect(calls).toHaveLength(1);

    await act(async () => calls[0].settle());
    expect(calls).toHaveLength(2);
    expect(calls[1].body.events).toHaveLength(MAX_DIRECT_INPUT_EVENTS);
    expect(calls[1].body.events).toEqual(overflow.slice(0, MAX_DIRECT_INPUT_EVENTS));

    await act(async () => calls[1].settle());
    expect(calls).toHaveLength(3);
    expect(calls[2].body.events).toEqual(overflow.slice(MAX_DIRECT_INPUT_EVENTS));

    await act(async () => calls[2].settle());
    expect(calls).toHaveLength(3);
    expect(sentEvents()).toEqual([{ type: 'text', text: 'first' }, ...overflow]);
  });
});

describe('[#2766] the refresh callback', () => {
  it('fires once the queue is empty, after the tmux settle delay', async () => {
    const onSent = vi.fn();
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'command-code', undefined, onSent));

    act(() => result.current.send([{ type: 'text', text: 'a' }]));
    act(() => result.current.send([{ type: 'text', text: 'b' }]));

    await act(async () => calls[0].settle());
    // The queue still has 'b' in it — refreshing here would paint a frame that
    // is already stale.
    expect(onSent).not.toHaveBeenCalled();

    await act(async () => calls[1].settle());
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });
});

describe('[#2766] failure', () => {
  it('drops the queue, raises the error, and clears it on the next send', async () => {
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'command-code'));

    act(() => result.current.send([{ type: 'text', text: 'a' }]));
    act(() => result.current.send([{ type: 'key', key: 'Enter' }]));

    await act(async () => calls[0].settle({ ok: false, status: 404 }));

    // The Enter is gone on purpose: it was aimed at the screen the user was
    // looking at, and replaying it now is the stray keystroke #1017 guards
    // against.
    expect(calls).toHaveLength(1);
    await waitFor(() => expect(result.current.error).toBe(DIRECT_INPUT_ERROR_KEY));

    act(() => result.current.send([{ type: 'text', text: 'b' }]));
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(calls).toHaveLength(2);
    expect(calls[1].body.events).toEqual([{ type: 'text', text: 'b' }]);
    await act(async () => calls[1].settle());
  });

  it('treats a rejected fetch the same way a non-2xx is treated', async () => {
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'command-code'));

    act(() => result.current.send([{ type: 'text', text: 'a' }]));
    act(() => result.current.send([{ type: 'text', text: 'b' }]));
    await act(async () => calls[0].fail());

    expect(calls).toHaveLength(1);
    await waitFor(() => expect(result.current.error).toBe(DIRECT_INPUT_ERROR_KEY));
  });

  it('does not refresh after a failure', async () => {
    const onSent = vi.fn();
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'command-code', undefined, onSent));

    act(() => result.current.send([{ type: 'text', text: 'a' }]));
    await act(async () => calls[0].fail());
    await new Promise((resolve) => setTimeout(resolve, NAV_KEY_REFRESH_DELAY_MS * 3));
    expect(onSent).not.toHaveBeenCalled();
  });
});

describe('[#2766] unmount (Issue #2176)', () => {
  it('never runs the refresh timer after the bar is gone', async () => {
    // The observable half of "do not touch state after unmount": the keys that
    // travel through this hook are the ones that dismiss the overlay the bar is
    // mounted under, so press and unmount are routinely the same gesture.
    const onSent = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = renderHook(() =>
      useDirectInput(WORKTREE_ID, 'command-code', undefined, onSent),
    );

    act(() => result.current.send([{ type: 'key', key: 'Escape' }]));
    unmount();
    await act(async () => calls[0].settle());
    await new Promise((resolve) => setTimeout(resolve, NAV_KEY_REFRESH_DELAY_MS * 3));

    expect(onSent).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('swallows a failure that lands after unmount', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useDirectInput(WORKTREE_ID, 'command-code'));

    act(() => result.current.send([{ type: 'text', text: 'a' }]));
    unmount();
    await act(async () => calls[0].fail());

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
