/**
 * The shared `chat_turn_progress` generator (Issue #2199).
 *
 * One builder, two producers: claude's poller tick reads a transcript, opencode's
 * SSE reader renders an accumulator, and both hand the result to
 * {@link buildChatTurnProgress}. Everything asserted here is a property the wire
 * needs and neither producer could enforce on its own — which is the whole
 * argument for the generator being shared rather than written twice.
 *
 * Four of them, and each one has a specific way of going wrong:
 *
 *  1. **The throttle bounds how often the SOURCE IS ASKED**, not merely how often
 *     a frame is sent. The claude source is a 4 MiB read and a JSONL parse; a
 *     gate on the send would pay for it on every HTTP poll and then throw the
 *     answer away. So the call count of the source is what is asserted, not the
 *     frame count. Set `CHAT_TURN_PROGRESS_MIN_INTERVAL_MS` to 0 and the first
 *     two tests here go red — Issue #2199's mutation-injection criterion.
 *  2. **An unchanged body sends nothing.** opencode re-sends its boundary frames
 *     byte-identically (measured, `sources/opencode/transcript`), so "the
 *     accumulator was touched" is not "the reply grew".
 *  3. **The size bound keeps the TAIL.** The two turn writers keep the head
 *     because they are recording a reply; this is showing one being written, and
 *     the end the model is still adding to is the half worth having. A cut that
 *     is not reported is the failure — the flag has to reach the wire.
 *  4. **`version` is monotonic per instance and NOT per turn.** Restarting the
 *     counter on a new turn makes frame 1 of turn N+1 look stale against frame 40
 *     of turn N, and the client's stale-drop rule would swallow it.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const broadcast = vi.fn();
const hasRoomSubscribers = vi.fn((_worktreeId: string) => true);
vi.mock('@/lib/ws-server', () => ({
  broadcast: (...args: unknown[]) => broadcast(...args),
  hasRoomSubscribers: (worktreeId: string) => hasRoomSubscribers(worktreeId),
}));

import {
  buildChatTurnProgress,
  emitChatTurnProgress,
  resetChatTurnProgressState,
  type ChatTurnProgressDraft,
} from '@/lib/session/current-output-builder';
import {
  CHAT_TURN_PROGRESS_EVENT_TYPE,
  CHAT_TURN_PROGRESS_MIN_INTERVAL_MS,
  MAX_CHAT_TURN_PROGRESS_BODY_LENGTH,
  truncateChatTurnProgressBody,
  type ChatTurnProgressEvent,
} from '@/lib/realtime/types';

const TARGET = { worktreeId: 'wt-2199', cliToolId: 'claude', instanceId: 'claude' } as const;
const SIBLING = { worktreeId: 'wt-2199', cliToolId: 'claude', instanceId: 'claude-2' } as const;
const TURN = 'claude-md:u-1';

/** A source that always answers the same draft and counts how often it was asked. */
function countingSource(draft: ChatTurnProgressDraft) {
  const asked = vi.fn(() => draft);
  return { asked, source: () => asked() };
}

beforeEach(() => {
  vi.clearAllMocks();
  hasRoomSubscribers.mockReturnValue(true);
  resetChatTurnProgressState();
});

afterEach(() => {
  resetChatTurnProgressState();
});

