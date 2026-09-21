/**
 * `useDirectInput`'s two additions for the phone keyboard (Issue #2799 §9).
 *
 * `sendAndWait` rides the same queue and the same one-request-in-flight rule
 * as `send`, and resolves with the verdict of the request(s) that carried ITS
 * events; `isSending` is true while such a call waits. The existing `send` /
 * `error` contract is pinned by `useDirectInput-2766.test.ts`, which this Issue
 * leaves untouched — this file pins what was added, including the two
 * properties a careless implementation would break:
 *
 *  - the verdict is attributed per call, even when a plain `send` shares the
 *    queue (and a call whose events were discarded unsent gets `false`);
 *  - `send` still costs no render: PC's `DirectInputBar` is an uncontrolled
 *    input built on that, and a shared in-flight flag in state would give it
 *    two renders per keystroke.
 *
 * `fetch` never settles by itself; each test decides when a response lands.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDirectInput, DIRECT_INPUT_ERROR_KEY } from '@/hooks/useDirectInput';
import { MAX_DIRECT_INPUT_EVENTS, type DirectInputEvent } from '@/types/direct-input';

const WORKTREE_ID = 'wt-2799';

interface PendingCall {
  body: { cliToolId: string; events: DirectInputEvent[]; instanceId?: string };
  settle: (init?: { ok?: boolean; status?: number }) => void;
  fail: () => void;
}

let calls: PendingCall[] = [];

function installManualFetch(): void {
  global.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    let settle!: PendingCall['settle'];
    let fail!: PendingCall['fail'];
    const promise = new Promise<Response>((resolve, reject) => {
      settle = ({ ok = true, status = 200 } = {}) =>
        resolve({ ok, status, json: async () => ({ success: ok }) } as Response);
      fail = () => reject(new Error('network down'));
    });
    calls.push({ body: JSON.parse(String(init?.body ?? '{}')), settle, fail });
    return promise;
  }) as unknown as typeof fetch;
}

function textEvents(n: number, offset = 0): DirectInputEvent[] {
  return Array.from({ length: n }, (_, i) => ({ type: 'text', text: `k${offset + i}` }) as const);
}

/** A promise's state without awaiting it forever. */
async function peek<T>(promise: Promise<T>): Promise<{ settled: boolean; value?: T }> {
  const pending = Symbol('pending');
  const value = await Promise.race([promise, Promise.resolve(pending)]);
  return value === pending ? { settled: false } : { settled: true, value: value as T };
}

beforeEach(() => {
  calls = [];
  installManualFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('[#2799] sendAndWait', () => {
  it('sends the events as one request and resolves true when it lands', async () => {
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'claude'));
    const events: DirectInputEvent[] = [{ type: 'key', key: 'Down' }, { type: 'text', text: 'yes' }];

    let verdict!: Promise<boolean>;
    act(() => {
      verdict = result.current.sendAndWait(events);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ cliToolId: 'claude', events });
    expect(result.current.isSending).toBe(true);
    expect((await peek(verdict)).settled).toBe(false);

    await act(async () => calls[0].settle());
    await expect(verdict).resolves.toBe(true);
    expect(result.current.isSending).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('resolves false on a non-2xx, raises the same error as send, and clears isSending', async () => {
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'claude'));

    let verdict!: Promise<boolean>;
    act(() => {
      verdict = result.current.sendAndWait([{ type: 'key', key: 'Enter' }]);
    });
    await act(async () => calls[0].settle({ ok: false, status: 404 }));

    await expect(verdict).resolves.toBe(false);
    expect(result.current.isSending).toBe(false);
    expect(result.current.error).toBe(DIRECT_INPUT_ERROR_KEY);
  });

  it('resolves false on a rejected fetch', async () => {
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'claude'));
    let verdict!: Promise<boolean>;
    act(() => {
      verdict = result.current.sendAndWait([{ type: 'key', key: 'Enter' }]);
    });
    await act(async () => calls[0].fail());
    await expect(verdict).resolves.toBe(false);
  });

  it('resolves true for an empty list without a request', async () => {
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'claude'));
    await expect(result.current.sendAndWait([])).resolves.toBe(true);
    expect(calls).toHaveLength(0);
    expect(result.current.isSending).toBe(false);
  });

  it('carries instanceId the way send does (Issue #869 body shape)', async () => {
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'claude', 'claude-2'));
    let verdict!: Promise<boolean>;
    act(() => {
      verdict = result.current.sendAndWait([{ type: 'key', key: 'Escape' }]);
    });
    expect(calls[0].body.instanceId).toBe('claude-2');
    await act(async () => calls[0].settle());
    await expect(verdict).resolves.toBe(true);
  });
});

