/**
 * The response poller is one poller per session, for the whole process
 * (Issue #2223).
 *
 * Two separate defects sit under that sentence, and only the second one is
 * about bundling.
 *
 * 1. **Two module graphs, two registries.** `next start` evaluates
 *    `response-poller-core` once inside the custom server's graph (the restored
 *    timers and the Auto-Yes poller reach it that way) and again inside each
 *    Next route bundle (`/send`, `/respond`, `/prompt-response`). A
 *    module-scope `activePollers` is therefore one map per graph:
 *    `startPolling` from a route could not see — let alone stop — the
 *    poller the server's timer had started, so both ran, both captured the same
 *    pane, and both saved the reply.
 *
 * 2. **The in-flight generation race, which needs no second bundle at all.**
 *    `clearTimeout()` cannot cancel a timer that has already fired. A tick that
 *    is awaiting `checkForResponse()` when a restart arrives used to resume,
 *    read `activePollers.has(pollerKey)` as "I am still the poller", and
 *    re-register its own timer *over* the live one — leaving the new poller's
 *    timer running but untracked, and therefore unstoppable. The reverse also
 *    held: the old tick's `stopPolling()` (which `checkForResponse` raises on
 *    four end-of-turn paths) killed the chain that had replaced it.
 *
 * So the suite proves both a shared registry AND an ownership token. Swapping
 * the maps onto `globalThis` alone leaves (2) wide open, which is why the
 * in-flight cases below are the larger half.
 *
 * The second module instance is real, not simulated: `vi.resetModules()` between
 * two dynamic imports produces genuinely separate evaluations of the same file,
 * which is the closest a unit test gets to the two-bundle topology.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  checkForResponse: vi.fn(async () => false),
  broadcastTerminalSnapshot: vi.fn(async () => {}),
}));

// Declared through `vi.hoisted` so the SAME mock functions are handed to every
// module instance. A factory that built them inline would create a fresh spy
// per `vi.resetModules()`, and "how many ticks ran in total" — the question the
// whole suite asks — would be unanswerable.
vi.mock('@/lib/polling/response-checker', () => ({
  checkForResponse: stubs.checkForResponse,
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshot: stubs.broadcastTerminalSnapshot,
}));

const WT = 'wt-2223';
const KEY = `${WT}:claude`;
const COPILOT_KEY = `${WT}:copilot`;
const POLLING_INTERVAL = 2000;

/** One evaluation of the poller and the caches that share its lifecycle. */
interface Bundle {
  core: typeof import('@/lib/polling/response-poller-core');
  promptDedup: typeof import('@/lib/polling/prompt-dedup');
  responseDedup: typeof import('@/lib/polling/response-dedup');
  tui: typeof import('@/lib/tui-accumulator');
}

async function loadBundle(): Promise<Bundle> {
  vi.resetModules();
  return {
    core: await import('@/lib/polling/response-poller-core'),
    promptDedup: await import('@/lib/polling/prompt-dedup'),
    responseDedup: await import('@/lib/polling/response-dedup'),
    tui: await import('@/lib/tui-accumulator'),
  };
}

/**
 * The process-wide state, reached the way production reaches it.
 *
 * `vi.resetModules()` does NOT clear `globalThis`, so every test has to put it
 * back itself — and timers have to be cleared *before* the maps are, or a live
 * timeout is simply lost track of and fires into the next test.
 */
interface CoordinatorShape {
  activePollers: Map<string, NodeJS.Timeout>;
  pollingStartTimes: Map<string, number>;
  owners: Map<string, unknown>;
  running: Map<string, unknown>;
  pendingRestart: Map<string, unknown>;
}

function resetProcessState(): void {
  const g = globalThis as {
    __responsePollerCoordinator?: CoordinatorShape;
    __tuiResponseAccumulator?: Map<string, unknown>;
    __promptHashCache?: Map<string, string>;
    __responseHashCache?: Map<string, string>;
  };
  const coordinator = g.__responsePollerCoordinator;
  if (coordinator) {
    for (const timer of coordinator.activePollers.values()) clearTimeout(timer);
    coordinator.activePollers.clear();
    coordinator.pollingStartTimes.clear();
    coordinator.owners.clear();
    coordinator.running.clear();
    coordinator.pendingRestart.clear();
  }
  g.__tuiResponseAccumulator?.clear();
  g.__promptHashCache?.clear();
  g.__responseHashCache?.clear();
}

