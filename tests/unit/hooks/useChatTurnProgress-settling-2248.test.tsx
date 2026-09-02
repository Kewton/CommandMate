/**
 * Holding the last body until the saved row arrives (Issue #2248).
 *
 * ## The defect
 *
 * `useChatTurnProgress` cleared its body the instant `enabled` went false —
 * i.e. the instant `sessionStatus` stopped being `'running'`. That is only
 * correct if the settled `chat_messages` row is guaranteed to arrive, and it is
 * not: #2246's row is written from claude's `Stop` hook and #2247 drops turns
 * outright, so on the machine this was reported from a reply the reader had
 * watched being written vanished at the moment it finished and never came back.
 *
 * So the last frame is now HELD, flagged `settling`, and released by whichever
 * of three things happens first. Two of them live here — `enabled` rising, and
 * the grace period — and the third (the saved row, and a new row appended to
 * the transcript) lives in `ChatSurface`, which is the only side that has the
 * message array.
 *
 * ## The mutation this file is the guard for
 *
 * Put `setProgress(null)` back into the `enabled` effect — the exact line
 * Issue #2248 removed — and every test in the first describe below goes red.
 *
 * ## What is deliberately NOT changed
 *
 * #2199's rule 2: a body that claims to be LIVE never survives a dropped
 * connection. A held body does, and the two cases are asserted against each
 * other below, because the distinction is the whole argument for holding at all
 * — a hold claims "not confirmed yet", which is exactly what a disconnected
 * client should be saying.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/** The realtime seam, driven by hand. */
const realtime = {
  connected: true,
  listeners: new Set<(event: unknown) => void>(),
};

vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: () => ({
    status: realtime.connected ? 'connected' : 'disconnected',
    connected: realtime.connected,
    subscribe: () => {},
    unsubscribe: () => {},
    addListener: (listener: (event: unknown) => void) => {
      realtime.listeners.add(listener);
      return () => realtime.listeners.delete(listener);
    },
  }),
}));

import {
  CHAT_TURN_SETTLING_GRACE_MS,
  useChatTurnProgress,
} from '@/hooks/useChatTurnProgress';
import { CHAT_TURN_PROGRESS_EVENT_TYPE } from '@/lib/realtime/types';

const WORKTREE_ID = 'wt-2248';
const TURN_KEY = 'claude-md:u-1';

function frame(overrides: Record<string, unknown> = {}) {
  return {
    type: CHAT_TURN_PROGRESS_EVENT_TYPE,
    worktreeId: WORKTREE_ID,
    cliToolId: 'claude',
    instanceId: 'claude',
    turnKey: TURN_KEY,
    body: 'The reply so far.',
    partial: false,
    version: 1,
    done: false,
    ...overrides,
  };
}

function push(overrides: Record<string, unknown> = {}): void {
  act(() => {
    realtime.listeners.forEach((listener) => listener(frame(overrides)));
  });
}

function mount(initial: { enabled: boolean; instanceId?: string }) {
  return renderHook(
    (props: { enabled: boolean; instanceId?: string }) =>
      useChatTurnProgress({
        worktreeId: WORKTREE_ID,
        cliToolId: 'claude',
        instanceId: props.instanceId ?? 'claude',
        enabled: props.enabled,
      }),
    { initialProps: initial },
  );
}

beforeEach(() => {
  realtime.connected = true;
  realtime.listeners.clear();
});

describe('[#2248] the body outlives the turn', () => {
  it('keeps returning the last frame after enabled goes false', () => {
    const { result, rerender } = mount({ enabled: true });
    push();
    expect(result.current?.body).toBe('The reply so far.');

    rerender({ enabled: false });

    expect(result.current?.body).toBe('The reply so far.');
    expect(result.current?.turnKey).toBe(TURN_KEY);
    expect(result.current?.version).toBe(1);
  });

  it('flags the held body so the caller can draw it without a spinner', () => {
    const { result, rerender } = mount({ enabled: true });
    push();
    expect(result.current?.settling).toBe(false);

    rerender({ enabled: false });

    expect(result.current?.settling).toBe(true);
  });

  it('keeps the partial flag on the held body', () => {
    // The reader has to keep being told the body starts mid-turn; a hold that
    // dropped the caveat would be a stronger claim than the live bubble made.
    const { result, rerender } = mount({ enabled: true });
    push({ partial: true });

    rerender({ enabled: false });

    expect(result.current?.partial).toBe(true);
  });

  it('holds the LAST frame, not the first', () => {
    const { result, rerender } = mount({ enabled: true });
    push({ version: 1, body: 'One.' });
    push({ version: 2, body: 'One.\n\nTwo.' });

    rerender({ enabled: false });

    expect(result.current?.body).toBe('One.\n\nTwo.');
  });

  it('holds nothing when the turn produced no frame at all', () => {
    // codex / antigravity, and any claude turn that ended before the first tick.
    const { result, rerender } = mount({ enabled: true });

    rerender({ enabled: false });

    expect(result.current).toBeNull();
  });

  it('returns a stable object while the hold lasts', () => {
    // `ChatSurface` memoises the transcript's `liveTurn` on this identity, and a
    // fresh copy per render would re-run the transcript's virtualizer on every
    // poll of a session that is not even generating.
    const { result, rerender } = mount({ enabled: true });
    push();
    rerender({ enabled: false });
    const first = result.current;

    rerender({ enabled: false });

    expect(result.current).toBe(first);
  });
});