describe('[#2799] attribution when send and sendAndWait share the queue', () => {
  it('waits behind an open send request, then reports its OWN request', async () => {
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'claude'));

    act(() => result.current.send([{ type: 'text', text: 'a' }]));
    let verdict!: Promise<boolean>;
    act(() => {
      verdict = result.current.sendAndWait([{ type: 'key', key: 'Enter' }]);
    });
    // Still one open request: the invariant is shared.
    expect(calls).toHaveLength(1);

    await act(async () => calls[0].settle());
    // The send's success is not this call's success.
    expect((await peek(verdict)).settled).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.events).toEqual([{ type: 'key', key: 'Enter' }]);

    await act(async () => calls[1].settle());
    await expect(verdict).resolves.toBe(true);
  });

  it('resolves false when an earlier send fails and its events are discarded unsent', async () => {
    // The path the phone keyboard can never take (it uses only sendAndWait, and
    // disables its keys while sending) — pinned so its answer is not a guess.
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'claude'));

    act(() => result.current.send([{ type: 'text', text: 'a' }]));
    let verdict!: Promise<boolean>;
    act(() => {
      verdict = result.current.sendAndWait([{ type: 'key', key: 'Enter' }]);
    });
    await act(async () => calls[0].settle({ ok: false, status: 500 }));

    await expect(verdict).resolves.toBe(false);
    // Never left: the queue was dropped, as for send (#2766).
    expect(calls).toHaveLength(1);
    expect(result.current.isSending).toBe(false);
  });

  it('succeeds only once the LAST of its events lands when the cap splits them', async () => {
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'claude'));

    act(() => result.current.send([{ type: 'text', text: 'first' }]));
    act(() => result.current.send(textEvents(MAX_DIRECT_INPUT_EVENTS - 2)));
    const mine = textEvents(5, 100);
    let verdict!: Promise<boolean>;
    act(() => {
      verdict = result.current.sendAndWait(mine);
    });

    await act(async () => calls[0].settle());
    // Request 2: 30 of the send's + the first 2 of mine.
    expect(calls[1].body.events).toHaveLength(MAX_DIRECT_INPUT_EVENTS);
    expect(calls[1].body.events.slice(-2)).toEqual(mine.slice(0, 2));
    await act(async () => calls[1].settle());
    expect((await peek(verdict)).settled).toBe(false);

    // Request 3: the rest of mine.
    expect(calls[2].body.events).toEqual(mine.slice(2));
    await act(async () => calls[2].settle({ ok: false, status: 503 }));
    await expect(verdict).resolves.toBe(false);
  });

  it('gives each of two sendAndWait calls its own verdict', async () => {
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'claude'));

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.sendAndWait([{ type: 'key', key: 'Up' }]);
    });
    act(() => {
      second = result.current.sendAndWait([{ type: 'key', key: 'Down' }]);
    });

    await act(async () => calls[0].settle());
    await expect(first).resolves.toBe(true);
    expect(result.current.isSending).toBe(true); // `second` is still waiting

    await act(async () => calls[1].settle({ ok: false, status: 500 }));
    await expect(second).resolves.toBe(false);
    expect(result.current.isSending).toBe(false);
  });

  it('is one request per call when calls are serialised — the phone keyboard\'s only use', async () => {
    const { result } = renderHook(() => useDirectInput(WORKTREE_ID, 'claude'));
    for (let round = 0; round < 3; round++) {
      const staged = textEvents(MAX_DIRECT_INPUT_EVENTS, round * 100);
      let verdict!: Promise<boolean>;
      act(() => {
        verdict = result.current.sendAndWait(staged);
      });
      expect(calls).toHaveLength(round + 1);
      expect(calls[round].body.events).toEqual(staged);
      await act(async () => calls[round].settle());
      await expect(verdict).resolves.toBe(true);
    }
  });
});

describe('[#2799] isSending leaves the send path alone', () => {
  it('never moves for send, however many times it is called', async () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useDirectInput(WORKTREE_ID, 'claude');
    });
    const before = renders;

    for (let i = 0; i < 10; i++) {
      act(() => result.current.send([{ type: 'text', text: String(i) }]));
      expect(result.current.isSending).toBe(false);
    }
    await act(async () => calls[0].settle());
    await act(async () => calls[1].settle());

    // The PC bar's invariant (DirectInputBar.tsx): a keystroke costs no render.
    expect(renders).toBe(before);
    expect(result.current.isSending).toBe(false);
  });

  it('does re-render for sendAndWait — the flag the phone disables its keys with', async () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useDirectInput(WORKTREE_ID, 'claude');
    });
    const before = renders;
    let verdict!: Promise<boolean>;
    act(() => {
      verdict = result.current.sendAndWait([{ type: 'key', key: 'Enter' }]);
    });
    expect(renders).toBeGreaterThan(before);
    await act(async () => calls[0].settle());
    await verdict;
  });
});

describe('[#2799] unmount', () => {
  it('writes no state when the verdict lands after unmount, and still resolves', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useDirectInput(WORKTREE_ID, 'claude'));

    let verdict!: Promise<boolean>;
    act(() => {
      verdict = result.current.sendAndWait([{ type: 'key', key: 'Escape' }]);
    });
    unmount();
    await act(async () => calls[0].fail());

    await expect(verdict).resolves.toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
