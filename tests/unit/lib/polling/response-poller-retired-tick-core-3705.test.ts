/**
 * The core's own writes after a tick's awaits: the queued restart and the
 * terminal snapshot (Issue #3705).
 *
 * 1. A restart handed to an in-flight tick is applied only by THAT tick. Before
 *    this Issue the epilogue applied whatever was queued under the key, so a
 *    tick cut loose past `STALLED_TICK_TIMEOUT` that came back while its
 *    successor's tick was running started the restart queued behind the
 *    successor — stopping the successor mid-tick and running two chains.
 * 2. The snapshot asks whether it may publish after each `await`, not only
 *    when the tick decides to start it. A successor that took the key while the
 *    capture was in flight is not overwritten by the turn that ended (and does
 *    not see its `version` spent on it). A stopped chain with no successor still
 *    pushes its final snapshot.
 *
 * The real core and the real `broadcastTerminalSnapshot`; the checker, the
 * payload builder and the socket are fakes held open with deferred promises.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  checkForResponse: vi.fn(async (..._a: unknown[]) => false),
  buildCurrentOutput: vi.fn(async (..._a: unknown[]) => ({ fullOutput: 'frame', isRunning: true, sessionStatus: 'running' })),
  broadcast: vi.fn(),
}));

vi.mock('@/lib/polling/response-checker', () => ({
  checkForResponse: (...a: unknown[]) => stubs.checkForResponse(...a),
  flushPendingScrapedResponse: vi.fn(() => false),
}));
vi.mock('@/lib/realtime/terminal-session-ownership', () => ({
  findTerminalSessionRefusal: vi.fn(async () => null),
}));
vi.mock('@/lib/session/current-output-builder', () => ({
  buildCurrentOutput: (...a: unknown[]) => stubs.buildCurrentOutput(...a),
}));
vi.mock('@/lib/ws-server', () => ({
  broadcast: (...a: unknown[]) => stubs.broadcast(...a),
  hasRoomSubscribers: () => true,
  broadcastMessage: vi.fn(),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (id: string) => ({ getSessionName: (wt: string, inst?: string) => `mcbd-${id}-${wt}-${inst ?? id}` }),
    }),
  },
}));
vi.mock('@/lib/tmux/tmux-capture-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux-capture-cache')>()),
  invalidateCache: vi.fn(),
}));

import { pollerKeyOf } from '@/lib/polling/poller-owner';
import {
  STALLED_TICK_TIMEOUT,
  getPollerKey,
  migrateResponsePollerWorktreeIds,
  startPolling,
  stopAllPolling,
  stopPolling,
} from '@/lib/polling/response-poller-core';
import { __resetTerminalBroadcastState } from '@/lib/realtime/terminal-broadcast';

const WT = 'wt-3705-core';
const KEY = `${WT}:claude`;
const POLLING_INTERVAL = 2000;

interface CoordinatorShape {
  activePollers: Map<string, NodeJS.Timeout>;
  owners: Map<string, { generation: number; superseded: boolean; stopped: boolean }>;
  running: Map<string, { owner: { generation: number } }>;
  pendingRestart: Map<string, unknown>;
  pausedOnPrompt: Set<string>;
}
const coordinator = (): CoordinatorShape =>
  (globalThis as { __responsePollerCoordinator?: CoordinatorShape }).__responsePollerCoordinator!;

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

/** The generation of the chain that owns the key, or null. */
function ownerGeneration(key = KEY): number | null {
  return coordinator().owners.get(key)?.generation ?? null;
}

/** Make the next `checkForResponse` call wait until released. */
function holdNextCheck(): { entered: Promise<void>; release: () => void } {
  const entered = deferred();
  const gate = deferred();
  stubs.checkForResponse.mockImplementationOnce(async () => {
    entered.resolve();
    await gate.promise;
    return false;
  });
  return { entered: entered.promise, release: () => gate.resolve() };
}

/** Make the next payload build wait until released. */
function holdNextBuild(): { entered: Promise<void>; release: () => void } {
  const entered = deferred();
  const gate = deferred();
  stubs.buildCurrentOutput.mockImplementationOnce(async () => {
    entered.resolve();
    await gate.promise;
    return { fullOutput: 'old turn', isRunning: true, sessionStatus: 'running' };
  });
  return { entered: entered.promise, release: () => gate.resolve() };
}

/** Snapshots pushed for `WT`, by their output. */
function pushedOutputs(): string[] {
  return stubs.broadcast.mock.calls
    .map(([, payload]) => payload as { type?: string; output?: string })
    .filter((payload) => payload.type === 'terminal_snapshot')
    .map((payload) => String(payload.output));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T09:00:00.000Z'));
  stopAllPolling();
  coordinator()?.running.clear();
  __resetTerminalBroadcastState();
  stubs.checkForResponse.mockReset();
  stubs.checkForResponse.mockImplementation(async () => false);
  stubs.buildCurrentOutput.mockReset();
  stubs.buildCurrentOutput.mockImplementation(async () => ({ fullOutput: 'frame', isRunning: true, sessionStatus: 'running' }));
  stubs.broadcast.mockReset();
});

