/**
 * The writers inside a terminal snapshot ask after their own awaits whether the
 * snapshot may still publish (Issue #3705).
 *
 * `runPollTick` decides to start a snapshot once, before its first `await`.
 * Everything the snapshot writes comes later: `buildCurrentOutput` latches the
 * status evidence, the starting state and the unclassified-frame / structured
 * prompt rows after its capture, and the chat-turn progress it detaches
 * remembers the turn's body (which suppresses the next identical frame) after
 * the transcript read. A successor that took the key meanwhile had all of that
 * overwritten by the turn that ended.
 *
 * Each case runs the writer inside `snapshotOwnerStorage.run(owner)` — what the
 * core does — and supersedes the owner while a deferred promise holds the
 * `await`. Outside a poller snapshot (the `/current-output` route) nothing is
 * asked.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: () => 'mcbd-test-session', isRunning: vi.fn().mockResolvedValue(true) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-3705-snap:claude'),
}));
const statusEvidence = vi.hoisted(() => ({ observed: 0, forgotten: 0 }));
vi.mock('@/lib/session/status-evidence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/status-evidence')>();
  return {
    ...actual,
    observeStatusEvidence: (...a: Parameters<typeof actual.observeStatusEvidence>) => {
      statusEvidence.observed++;
      return actual.observeStatusEvidence(...a);
    },
    forgetLastKnownStatus: (...a: Parameters<typeof actual.forgetLastKnownStatus>) => {
      statusEvidence.forgotten++;
      return actual.forgetLastKnownStatus(...a);
    },
  };
});

const socket = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('@/lib/ws-server', () => ({
  broadcast: (...a: unknown[]) => socket.broadcast(...a),
  hasRoomSubscribers: () => true,
  broadcastMessage: vi.fn(),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import {
  buildChatTurnProgress,
  emitChatTurnProgress,
  resetChatTurnProgressState,
} from '@/lib/session/chat-turn-progress';
import { RetiredSnapshotError, snapshotOwnerStorage, type PollerOwner } from '@/lib/polling/poller-owner';

const WT = 'wt-3705-snap';
const IDLE_FRAME = ['  ✻ Worked for 4s', '', '────', '❯ ', '────', '  ? for shortcuts', ''].join('\n');

function owner(): PollerOwner {
  return { pollerKey: `${WT}:claude`, generation: 1, superseded: false, stopped: false, selfStopped: false };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  statusEvidence.observed = 0;
  statusEvidence.forgotten = 0;
  resetChatTurnProgressState();
});

describe('[#3705] buildCurrentOutput inside a poller snapshot', () => {
  it('superseded while the capture is in flight: throws before any writer, the status latch untouched', async () => {
    const capture = deferred<string>();
    vi.mocked(captureSessionOutput).mockReturnValueOnce(capture.promise);
    const tick = owner();

    const built = snapshotOwnerStorage.run(tick, () =>
      buildCurrentOutput({} as Database.Database, WT, 'claude', 'claude')
    );
    await Promise.resolve();
    tick.superseded = true;
    capture.resolve(IDLE_FRAME);

    await expect(built).rejects.toBeInstanceOf(RetiredSnapshotError);
    expect(statusEvidence.observed).toBe(0);
  });

  it('negative: stopped with no successor, the final snapshot is built and latches as before', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValueOnce(IDLE_FRAME);
    const tick = owner();
    tick.stopped = true;

    const payload = await snapshotOwnerStorage.run(tick, () =>
      buildCurrentOutput({} as Database.Database, WT, 'claude', 'claude')
    );

    expect(payload.isRunning).toBe(true);
    expect(statusEvidence.observed).toBe(1);
  });

  it('negative: outside a poller snapshot (the route) nothing is asked', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValueOnce(IDLE_FRAME);

    const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude', 'claude');

    expect(payload.isRunning).toBe(true);
    expect(statusEvidence.observed).toBe(1);
  });
});

describe('[#3705] the chat-turn progress a snapshot detaches', () => {
  const target = { worktreeId: WT, cliToolId: 'claude' as const, instanceId: 'claude' };

  it('superseded while the transcript is read: no frame, and the body is not remembered for the successor', async () => {
    const read = deferred<{ turnKey: string; body: string }>();
    const tick = owner();

    const frame = snapshotOwnerStorage.run(tick, () => buildChatTurnProgress(target, () => read.promise, 1_000));
    await Promise.resolve();
    tick.superseded = true;
    read.resolve({ turnKey: 't-1', body: 'same body' });
    expect(await frame).toBeNull();

    // The successor reads the same body and still gets its frame.
    const next = await snapshotOwnerStorage.run(owner(), () =>
      buildChatTurnProgress(target, async () => ({ turnKey: 't-1', body: 'same body' }), 1_000_000)
    );
    expect(next?.body).toBe('same body');
  });

  it('negative: a snapshot that still may publish builds the frame', async () => {
    const frame = await snapshotOwnerStorage.run(owner(), () =>
      buildChatTurnProgress(target, async () => ({ turnKey: 't-1', body: 'same body' }), 1_000)
    );
    expect(frame?.body).toBe('same body');
  });
});

describe('[#3705] a progress frame refused between its build and its broadcast', () => {
  const target = { worktreeId: WT, cliToolId: 'claude' as const, instanceId: 'claude' };

  /** Bodies broadcast, in order. */
  function broadcastBodies(): string[] {
    return socket.broadcast.mock.calls.map(([, event]) => String((event as { body?: unknown }).body));
  }

  /**
   * Emit from inside `tick`'s snapshot, and supersede it after the build has
   * finished — once it remembered the body — but before the broadcast. The
   * callback is registered on the read after the build awaits it, so it runs
   * after the build's continuation and before `emitChatTurnProgress` resumes.
   */
  async function emitSupersededAfterBuild(tick: PollerOwner, now: number): Promise<boolean> {
    const entered = deferred<void>();
    const read = deferred<{ turnKey: string; body: string }>();
    const emitted = snapshotOwnerStorage.run(tick, () =>
      emitChatTurnProgress(
        target,
        () => {
          entered.resolve();
          return read.promise;
        },
        now
      )
    );
    await entered.promise;
    void read.promise.then(() => {
      tick.superseded = true;
    });
    read.resolve({ turnKey: 't-1', body: 'same body' });
    return emitted;
  }

  beforeEach(() => {
    socket.broadcast.mockClear();
  });

  it('broadcasts nothing, and remembers nothing that would suppress the successor\'s same body', async () => {
    expect(await emitSupersededAfterBuild(owner(), 1_000)).toBe(false);
    expect(broadcastBodies()).toEqual([]);

    const next = await snapshotOwnerStorage.run(owner(), () =>
      emitChatTurnProgress(target, async () => ({ turnKey: 't-1', body: 'same body' }), 1_000_000)
    );
    expect(next).toBe(true);
    expect(broadcastBodies()).toEqual(['same body']);
  });

  it('negative: a frame that was broadcast is remembered, and the same body is not sent again', async () => {
    const tick = owner();
    expect(
      await snapshotOwnerStorage.run(tick, () =>
        emitChatTurnProgress(target, async () => ({ turnKey: 't-1', body: 'same body' }), 1_000)
      )
    ).toBe(true);
    expect(
      await snapshotOwnerStorage.run(tick, () =>
        emitChatTurnProgress(target, async () => ({ turnKey: 't-1', body: 'same body' }), 1_000_000)
      )
    ).toBe(false);
    expect(broadcastBodies()).toEqual(['same body']);
  });

  it('negative: outside a poller snapshot the frame is broadcast and its version follows the previous one', async () => {
    await emitChatTurnProgress(target, async () => ({ turnKey: 't-1', body: 'first' }), 1_000);
    await emitChatTurnProgress(target, async () => ({ turnKey: 't-1', body: 'second' }), 1_000_000);

    const versions = socket.broadcast.mock.calls.map(([, event]) => (event as { version: number }).version);
    expect(broadcastBodies()).toEqual(['first', 'second']);
    expect(versions[1]).toBe(versions[0] + 1);
  });
});
