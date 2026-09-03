/**
 * Pushing opencode's reply as it is written (Issue #2199).
 *
 * opencode is the push half of this Issue and needs no reader of its own: the
 * accumulator `sources/opencode/history` already keeps for the *saved* row is
 * the same object the live body is rendered from, through the same
 * `renderOpencodeTurn`. This file pins that it actually happens, and the three
 * properties that follow from doing it this way:
 *
 *  1. **The body grows across frames.** Two `message.part.updated` for two parts
 *     of one turn must produce a longer body the second time — that is the
 *     feature.
 *  2. **A re-sent boundary frame publishes nothing.** Measured on 1.18.22: a
 *     text part arrives once empty and once whole, and the boundary frames are
 *     re-sent byte-identically. The accumulator overwrites the repeat into the
 *     same `prt_…` slot, so the render is identical and the shared builder's
 *     no-change rule drops it. Nothing here is a dedup set — that is the point.
 *  3. **The key is the one the settled row will carry**, so the client's swap is
 *     a string comparison against `chat_messages.request_id`.
 *
 * The database is not mocked because this path does not reach it: the progress
 * push writes nothing, which is asserted below.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const broadcast = vi.fn();
const hasRoomSubscribers = vi.fn((_worktreeId: string) => true);
vi.mock('@/lib/ws-server', () => ({
  broadcast: (...args: unknown[]) => broadcast(...args),
  hasRoomSubscribers: (worktreeId: string) => hasRoomSubscribers(worktreeId),
  broadcastMessage: vi.fn(),
}));

import {
  forgetOpencodeTranscripts,
  recordOpencodeTranscriptFrame,
} from '@/lib/hooks/sources/opencode/history';
import type { OpencodeFrame } from '@/lib/hooks/sources/opencode/client';
import { resetChatTurnProgressState } from '@/lib/session/current-output-builder';
import { opencodeTurnRequestId } from '@/types/agent-transcript';
import {
  CHAT_TURN_PROGRESS_EVENT_TYPE,
  CHAT_TURN_PROGRESS_MIN_INTERVAL_MS,
  type ChatTurnProgressEvent,
} from '@/lib/realtime/types';

const TARGET = { worktreeId: 'wt-2199', cliToolId: 'opencode', instanceId: 'opencode' } as const;
const SESSION = 'ses_0000000000000000000000000';
const USER_MESSAGE = 'msg_user1';

function frame(type: string, properties: Record<string, unknown>): OpencodeFrame {
  return { id: 'evt_0000000000000000000000000', type, properties } as unknown as OpencodeFrame;
}

const OPEN_TURN = frame('message.updated', {
  sessionID: SESSION,
  info: { id: 'msg_a', role: 'assistant', parentID: USER_MESSAGE },
});

function textPart(id: string, text: string): OpencodeFrame {
  return frame('message.part.updated', {
    sessionID: SESSION,
    part: { id, messageID: 'msg_a', type: 'text', text },
  });
}

/** [#2272] A reasoning part, which 1.18.22 emits in front of every text part. */
function reasoningPart(id: string, text: string): OpencodeFrame {
  return frame('message.part.updated', {
    sessionID: SESSION,
    part: { id, messageID: 'msg_a', type: 'reasoning', text },
  });
}

/** Every progress frame broadcast so far, in order. */
function frames(): ChatTurnProgressEvent[] {
  return broadcast.mock.calls
    .map(([, payload]) => payload as ChatTurnProgressEvent)
    .filter((payload) => payload?.type === CHAT_TURN_PROGRESS_EVENT_TYPE);
}