afterEach(async () => {
  stopAllPolling();
  coordinator()?.running.clear();
  await settle();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. the queued restart
// ---------------------------------------------------------------------------

describe('[#3705] 1. a restart queued behind a tick is applied by that tick only', () => {
  it('A cut loose past the timeout, B running, C queued behind B: A coming back does not start C', async () => {
    startPolling(WT, 'claude');
    const a = holdNextCheck();
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await a.entered;

    vi.setSystemTime(Date.now() + STALLED_TICK_TIMEOUT + 1);
    startPolling(WT, 'claude'); // B, past A
    const b = holdNextCheck();
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await b.entered;
    const generationB = ownerGeneration();

    startPolling(WT, 'claude'); // C, queued behind B's tick
    a.release();
    await settle();

    // B still owns the key and is not stopped; C has not started.
    expect(ownerGeneration()).toBe(generationB);
    expect(coordinator().owners.get(KEY)?.stopped).toBe(false);
    expect(coordinator().pendingRestart.has(KEY)).toBe(true);

    b.release();
    await settle();

    // B's epilogue applies C, once.
    expect(ownerGeneration()).not.toBe(generationB);
    expect(coordinator().pendingRestart.has(KEY)).toBe(false);
    expect(coordinator().activePollers.has(KEY)).toBe(true);
  });

  it('negative: an ordinary queued restart is applied by the tick it waited for', async () => {
    startPolling(WT, 'claude');
    const a = holdNextCheck();
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await a.entered;
    const generationA = ownerGeneration();

    startPolling(WT, 'claude');
    expect(ownerGeneration()).toBe(generationA);
    a.release();
    await settle();

    expect(ownerGeneration()).not.toBe(generationA);
    expect(coordinator().pendingRestart.has(KEY)).toBe(false);
  });

  it('negative: an explicit stop cancels the queued restart', async () => {
    startPolling(WT, 'claude');
    const a = holdNextCheck();
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await a.entered;

    startPolling(WT, 'claude');
    stopPolling(WT, 'claude');
    a.release();
    await settle();

    expect(ownerGeneration()).toBeNull();
    expect(coordinator().activePollers.has(KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. the terminal snapshot
// ---------------------------------------------------------------------------

describe('[#3705] 2. a snapshot asks again before it publishes', () => {
  /** Run A's first tick and hold its snapshot inside the payload build. */
  async function alphaSnapshotHeld(): Promise<() => void> {
    startPolling(WT, 'claude');
    const build = holdNextBuild();
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await build.entered;
    return build.release;
  }

  it('a successor started while the build was in flight: the old frame is not pushed', async () => {
    const release = await alphaSnapshotHeld();

    stopPolling(WT, 'claude');
    startPolling(WT, 'claude');
    release();
    await settle();

    expect(pushedOutputs()).toEqual([]);
  });

  it('a successor by worktree-ID migration displacing the chain: the old frame is not pushed', async () => {
    const release = await alphaSnapshotHeld();

    startPolling('wt-3705-other', 'claude');
    migrateResponsePollerWorktreeIds([{ oldId: 'wt-3705-other', newId: WT }], () => 'claude');
    release();
    await settle();

    expect(pushedOutputs()).toEqual([]);
  });

  it('negative: stopped with no successor, the final snapshot is still pushed', async () => {
    const release = await alphaSnapshotHeld();

    stopPolling(WT, 'claude');
    release();
    await settle();

    expect(pushedOutputs()).toEqual(['old turn']);
  });

  it('negative: the chain that owns the key pushes its snapshot, and the successor\'s own frames follow', async () => {
    const release = await alphaSnapshotHeld();
    release();
    await settle();
    expect(pushedOutputs()).toEqual(['old turn']);

    stopPolling(WT, 'claude');
    startPolling(WT, 'claude');
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await settle();
    expect(pushedOutputs()).toEqual(['old turn', 'frame']);
  });
});

// ---------------------------------------------------------------------------
// 3. the key the writers outside the core ask about
// ---------------------------------------------------------------------------

describe('[#3705] 3. pollerKeyOf', () => {
  it('spells the key getPollerKey does, for the primary and an alias instance', () => {
    expect(pollerKeyOf(WT, 'codex')).toBe(getPollerKey(WT, 'codex'));
    expect(pollerKeyOf(WT, 'codex', 'codex-2')).toBe(getPollerKey(WT, 'codex', 'codex-2'));
  });
});