describe('[#2199] throttle', () => {
  // Every timestamp below is an ABSOLUTE millisecond, never one derived from
  // CHAT_TURN_PROGRESS_MIN_INTERVAL_MS. Deriving them is what makes a throttle
  // test vacuous: `1_000 + INTERVAL - 1` moves with the constant, so setting the
  // constant to 0 leaves the assertion true and the mutation undetected.
  it('states the interval the Issue requires', () => {
    expect(CHAT_TURN_PROGRESS_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(1_000);
  });

  it('asks the source at most once within one second', async () => {
    const { asked, source } = countingSource({ turnKey: TURN, body: 'one' });

    await buildChatTurnProgress(TARGET, source, 1_000);
    await buildChatTurnProgress(TARGET, source, 1_500);
    await buildChatTurnProgress(TARGET, source, 1_999);

    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('asks again once a second has elapsed', async () => {
    const bodies = ['one', 'one two', 'one two three'];
    let index = 0;
    const source = () => ({ turnKey: TURN, body: bodies[index++] });

    const first = await buildChatTurnProgress(TARGET, source, 1_000);
    const blocked = await buildChatTurnProgress(TARGET, source, 1_500);
    const second = await buildChatTurnProgress(TARGET, source, 2_000);

    expect(first?.body).toBe('one');
    expect(blocked).toBeNull();
    expect(second?.body).toBe('one two');
  });

  it('throttles each instance separately', async () => {
    // Two agents in one worktree share a room but not a reply. A throttle keyed
    // on the worktree alone would let one instance's tick starve the other's.
    const a = await buildChatTurnProgress(TARGET, () => ({ turnKey: TURN, body: 'a' }), 1_000);
    const b = await buildChatTurnProgress(SIBLING, () => ({ turnKey: 'k2', body: 'b' }), 1_000);

    expect(a?.instanceId).toBe('claude');
    expect(b?.instanceId).toBe('claude-2');
  });
});

describe('[#2199] nothing new to say', () => {
  it('sends no frame when the body has not changed', async () => {
    const draft = { turnKey: TURN, body: 'unchanged' };
    const first = await buildChatTurnProgress(TARGET, () => draft, 1_000);
    const repeat = await buildChatTurnProgress(TARGET, () => draft, 9_000);

    expect(first).not.toBeNull();
    expect(repeat).toBeNull();
  });

  it('does send when the same body arrives under a NEW turn key', async () => {
    // Two prompts that happen to produce the same first paragraph are two turns,
    // and the second one has to reach the client or its bubble never opens.
    const first = await buildChatTurnProgress(TARGET, () => ({ turnKey: 'k1', body: 'hi' }), 1_000);
    const second = await buildChatTurnProgress(TARGET, () => ({ turnKey: 'k2', body: 'hi' }), 9_000);

    expect(first?.turnKey).toBe('k1');
    expect(second?.turnKey).toBe('k2');
  });

  it('sends nothing for a source that answers null or an empty body', async () => {
    expect(await buildChatTurnProgress(TARGET, () => null, 1_000)).toBeNull();
    expect(await buildChatTurnProgress(TARGET, () => ({ turnKey: TURN, body: '' }), 9_000)).toBeNull();
  });

  it('survives a source that throws', async () => {
    const event = await buildChatTurnProgress(
      TARGET,
      () => {
        throw new Error('transcript vanished mid-read');
      },
      1_000,
    );
    expect(event).toBeNull();
  });
});

describe('[#2199] the size bound', () => {
  it('keeps the tail and reports the cut', () => {
    const body = 'x'.repeat(MAX_CHAT_TURN_PROGRESS_BODY_LENGTH) + 'TAIL';
    const bounded = truncateChatTurnProgressBody(body);

    expect(bounded.truncated).toBe(true);
    expect(bounded.body.length).toBe(MAX_CHAT_TURN_PROGRESS_BODY_LENGTH);
    expect(bounded.body.endsWith('TAIL')).toBe(true);
  });

  it('leaves a body that fits completely alone', () => {
    expect(truncateChatTurnProgressBody('short')).toEqual({ body: 'short', truncated: false });
  });

  it('publishes the cut as `partial` on the frame', async () => {
    const event = await buildChatTurnProgress(
      TARGET,
      () => ({ turnKey: TURN, body: 'y'.repeat(MAX_CHAT_TURN_PROGRESS_BODY_LENGTH + 10) }),
      1_000,
    );

    expect(event?.body.length).toBe(MAX_CHAT_TURN_PROGRESS_BODY_LENGTH);
    expect(event?.partial).toBe(true);
  });

  it("carries the reader's own `partial` through untouched", async () => {
    // The claude tail window is the other cause, and the reader is the only
    // layer that can see it.
    const event = await buildChatTurnProgress(
      TARGET,
      () => ({ turnKey: TURN, body: 'from the middle', partial: true }),
      1_000,
    );
    expect(event?.partial).toBe(true);
  });

  it('says `partial: false` when nothing was cut at either layer', async () => {
    const event = await buildChatTurnProgress(TARGET, () => ({ turnKey: TURN, body: 'all of it' }), 1_000);
    expect(event?.partial).toBe(false);
  });
});

describe('[#2199] version', () => {
  it('increases by one per published frame and never restarts on a new turn', async () => {
    const versions: number[] = [];
    let at = 1_000;
    for (const draft of [
      { turnKey: 'k1', body: 'a' },
      { turnKey: 'k1', body: 'ab' },
      { turnKey: 'k2', body: 'c' },
      { turnKey: 'k2', body: 'cd' },
    ]) {
      const event = await buildChatTurnProgress(TARGET, () => draft, at);
      if (event) versions.push(event.version);
      at += CHAT_TURN_PROGRESS_MIN_INTERVAL_MS;
    }

    expect(versions).toEqual([1, 2, 3, 4]);
  });

  it('does not burn a version on a frame that was suppressed', async () => {
    const first = await buildChatTurnProgress(TARGET, () => ({ turnKey: TURN, body: 'a' }), 1_000);
    await buildChatTurnProgress(TARGET, () => ({ turnKey: TURN, body: 'a' }), 3_000);
    const next = await buildChatTurnProgress(TARGET, () => ({ turnKey: TURN, body: 'ab' }), 5_000);

    expect(first?.version).toBe(1);
    expect(next?.version).toBe(2);
  });

  it('counts each instance on its own', async () => {
    const a = await buildChatTurnProgress(TARGET, () => ({ turnKey: 'k1', body: 'a' }), 1_000);
    const b = await buildChatTurnProgress(SIBLING, () => ({ turnKey: 'k2', body: 'b' }), 1_000);
    expect(a?.version).toBe(1);
    expect(b?.version).toBe(1);
  });
});

describe('[#2199] the frame that goes on the wire', () => {
  it('carries the shape the client contract declares', async () => {
    const event = (await buildChatTurnProgress(
      TARGET,
      () => ({ turnKey: TURN, body: '# heading' }),
      1_000,
    )) as ChatTurnProgressEvent;

    expect(event).toMatchObject({
      type: CHAT_TURN_PROGRESS_EVENT_TYPE,
      worktreeId: 'wt-2199',
      cliToolId: 'claude',
      instanceId: 'claude',
      turnKey: TURN,
      body: '# heading',
      done: false,
    });
  });

  it('resolves an absent instanceId the way the broadcaster does', async () => {
    const event = await buildChatTurnProgress(
      { worktreeId: 'wt-2199', cliToolId: 'opencode' },
      () => ({ turnKey: 'agent-md:msg_1', body: 'hi' }),
      1_000,
    );
    expect(event?.instanceId).toBe('opencode');
  });
});

describe('[#2199] emitChatTurnProgress', () => {
  it('broadcasts the frame to the worktree room', async () => {
    const sent = await emitChatTurnProgress(TARGET, () => ({ turnKey: TURN, body: 'live' }), 1_000);

    expect(sent).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(
      'wt-2199',
      expect.objectContaining({ type: CHAT_TURN_PROGRESS_EVENT_TYPE, body: 'live' }),
    );
  });

  it('never asks the source when nobody is subscribed to the room', async () => {
    // The point of the check: a claude session nobody is watching must not pay
    // for a 4 MiB transcript read every poll tick.
    hasRoomSubscribers.mockReturnValue(false);
    const { asked, source } = countingSource({ turnKey: TURN, body: 'live' });

    const sent = await emitChatTurnProgress(TARGET, source, 1_000);

    expect(sent).toBe(false);
    expect(asked).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('leaves the throttle untouched when the room is empty', async () => {
    // Otherwise a browser that subscribes one tick later would find the gate
    // already closed by a tick that produced nothing.
    hasRoomSubscribers.mockReturnValue(false);
    await emitChatTurnProgress(TARGET, () => ({ turnKey: TURN, body: 'a' }), 1_000);

    hasRoomSubscribers.mockReturnValue(true);
    const sent = await emitChatTurnProgress(TARGET, () => ({ turnKey: TURN, body: 'a' }), 1_100);

    expect(sent).toBe(true);
  });

  it('broadcasts nothing when there is no new frame', async () => {
    await emitChatTurnProgress(TARGET, () => ({ turnKey: TURN, body: 'a' }), 1_000);
    broadcast.mockClear();

    const sent = await emitChatTurnProgress(TARGET, () => ({ turnKey: TURN, body: 'a' }), 9_000);

    expect(sent).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
