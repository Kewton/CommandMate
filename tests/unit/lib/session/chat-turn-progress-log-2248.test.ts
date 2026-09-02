/**
 * Making the progress push observable (Issue #2248).
 *
 * ## The defect
 *
 * Every outcome of `emitChatTurnProgress` was `logger.debug`, including the two
 * that mean the reader is looking at a blank space: a push that threw, and a
 * worktree room with no subscribers. Debug is off in the builds people run, so
 * when the reply failed to appear on a live session on 2026-09-02 the server
 * logs could not say whether the body had been produced, whether it had been
 * broadcast, or whether anybody had been listening. A push nobody can observe
 * can only be debugged by reproducing it.
 *
 * ## The two properties, and why they fight
 *
 *  1. **Every turn is reported at info, once.** One line per turn is what makes
 *     "did the body reach the browser at 14:38" answerable after the fact.
 *  2. **A turn is reported ONCE.** The publisher runs on every poll tick of a
 *     generating session — several per second across a machine's worth of
 *     agents — and a line per tick would make info unusable, which is how the
 *     level ended up empty in the first place.
 *
 * So the identity of a log line is `(outcome, turnKey)`, and a repeat of the
 * pair is silent. Two consequences are asserted below because they are the
 * reason for that shape rather than a bare "already logged" boolean: a NEW TURN
 * always logs, and a CHANGE of outcome always logs.
 *
 * ## The mutation Issue #2248 requires
 *
 * Put these calls back on `logger.debug` and every test in this file goes red.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` because `vi.mock` is hoisted above the imports and the factory
// closes over this object: a plain `const` above would still be in its temporal
// dead zone when the first module under test asks for a logger.
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withContext: vi.fn(),
}));
mockLogger.withContext.mockReturnValue(mockLogger);

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

const broadcast = vi.fn();
const hasRoomSubscribers = vi.fn((_worktreeId: string) => true);
vi.mock('@/lib/ws-server', () => ({
  broadcast: (...args: unknown[]) => broadcast(...args),
  hasRoomSubscribers: (worktreeId: string) => hasRoomSubscribers(worktreeId),
}));

import {
  emitChatTurnProgress,
  resetChatTurnProgressState,
  type ChatTurnProgressDraft,
} from '@/lib/session/current-output-builder';
import { CHAT_TURN_PROGRESS_MIN_INTERVAL_MS } from '@/lib/realtime/types';

const TARGET = { worktreeId: 'wt-2248', cliToolId: 'claude', instanceId: 'claude' } as const;
const SIBLING = { worktreeId: 'wt-2248', cliToolId: 'claude', instanceId: 'claude-2' } as const;
const TURN = 'claude-md:u-1';
const NEXT_TURN = 'claude-md:u-2';

/**
 * Absolute timestamps, never derived from the throttle constant.
 *
 * The publisher asks its source at most once per
 * {@link CHAT_TURN_PROGRESS_MIN_INTERVAL_MS}, so a second frame has to be
 * emitted far enough after the first to get past it. Writing that as
 * `T0 + INTERVAL` would move with the constant and leave these tests true for
 * an interval of 0 — the same vacuity trap `chat-turn-progress-2199` documents.
 */
const T0 = 1_000_000;
const T1 = 1_100_000;
const T2 = 1_200_000;

function draft(body: string, turnKey = TURN): ChatTurnProgressDraft {
  return { turnKey, body };
}

/** Every info line this file cares about, in order. */
function infoCalls(prefix: string): Array<[string, Record<string, unknown>]> {
  return mockLogger.info.mock.calls.filter(
    (call) => typeof call[0] === 'string' && call[0].startsWith(prefix),
  ) as Array<[string, Record<string, unknown>]>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLogger.withContext.mockReturnValue(mockLogger);
  hasRoomSubscribers.mockReturnValue(true);
  resetChatTurnProgressState();
});

afterEach(() => {
  resetChatTurnProgressState();
});

describe('[#2248] the interval these tests step over', () => {
  it('is long enough that T0/T1/T2 are separate asks', () => {
    // The guard for the absolute timestamps above: if the constant ever grows
    // past 100s the throttle would swallow the second frame and the "does not
    // log twice" tests below would pass for the wrong reason.
    expect(CHAT_TURN_PROGRESS_MIN_INTERVAL_MS).toBeLessThan(T1 - T0);
  });
});