/** A promise the test decides when to settle, standing in for a slow tmux capture. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every already-resolved continuation run without advancing the clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetProcessState();
  stubs.checkForResponse.mockReset();
  stubs.checkForResponse.mockImplementation(async () => false);
  stubs.broadcastTerminalSnapshot.mockReset();
  stubs.broadcastTerminalSnapshot.mockImplementation(async () => {});
});

afterEach(() => {
  resetProcessState();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. One registry across module instances
// ---------------------------------------------------------------------------

describe('across two module instances', () => {
  it('is genuinely two evaluations sharing one registry', async () => {
    const a = await loadBundle();
    const b = await loadBundle();

    // Premise: without this the sharing assertions below would be trivially
    // true because both names would point at the same module.
    expect(a.core).not.toBe(b.core);
    expect(a.tui).not.toBe(b.tui);

    expect(a.core.activePollers).toBe(b.core.activePollers);
    expect(a.core.pollingStartTimes).toBe(b.core.pollingStartTimes);
  });

  it('a startPolling from the second instance stops the first instance poller', async () => {
    const a = await loadBundle();
    const b = await loadBundle();

    a.core.startPolling(WT, 'claude');
    expect(b.core.getActivePollers()).toEqual([KEY]);

    b.core.startPolling(WT, 'claude');
    expect(a.core.getActivePollers()).toEqual([KEY]);

    // The heart of it: one tick per interval, not one per module instance.
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    expect(stubs.checkForResponse).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    expect(stubs.checkForResponse).toHaveBeenCalledTimes(2);
  });

  it('stopPolling from the second instance stops the first instance poller', async () => {
    const a = await loadBundle();
    const b = await loadBundle();

    a.core.startPolling(WT, 'claude');
    b.core.stopPolling(WT, 'claude');

    expect(a.core.getActivePollers()).toEqual([]);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL * 3);
    expect(stubs.checkForResponse).not.toHaveBeenCalled();
  });

  it('records the polling start time once, visible from either instance', async () => {
    const a = await loadBundle();
    const b = await loadBundle();

    a.core.startPolling(WT, 'claude');

    expect(b.core.pollingStartTimes.has(KEY)).toBe(true);
    expect(Array.from(b.core.pollingStartTimes.keys())).toEqual([KEY]);
  });
});

// ---------------------------------------------------------------------------
// 2. The in-flight generation race — the body of Issue #2223
// ---------------------------------------------------------------------------

describe('a restart while a tick is inside checkForResponse()', () => {
  /** Start a chain and leave its first tick parked inside `checkForResponse`. */
  async function parkFirstTick(
    bundle: Bundle,
    onRelease?: () => void
  ): Promise<{ release: () => void }> {
    const gate = deferred<boolean>();
    stubs.checkForResponse.mockImplementationOnce(async () => {
      await gate.promise;
      onRelease?.();
      return false;
    });

    bundle.core.startPolling(WT, 'claude');
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    expect(stubs.checkForResponse).toHaveBeenCalledTimes(1);

    return { release: () => gate.resolve(false) };
  }

  it('does not run the old and new chain side by side', async () => {
    const a = await loadBundle();
    const b = await loadBundle();
    const parked = await parkFirstTick(a);

    b.core.startPolling(WT, 'claude');

    // The restart is queued behind the in-flight tick, so no second chain ticks
    // while the first is still awaiting its capture.
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL * 3);
    expect(stubs.checkForResponse).toHaveBeenCalledTimes(1);

    parked.release();
    await settle();

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    expect(stubs.checkForResponse).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    expect(stubs.checkForResponse).toHaveBeenCalledTimes(3);
  });

  it('the superseded tick does not re-register itself over the live poller', async () => {
    const a = await loadBundle();
    const b = await loadBundle();
    const parked = await parkFirstTick(a);

    b.core.startPolling(WT, 'claude');
    parked.release();
    await settle();

    // Exactly one timer for the key, and exactly one tick on the next interval.
    // Before #2223 the resumed tick armed a second timer and overwrote the map
    // entry, so the live poller's timer went on firing untracked.
    expect(a.core.getActivePollers()).toEqual([KEY]);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    expect(stubs.checkForResponse).toHaveBeenCalledTimes(2);
  });

  it('the superseded tick broadcasts no terminal snapshot', async () => {
    const a = await loadBundle();
    const b = await loadBundle();
    const parked = await parkFirstTick(a);

    b.core.startPolling(WT, 'claude');
    parked.release();
    await settle();

    expect(stubs.broadcastTerminalSnapshot).not.toHaveBeenCalled();
  });

  it('control: a tick that was NOT superseded still broadcasts', async () => {
    const a = await loadBundle();

    a.core.startPolling(WT, 'claude');
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);

    expect(stubs.broadcastTerminalSnapshot).toHaveBeenCalledTimes(1);
    expect(stubs.broadcastTerminalSnapshot).toHaveBeenCalledWith(WT, 'claude', undefined);
  });

  it('a stopPolling raised inside the superseded tick does not stop its successor', async () => {
    const a = await loadBundle();
    const b = await loadBundle();

    // This is precisely what `checkForResponse` does when it decides the turn is
    // over (session gone, prompt detected, TUI reply saved, worktree missing).
    const parked = await parkFirstTick(a, () => a.core.stopPolling(WT, 'claude'));

    b.core.startPolling(WT, 'claude');
    parked.release();
    await settle();

    expect(b.core.getActivePollers()).toEqual([KEY]);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    expect(stubs.checkForResponse).toHaveBeenCalledTimes(2);
  });

  it('control: a stopPolling raised inside a tick that still owns the key does stop it', async () => {
    const a = await loadBundle();

    stubs.checkForResponse.mockImplementationOnce(async () => {
      a.core.stopPolling(WT, 'claude');
      return true;
    });
    a.core.startPolling(WT, 'claude');
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await settle();

    expect(a.core.getActivePollers()).toEqual([]);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL * 3);
    expect(stubs.checkForResponse).toHaveBeenCalledTimes(1);
  });

  it('an explicit stop cancels the restart queued behind the in-flight tick', async () => {
    const a = await loadBundle();
    const b = await loadBundle();
    const parked = await parkFirstTick(a);

    b.core.startPolling(WT, 'claude');
    b.core.stopPolling(WT, 'claude');
    parked.release();
    await settle();

    // "start then stop" has to leave the session stopped, not resurrect the
    // queued restart in the tick's epilogue.
    expect(a.core.getActivePollers()).toEqual([]);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL * 3);
    expect(stubs.checkForResponse).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3. The caches that share the poller's lifecycle
// ---------------------------------------------------------------------------

describe('the caches stopPollingByKey() owns', () => {
  it('a stop from the second instance clears what the first instance filled', async () => {
    const a = await loadBundle();
    const b = await loadBundle();

    a.core.startPolling(WT, 'copilot');
    a.tui.accumulateTuiContent(COPILOT_KEY, 'a line the agent printed', 'copilot');
    expect(a.promptDedup.isDuplicatePrompt(COPILOT_KEY, 'Proceed?')).toBe(false);
    expect(a.responseDedup.isDuplicateResponse(COPILOT_KEY, 'done')).toBe(false);

    // Premise: the state really is there before the stop.
    expect(a.tui.getAccumulatedContent(COPILOT_KEY)).toContain('a line the agent printed');
    expect(a.promptDedup.isDuplicatePrompt(COPILOT_KEY, 'Proceed?')).toBe(true);
    expect(a.responseDedup.isDuplicateResponse(COPILOT_KEY, 'done')).toBe(true);

    b.core.stopPolling(WT, 'copilot');

    // Read back through the FIRST instance: a per-graph cache would have left
    // the accumulator and both hashes behind, and the next turn would dedup
    // against the previous turn's screen.
    expect(a.tui.getAccumulatedContent(COPILOT_KEY)).toBe('');
    expect(a.promptDedup.isDuplicatePrompt(COPILOT_KEY, 'Proceed?')).toBe(false);
    expect(a.responseDedup.isDuplicateResponse(COPILOT_KEY, 'done')).toBe(false);
  });

  it('a migration driven from the second instance carries the first instance hashes', async () => {
    const a = await loadBundle();
    const b = await loadBundle();

    a.core.startPolling(WT, 'copilot');
    expect(a.promptDedup.isDuplicatePrompt(COPILOT_KEY, 'Proceed?')).toBe(false);
    expect(a.responseDedup.isDuplicateResponse(COPILOT_KEY, 'done')).toBe(false);

    const moved = b.core.migrateResponsePollerWorktreeIds(
      [{ oldId: WT, newId: 'wt-2223-renamed' }],
      () => 'copilot'
    );

    expect(moved).toHaveLength(1);
    const newKey = 'wt-2223-renamed:copilot';
    // Carried, not cleared: the screen currently on display must not be saved
    // again as a fresh message under the new ID.
    expect(a.promptDedup.isDuplicatePrompt(newKey, 'Proceed?')).toBe(true);
    expect(a.responseDedup.isDuplicateResponse(newKey, 'done')).toBe(true);
  });

  it('the migrated chain runs once, and the retired tick cannot revive the old ID', async () => {
    const a = await loadBundle();
    const b = await loadBundle();

    const gate = deferred<boolean>();
    stubs.checkForResponse.mockImplementationOnce(() => gate.promise);

    a.core.startPolling(WT, 'claude');
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    expect(stubs.checkForResponse).toHaveBeenCalledTimes(1);

    b.core.migrateResponsePollerWorktreeIds(
      [{ oldId: WT, newId: 'wt-2223-renamed' }],
      () => 'claude'
    );
    gate.resolve(false);
    await settle();

    expect(a.core.getActivePollers()).toEqual(['wt-2223-renamed:claude']);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    expect(stubs.checkForResponse).toHaveBeenCalledTimes(2);
    expect(stubs.checkForResponse).toHaveBeenLastCalledWith('wt-2223-renamed', 'claude', 'claude');
  });
});

// ---------------------------------------------------------------------------
// 4. Key shape is unchanged (Issue #868)
// ---------------------------------------------------------------------------

describe('getPollerKey (Issue #868 compatibility)', () => {
  it('keeps the legacy worktreeId:cliToolId form for the primary instance', async () => {
    const { core } = await loadBundle();

    expect(core.getPollerKey('wt', 'claude')).toBe('wt:claude');
    expect(core.getPollerKey('wt', 'claude', 'claude')).toBe('wt:claude');
    expect(core.getPollerKey('wt', 'codex', 'codex-3')).toBe('wt:codex-3');
  });
});