describe('[#2248] release (b): a new turn starts', () => {
  it('drops the held body the moment enabled rises again', () => {
    const { result, rerender } = mount({ enabled: true });
    push();
    rerender({ enabled: false });
    expect(result.current?.body).toBe('The reply so far.');

    rerender({ enabled: true });

    expect(result.current).toBeNull();
  });

  it('takes the new turn’s frame even though its version restarts low', () => {
    // The server's counter is monotonic PER INSTANCE and does not restart with
    // the turn, but the hook's does — it is reset with the hold — so this is the
    // guard against a reset that forgets `versionRef` and swallows frame 1.
    const { result, rerender } = mount({ enabled: true });
    push({ version: 9, body: 'Turn one.' });
    rerender({ enabled: false });

    rerender({ enabled: true });
    push({ version: 1, turnKey: 'claude-md:u-2', body: 'Turn two.' });

    expect(result.current?.body).toBe('Turn two.');
    expect(result.current?.turnKey).toBe('claude-md:u-2');
    expect(result.current?.settling).toBe(false);
  });
});

describe('[#2248] release (c): the grace period', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('states the grace period the Issue chose', () => {
    // An absolute number, never derived: a test written as
    // `CHAT_TURN_SETTLING_GRACE_MS - 1` stays true for any value including 0,
    // which is exactly the mutation the timing tests below have to catch.
    expect(CHAT_TURN_SETTLING_GRACE_MS).toBe(600_000);
  });

  it('still holds the body one millisecond before the grace runs out', () => {
    const { result, rerender } = mount({ enabled: true });
    push();
    rerender({ enabled: false });

    act(() => {
      vi.advanceTimersByTime(599_999);
    });

    expect(result.current?.body).toBe('The reply so far.');
  });

  it('drops it once the grace has passed', () => {
    const { result, rerender } = mount({ enabled: true });
    push();
    rerender({ enabled: false });

    act(() => {
      vi.advanceTimersByTime(600_000);
    });

    expect(result.current).toBeNull();
  });

  it('arms no timer while the turn is still generating', () => {
    // A body on screen for a running turn must never expire underneath it.
    const { result } = mount({ enabled: true });
    push();

    act(() => {
      vi.advanceTimersByTime(600_000 * 5);
    });

    expect(result.current?.body).toBe('The reply so far.');
  });
});

describe('[#2248] the connection, live versus held', () => {
  it('drops a LIVE body when the push connection goes down (#2199 rule 2)', () => {
    const { result, rerender } = mount({ enabled: true });
    push();

    realtime.connected = false;
    rerender({ enabled: true });

    expect(result.current).toBeNull();
  });

  it('holds nothing afterwards, because the live body was cleared not hidden', () => {
    const { result, rerender } = mount({ enabled: true });
    push();
    realtime.connected = false;
    rerender({ enabled: true });

    rerender({ enabled: false });

    expect(result.current).toBeNull();
  });

  it('keeps a HELD body across a drop', () => {
    // The decision Issue #2248 records: rule 2 protects against a stale
    // paragraph CLAIMING TO BE LIVE, and a held one claims the opposite. A drop
    // is also the moment there is no second copy — the server publishes the next
    // frame it produces and never replays the one that was missed.
    const { result, rerender } = mount({ enabled: true });
    push();
    rerender({ enabled: false });

    realtime.connected = false;
    rerender({ enabled: false });

    expect(result.current?.body).toBe('The reply so far.');
    expect(result.current?.settling).toBe(true);
  });
});

describe('[#2248] the hold is per instance', () => {
  it('does not carry one instance’s held body to another', () => {
    // Two agents share a worktree room and a split can be re-pointed at either.
    const { result, rerender } = mount({ enabled: true, instanceId: 'claude' });
    push();
    rerender({ enabled: false, instanceId: 'claude' });
    expect(result.current?.body).toBe('The reply so far.');

    rerender({ enabled: false, instanceId: 'claude-2' });

    expect(result.current).toBeNull();
  });

  it('holds nothing from a frame addressed to the sibling instance', () => {
    const { result, rerender } = mount({ enabled: true, instanceId: 'claude' });
    push({ instanceId: 'claude-2', body: 'the other agent’s reply' });

    rerender({ enabled: false, instanceId: 'claude' });

    expect(result.current).toBeNull();
  });
});