describe('[#2248] a published frame is reported at info', () => {
  it('logs the first frame of a turn once, with the turn, version and size', async () => {
    await emitChatTurnProgress(TARGET, () => draft('twelve chars'), T0);

    const calls = infoCalls('chat-turn-progress-published');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      worktreeId: 'wt-2248',
      cliToolId: 'claude',
      instanceId: 'claude',
      turnKey: TURN,
      version: 1,
      bodyLength: 'twelve chars'.length,
    });
  });

  it('says nothing more for the rest of the same turn', async () => {
    // Property 2. The body grows on every tick of a long reply; the log must
    // not.
    await emitChatTurnProgress(TARGET, () => draft('one'), T0);
    await emitChatTurnProgress(TARGET, () => draft('one two'), T1);
    await emitChatTurnProgress(TARGET, () => draft('one two three'), T2);

    expect(broadcast).toHaveBeenCalledTimes(3);
    expect(infoCalls('chat-turn-progress-published')).toHaveLength(1);
  });

  it('logs again when the next turn starts', async () => {
    // Property 1. One line per turn is the whole point, so the turn key — not a
    // boolean — is what makes a line new.
    await emitChatTurnProgress(TARGET, () => draft('one'), T0);
    await emitChatTurnProgress(TARGET, () => draft('two', NEXT_TURN), T1);

    const calls = infoCalls('chat-turn-progress-published');
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toMatchObject({ turnKey: NEXT_TURN, version: 2 });
  });

  it('logs each instance separately', async () => {
    // Two agents in one worktree are two turns, and the operator has to be able
    // to tell whose body was pushed.
    await emitChatTurnProgress(TARGET, () => draft('one'), T0);
    await emitChatTurnProgress(SIBLING, () => draft('two'), T0);

    const calls = infoCalls('chat-turn-progress-published');
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call[1].instanceId)).toEqual(['claude', 'claude-2']);
  });

  it('stays silent for the ticks that produce no frame', async () => {
    // The throttle, an unchanged body and a turn with no text yet are the quiet,
    // correct majority of ticks. Logging them would drown the ones that matter.
    await emitChatTurnProgress(TARGET, () => draft('one'), T0);
    await emitChatTurnProgress(TARGET, () => draft('one'), T1);
    await emitChatTurnProgress(TARGET, () => null, T2);

    expect(infoCalls('chat-turn-progress-published')).toHaveLength(1);
  });
});

describe('[#2248] a room with no subscribers is reported too', () => {
  it('logs once when there is nobody to broadcast to', async () => {
    // The state the Issue could not distinguish from a broken producer: the
    // frame was never built because nothing was listening.
    hasRoomSubscribers.mockReturnValue(false);

    await emitChatTurnProgress(TARGET, () => draft('one'), T0);

    const calls = infoCalls('chat-turn-progress-no-subscribers');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ worktreeId: 'wt-2248', instanceId: 'claude' });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not repeat itself tick after tick', async () => {
    hasRoomSubscribers.mockReturnValue(false);

    await emitChatTurnProgress(TARGET, () => draft('one'), T0);
    await emitChatTurnProgress(TARGET, () => draft('one two'), T1);
    await emitChatTurnProgress(TARGET, () => draft('one two three'), T2);

    expect(infoCalls('chat-turn-progress-no-subscribers')).toHaveLength(1);
  });

  it('reports the change when a subscriber turns up', async () => {
    // The transition is the interesting event — "the browser connected and the
    // body started flowing" — and the steady state on either side of it is not.
    hasRoomSubscribers.mockReturnValue(false);
    await emitChatTurnProgress(TARGET, () => draft('one'), T0);

    hasRoomSubscribers.mockReturnValue(true);
    await emitChatTurnProgress(TARGET, () => draft('one two'), T1);

    expect(infoCalls('chat-turn-progress-no-subscribers')).toHaveLength(1);
    expect(infoCalls('chat-turn-progress-published')).toHaveLength(1);
  });
});

describe('[#2248] a failed push is reported too', () => {
  it('logs the error once', async () => {
    broadcast.mockImplementationOnce(() => {
      throw new Error('socket gone');
    });

    await emitChatTurnProgress(TARGET, () => draft('one'), T0);

    const calls = infoCalls('chat-turn-progress-failed');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ instanceId: 'claude', error: 'socket gone' });
  });

  it('does not repeat while it keeps failing', async () => {
    broadcast.mockImplementation(() => {
      throw new Error('socket gone');
    });

    await emitChatTurnProgress(TARGET, () => draft('one'), T0);
    await emitChatTurnProgress(TARGET, () => draft('one two'), T1);

    expect(infoCalls('chat-turn-progress-failed')).toHaveLength(1);
    broadcast.mockReset();
  });

  it('never lets the log call itself break the push path', async () => {
    // `emitChatTurnProgress` promises never to throw; the reporting added here
    // is inside that promise.
    await expect(
      emitChatTurnProgress(
        TARGET,
        () => {
          throw new Error('reader exploded');
        },
        T0,
      ),
    ).resolves.toBe(false);
  });
});