/**
 * Deliver a frame and let the fire-and-forget push settle.
 *
 * `recordOpencodeTranscriptFrame` is synchronous by contract — the SSE reader
 * must not be made to wait on a WebSocket — so the push is a floating promise
 * the test has to drain. A real `setTimeout(0)` is what drains it, which is why
 * only `Date` is faked below: the throttle needs a controllable clock, and the
 * dynamic import behind the push needs a real event loop.
 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function deliver(f: OpencodeFrame, at: number): Promise<void> {
  vi.setSystemTime(at);
  recordOpencodeTranscriptFrame(TARGET, f, at);
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  hasRoomSubscribers.mockReturnValue(true);
  resetChatTurnProgressState();
  forgetOpencodeTranscripts(TARGET);
});

afterEach(() => {
  vi.useRealTimers();
  resetChatTurnProgressState();
  forgetOpencodeTranscripts(TARGET);
});

describe('[#2199] the live body', () => {
  it('grows across two message.part.updated frames', async () => {
    await deliver(OPEN_TURN, 1_000);
    await deliver(textPart('prt_1', 'First sentence.'), 1_000);
    await deliver(textPart('prt_2', 'Second sentence.'), 1_000 + CHAT_TURN_PROGRESS_MIN_INTERVAL_MS);

    const bodies = frames().map((f) => f.body);
    expect(bodies).toEqual(['First sentence.', 'First sentence.\n\nSecond sentence.']);
  });

  it('keys every frame on the id the settled row will carry', async () => {
    await deliver(OPEN_TURN, 1_000);
    await deliver(textPart('prt_1', 'Hello.'), 1_000);

    expect(frames()[0]?.turnKey).toBe(opencodeTurnRequestId(USER_MESSAGE));
  });

  it('names the instance so a sibling in the same room ignores it', async () => {
    await deliver(OPEN_TURN, 1_000);
    await deliver(textPart('prt_1', 'Hello.'), 1_000);

    expect(frames()[0]).toMatchObject({
      worktreeId: 'wt-2199',
      cliToolId: 'opencode',
      instanceId: 'opencode',
      partial: false,
      done: false,
    });
  });

  it('numbers the frames monotonically', async () => {
    await deliver(OPEN_TURN, 1_000);
    await deliver(textPart('prt_1', 'One.'), 1_000);
    await deliver(textPart('prt_2', 'Two.'), 1_000 + CHAT_TURN_PROGRESS_MIN_INTERVAL_MS);
    await deliver(textPart('prt_3', 'Three.'), 1_000 + 2 * CHAT_TURN_PROGRESS_MIN_INTERVAL_MS);

    expect(frames().map((f) => f.version)).toEqual([1, 2, 3]);
  });
});

describe('[#2272] the live body folds its reasoning too', () => {
  it('leads with the answer the moment the text part arrives', async () => {
    // The live bubble and the settled row go through ONE renderer, which is
    // what #2199 bought. This is that property carrying #2272 for free: the
    // reader watches the answer appear at the top rather than watching a
    // `Thinking` quote appear and the answer arrive underneath it.
    await deliver(OPEN_TURN, 1_000);
    await deliver(reasoningPart('prt_1', 'weigh the options'), 1_000);
    await deliver(textPart('prt_2', 'The answer.'), 1_000 + CHAT_TURN_PROGRESS_MIN_INTERVAL_MS);

    const published = frames();
    // The reasoning-only frame is the whole body while it is all there is …
    expect(published[0].body).toBe('> **Thinking (1)**\n>\n> weigh the options');
    // … and steps behind the answer as soon as there is one.
    expect(published[published.length - 1].body).toBe(
      'The answer.\n\n> **Thinking (1)**\n>\n> weigh the options'
    );
  });
});

describe('[#2199] re-sent boundary frames', () => {
  it('publishes nothing for a byte-identical repeat', async () => {
    await deliver(OPEN_TURN, 1_000);
    await deliver(textPart('prt_1', 'The whole paragraph.'), 1_000);
    const afterFirst = frames().length;

    // The same part, re-sent — the shape the measurement in `./transcript`
    // documents. It overwrites its own slot, so the render does not change.
    await deliver(
      textPart('prt_1', 'The whole paragraph.'),
      1_000 + CHAT_TURN_PROGRESS_MIN_INTERVAL_MS,
    );

    expect(afterFirst).toBe(1);
    expect(frames()).toHaveLength(1);
  });

  it('still publishes when the repeat carries the filled-in text', async () => {
    // The other half of the same measurement: a text part opens with `text: ""`
    // and closes with the whole string, on the same `prt_…`.
    await deliver(OPEN_TURN, 1_000);
    await deliver(textPart('prt_1', ''), 1_000);
    await deliver(textPart('prt_1', 'Now it has words.'), 1_000 + CHAT_TURN_PROGRESS_MIN_INTERVAL_MS);

    expect(frames().map((f) => f.body)).toEqual(['Now it has words.']);
  });
});

describe('[#2199] what it does not do', () => {
  it('pushes nothing for a part that belongs to no open turn', async () => {
    // The operator's own prompt travels on this same stream. `ownsOpencodeMessage`
    // is what keeps it out of the reply, and the progress push sits behind it.
    await deliver(textPart('prt_1', 'the user’s own text'), 1_000);

    expect(frames()).toHaveLength(0);
  });

  it('pushes nothing when nobody is subscribed to the worktree room', async () => {
    hasRoomSubscribers.mockReturnValue(false);
    await deliver(OPEN_TURN, 1_000);
    await deliver(textPart('prt_1', 'Hello.'), 1_000);

    expect(broadcast).not.toHaveBeenCalled();
  });

  it('accounts for the frame even when the push cannot be made', async () => {
    // The contract of `recordOpencodeTranscriptFrame` is that the accumulator is
    // correct by the time it returns. A broadcast that throws must not change
    // that — the saved row is the thing that matters.
    hasRoomSubscribers.mockImplementation(() => {
      throw new Error('ws server is gone');
    });
    await deliver(OPEN_TURN, 1_000);
    await deliver(textPart('prt_1', 'Kept anyway.'), 1_000);

    hasRoomSubscribers.mockReturnValue(true);
    resetChatTurnProgressState();
    await deliver(textPart('prt_2', 'And this one.'), 1_000 + CHAT_TURN_PROGRESS_MIN_INTERVAL_MS);

    expect(frames()[0]?.body).toBe('Kept anyway.\n\nAnd this one.');
  });
});
