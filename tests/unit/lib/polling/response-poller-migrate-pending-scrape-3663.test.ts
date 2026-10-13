/**
 * Issue #3663: a worktree-ID batch rename carries the held scrape (#2436).
 *
 * `migrateResponsePollerWorktreeIds` moved the poller and its dedup state to the
 * new ID but left `__pendingScrapedResponses` under the old poller key. The
 * restarted poller then never found the hold: its expiry check runs under the
 * new key, and the old key's hold was written by nothing (or, if the old key
 * was ever stopped, written against the worktree ID the rename had retired).
 *
 * The poller loop itself is stubbed (`checkForResponse`), but the held-scrape
 * module is the real one — `flushPendingScrapedResponse` in the stub is the
 * real function — so the hold is taken out the way a stop or an expiry takes
 * it out, and the row it writes is read off the mocked `createMessage`.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CLIToolType } from '@/lib/cli-tools/types';

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'row', ...m }));
const captureStructuredHistoryTurn = vi.fn(async (): Promise<boolean> => false);
/** What the stubbed `checkForResponse` does on a tick; default: nothing. */
const tickBody = vi.fn(async (_worktreeId?: string, _instanceId?: string): Promise<boolean> => false);

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/db', () => ({
  createMessage: (db: unknown, m: Record<string, unknown>) => createMessage(db, m),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/polling/structured-history-gate', () => ({
  isStructuredHistoryWriterLive: () => false,
  captureStructuredHistoryTurn: () => captureStructuredHistoryTurn(),
}));
vi.mock('@/lib/polling/response-checker', async () => {
  const pending = await import('@/lib/polling/pending-scraped-response');
  return {
    checkForResponse: (worktreeId: string, _cliToolId: string, instanceId?: string) =>
      tickBody(worktreeId, instanceId),
    flushPendingScrapedResponse: pending.flushPendingScrapedResponse,
  };
});
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-session-ownership', () => ({
  findTerminalSessionRefusal: vi.fn(async () => null),
}));

import {
  startPolling,
  stopAllPolling,
  migrateResponsePollerWorktreeIds,
  POLLING_INTERVAL,
  STALLED_TICK_TIMEOUT,
} from '@/lib/polling/response-poller-core';
import {
  PENDING_SCRAPE_HOLD_MS,
  holdScrapedResponse,
  hasPendingScrapedResponse,
  discardPendingScrapedResponse,
  flushPendingScrapedResponse,
  resetPendingScrapedResponses,
  settleExpiredPendingScrapedResponse,
} from '@/lib/polling/pending-scraped-response';
import { renameResponseHashCacheKey } from '@/lib/polling/response-dedup';

type Globals = {
  __pendingScrapedResponses?: Map<string, { worktreeId: string; content: string; expiresAt: number }>;
};
const g = globalThis as Globals;

const TOOL: CLIToolType = 'claude';
const WT = { a: 'wt-3663-a', b: 'wt-3663-b', c: 'wt-3663-c', x: 'wt-3663-x' };
const key = (wt: string): string => `${wt}:${TOOL}`;
const NOW = new Date('2026-10-13T09:00:00.000Z').getTime();

/** Park a held reply under `wt`'s poller key, as `checkForResponse` would. */
function hold(
  wt: string,
  content: string,
  expiresAt = NOW + PENDING_SCRAPE_HOLD_MS,
  pollerKey = key(wt)
): void {
  holdScrapedResponse(pollerKey, {
    worktreeId: wt,
    cliToolId: TOOL,
    instanceId: TOOL,
    content,
    timestamp: new Date(NOW),
    worktreePath: '/repo/worktree',
    transcriptPathHint: null,
    expiresAt,
  });
}

function heldAt(wt: string) {
  const p = g.__pendingScrapedResponses?.get(key(wt));
  return p ? { worktreeId: p.worktreeId, content: p.content, expiresAt: p.expiresAt } : undefined;
}

function writtenRows(): Array<{ worktreeId: unknown; content: unknown }> {
  return createMessage.mock.calls.map(([, m]) => ({ worktreeId: m.worktreeId, content: m.content }));
}

const resolveTool = (): CLIToolType => TOOL;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  stopAllPolling();
  resetPendingScrapedResponses();
  createMessage.mockClear();
  captureStructuredHistoryTurn.mockReset();
  captureStructuredHistoryTurn.mockImplementation(async () => false);
  tickBody.mockReset();
  tickBody.mockImplementation(async () => false);
});

afterEach(() => {
  resetPendingScrapedResponses();
  stopAllPolling();
  vi.useRealTimers();
});

describe('Issue #3663: migrate moves the held scrape with the poller', () => {
  it('a hold under the old ID is taken out under the new ID, and written there', () => {
    startPolling(WT.a, TOOL);
    hold(WT.a, 'reply A');
    // Before: the hold is at the old key.
    expect(hasPendingScrapedResponse(key(WT.a))).toBe(true);
    expect(hasPendingScrapedResponse(key(WT.b))).toBe(false);

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveTool);

    expect(hasPendingScrapedResponse(key(WT.a))).toBe(false);
    expect(heldAt(WT.b)).toEqual({
      worktreeId: WT.b,
      content: 'reply A',
      expiresAt: NOW + PENDING_SCRAPE_HOLD_MS,
    });
    // The migrate itself writes nothing: the hold is moved, not flushed.
    expect(createMessage).not.toHaveBeenCalled();

    expect(flushPendingScrapedResponse(key(WT.a), 'test')).toBe(false);
    expect(flushPendingScrapedResponse(key(WT.b), 'test')).toBe(true);
    expect(writtenRows()).toEqual([{ worktreeId: WT.b, content: 'reply A' }]);
    expect(hasPendingScrapedResponse(key(WT.b))).toBe(false);
  });

  it('the moved hold keeps its deadline: not settled early, settled once it expires', async () => {
    startPolling(WT.a, TOOL);
    hold(WT.a, 'reply A');
    vi.setSystemTime(NOW + 1_000);

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveTool);

    await settleExpiredPendingScrapedResponse(key(WT.b));
    expect(hasPendingScrapedResponse(key(WT.b))).toBe(true);
    expect(createMessage).not.toHaveBeenCalled();

    vi.setSystemTime(NOW + PENDING_SCRAPE_HOLD_MS);
    await settleExpiredPendingScrapedResponse(key(WT.b));
    expect(hasPendingScrapedResponse(key(WT.b))).toBe(false);
    expect(writtenRows()).toEqual([{ worktreeId: WT.b, content: 'reply A' }]);
  });

  it('A↔B swap keeps each hold on its own poller, under the new IDs', () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.b, TOOL);
    hold(WT.a, 'reply A');
    hold(WT.b, 'reply B');

    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.a },
      ],
      resolveTool
    );

    expect(heldAt(WT.b)).toMatchObject({ worktreeId: WT.b, content: 'reply A' });
    expect(heldAt(WT.a)).toMatchObject({ worktreeId: WT.a, content: 'reply B' });
  });

  it('A→B→C chain moves every hold one step, none lost or mixed', () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.b, TOOL);
    hold(WT.a, 'reply A');
    hold(WT.b, 'reply B');

    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.c },
      ],
      resolveTool
    );

    expect(hasPendingScrapedResponse(key(WT.a))).toBe(false);
    expect(heldAt(WT.b)).toMatchObject({ worktreeId: WT.b, content: 'reply A' });
    expect(heldAt(WT.c)).toMatchObject({ worktreeId: WT.c, content: 'reply B' });
  });

  it('a chain paused on a prompt carries its hold too', () => {
    hold(WT.a, 'reply A');
    const coordinator = (globalThis as { __responsePollerCoordinator?: { pausedOnPrompt: Set<string> } })
      .__responsePollerCoordinator;
    coordinator?.pausedOnPrompt.add(key(WT.a));

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveTool);

    expect(hasPendingScrapedResponse(key(WT.a))).toBe(false);
    expect(heldAt(WT.b)).toMatchObject({ worktreeId: WT.b, content: 'reply A' });
    coordinator?.pausedOnPrompt.delete(key(WT.b));
  });

  it('a hold already at a destination that is not moving is replaced by the moved one', () => {
    startPolling(WT.a, TOOL);
    hold(WT.a, 'reply A');
    // A stale hold at B whose poller is not part of this batch.
    hold(WT.b, 'stale B');

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveTool);

    expect(heldAt(WT.b)).toMatchObject({ worktreeId: WT.b, content: 'reply A' });
    expect(hasPendingScrapedResponse(key(WT.a))).toBe(false);
  });

  it('negative: with no holds, migrate leaves the held-scrape map empty and writes nothing', () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.b, TOOL);

    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.a },
      ],
      resolveTool
    );

    expect(g.__pendingScrapedResponses?.size ?? 0).toBe(0);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('negative: a hold of a worktree outside the batch is left exactly as it was', () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.x, TOOL);
    hold(WT.x, 'reply X');
    const before = heldAt(WT.x);

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveTool);

    expect(heldAt(WT.x)).toEqual(before);
    expect(heldAt(WT.x)).toMatchObject({ worktreeId: WT.x, content: 'reply X' });
    expect(hasPendingScrapedResponse(key(WT.b))).toBe(false);
  });

  it('the single dedup rename does not touch held scrapes', () => {
    hold(WT.a, 'reply A');
    renameResponseHashCacheKey(key(WT.a), key(WT.b));
    expect(heldAt(WT.a)).toMatchObject({ worktreeId: WT.a, content: 'reply A' });
    expect(hasPendingScrapedResponse(key(WT.b))).toBe(false);
  });
});

/** A promise the test resolves by hand, to park an `await` across a migrate. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Issue #3663: work awaiting across a migrate does not act on a moved hold', () => {
  for (const captured of [true, false]) {
    it(`an expiry settle begun before an A↔B swap leaves the hold that moved into A alone (capture ${captured})`, async () => {
      startPolling(WT.a, TOOL);
      startPolling(WT.b, TOOL);
      hold(WT.a, 'reply A', NOW - 1); // expired: the settle goes to the reader
      hold(WT.b, 'reply B', NOW + PENDING_SCRAPE_HOLD_MS); // not expired
      const capture = deferred<boolean>();
      captureStructuredHistoryTurn.mockImplementation(() => capture.promise);

      const settling = settleExpiredPendingScrapedResponse(key(WT.a));
      migrateResponsePollerWorktreeIds(
        [
          { oldId: WT.a, newId: WT.b },
          { oldId: WT.b, newId: WT.a },
        ],
        resolveTool
      );
      capture.resolve(captured);
      await settling;

      // B's hold now sits at key A, under worktree A, still before its deadline:
      // neither dropped (capture true) nor written early (capture false).
      expect(heldAt(WT.a)).toMatchObject({ worktreeId: WT.a, content: 'reply B' });
      expect(heldAt(WT.b)).toMatchObject({ worktreeId: WT.b, content: 'reply A' });
      expect(createMessage).not.toHaveBeenCalled();
    });
  }

  it('a settle that awaits with no migrate still ends its own hold (control)', async () => {
    startPolling(WT.a, TOOL);
    hold(WT.a, 'reply A', NOW - 1);
    const capture = deferred<boolean>();
    captureStructuredHistoryTurn.mockImplementation(() => capture.promise);

    const settling = settleExpiredPendingScrapedResponse(key(WT.a));
    capture.resolve(false);
    await settling;

    expect(hasPendingScrapedResponse(key(WT.a))).toBe(false);
    expect(writtenRows()).toEqual([{ worktreeId: WT.a, content: 'reply A' }]);
  });

  it('a tick of the old A chain that holds after an A↔B swap does not overwrite the hold moved into A', async () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.b, TOOL);
    hold(WT.b, 'reply B');
    const capture = deferred<void>();
    let tickStarted = false;
    tickBody.mockImplementationOnce(async () => {
      tickStarted = true;
      await capture.promise;
      // What `recordOrHoldScrapedResponse` does once the reader said not yet closed.
      hold(WT.a, 'stale reply A');
      return false;
    });

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    expect(tickStarted).toBe(true);
    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.a },
      ],
      resolveTool
    );
    capture.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(heldAt(WT.a)).toMatchObject({ worktreeId: WT.a, content: 'reply B' });
    expect(hasPendingScrapedResponse(key(WT.b))).toBe(false);
  });

  it('a tick of the old A chain does not create a hold at A after A→B either', async () => {
    startPolling(WT.a, TOOL);
    const capture = deferred<void>();
    tickBody.mockImplementationOnce(async () => {
      await capture.promise;
      hold(WT.a, 'stale reply A');
      return false;
    });

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveTool);
    capture.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(hasPendingScrapedResponse(key(WT.a))).toBe(false);
  });

  it('a tick of the old A chain does not discard the hold moved into A', async () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.b, TOOL);
    hold(WT.b, 'reply B');
    const capture = deferred<void>();
    tickBody.mockImplementationOnce(async () => {
      await capture.promise;
      discardPendingScrapedResponse(key(WT.a));
      return false;
    });

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.a },
      ],
      resolveTool
    );
    capture.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(heldAt(WT.a)).toMatchObject({ worktreeId: WT.a, content: 'reply B' });
  });

  it('a tick that still owns its key holds as before (control)', async () => {
    startPolling(WT.a, TOOL);
    const capture = deferred<void>();
    tickBody.mockImplementationOnce(async () => {
      await capture.promise;
      hold(WT.a, 'reply A');
      return false;
    });

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    capture.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(heldAt(WT.a)).toMatchObject({ worktreeId: WT.a, content: 'reply A' });
  });

  it('a tick superseded by a plain restart (not a migrate) still holds, for the restart to flush (control)', async () => {
    startPolling(WT.a, TOOL);
    const capture = deferred<void>();
    tickBody.mockImplementationOnce(async () => {
      await capture.promise;
      hold(WT.a, 'reply A');
      return false;
    });

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    startPolling(WT.a, TOOL); // deferred to the tick's epilogue (#2223)
    capture.resolve();
    await vi.advanceTimersByTimeAsync(0);

    // The queued restart ended the cycle and wrote the hold, as before.
    expect(writtenRows()).toEqual([{ worktreeId: WT.a, content: 'reply A' }]);
  });
});

describe('Issue #3663: every generation alive at a migrate is out of the held scrapes', () => {
  /** Alias instance `x`: its CLI tool comes from the resolver, which can refuse. */
  const xKey = (wt: string): string => `${wt}:x`;

  function holdX(wt: string, content: string): void {
    hold(wt, content, NOW + PENDING_SCRAPE_HOLD_MS, xKey(wt));
  }

  function heldAtX(wt: string) {
    const p = g.__pendingScrapedResponses?.get(xKey(wt));
    return p ? { worktreeId: p.worktreeId, content: p.content } : undefined;
  }

  it('a tick of a poller abandoned by the migrate does not touch the hold moved onto its key (A:x → B:x)', async () => {
    startPolling(WT.a, TOOL, 'x');
    startPolling(WT.b, TOOL, 'x');
    holdX(WT.a, 'reply A');
    const capture = deferred<void>();
    tickBody.mockImplementation(async (worktreeId) => {
      if (worktreeId !== WT.b) return false;
      await capture.promise;
      holdX(WT.b, 'stale reply B');
      return false;
    });

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    // B:x cannot be resolved, so it is abandoned (stopped) while its tick waits.
    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], (wt) =>
      wt === WT.b ? null : TOOL
    );
    capture.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(heldAtX(WT.b)).toEqual({ worktreeId: WT.b, content: 'reply A' });
  });

  it('a tick of a poller abandoned by the migrate does not discard the hold moved onto its key', async () => {
    startPolling(WT.a, TOOL, 'x');
    startPolling(WT.b, TOOL, 'x');
    holdX(WT.a, 'reply A');
    const capture = deferred<void>();
    tickBody.mockImplementation(async (worktreeId) => {
      if (worktreeId !== WT.b) return false;
      await capture.promise;
      discardPendingScrapedResponse(xKey(WT.b));
      return false;
    });

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], (wt) =>
      wt === WT.b ? null : TOOL
    );
    capture.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(heldAtX(WT.b)).toEqual({ worktreeId: WT.b, content: 'reply A' });
  });

  it('an older generation still waiting after a stalled-tick restart does not overwrite the hold swapped into A', async () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.b, TOOL);
    const capture = deferred<void>();
    tickBody.mockImplementationOnce(async () => {
      await capture.promise;
      hold(WT.a, 'stale reply A');
      return false;
    });

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    // The first tick is stuck past the stall limit: a restart replaces it now.
    vi.setSystemTime(Date.now() + STALLED_TICK_TIMEOUT + 1);
    startPolling(WT.a, TOOL);
    hold(WT.b, 'reply B');
    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.a },
      ],
      resolveTool
    );
    capture.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(heldAt(WT.a)).toMatchObject({ worktreeId: WT.a, content: 'reply B' });
  });

  it('with no migrate, an older generation after a stalled-tick restart still holds (control)', async () => {
    startPolling(WT.a, TOOL);
    const capture = deferred<void>();
    tickBody.mockImplementationOnce(async () => {
      await capture.promise;
      hold(WT.a, 'reply A');
      return false;
    });

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    vi.setSystemTime(Date.now() + STALLED_TICK_TIMEOUT + 1);
    startPolling(WT.a, TOOL);
    capture.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(heldAt(WT.a)).toMatchObject({ worktreeId: WT.a, content: 'reply A' });
  });

  it('a tick that starts after the migrate holds under its key as usual (control)', async () => {
    startPolling(WT.a, TOOL);
    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveTool);
    tickBody.mockImplementationOnce(async (worktreeId) => {
      hold(worktreeId as string, 'reply after');
      return false;
    });

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);

    expect(heldAt(WT.b)).toMatchObject({ worktreeId: WT.b, content: 'reply after' });
  });
});

describe('Issue #3663: pollers whose holds a migrate does not move keep holding', () => {
  it('an instance on the destination worktree that the migrate does not move still holds (B:codex-2)', async () => {
    const otherKey = `${WT.b}:codex-2`;
    startPolling(WT.a, TOOL);
    startPolling(WT.b, 'codex', 'codex-2');
    const capture = deferred<void>();
    tickBody.mockImplementation(async (worktreeId, instanceId) => {
      if (worktreeId !== WT.b || instanceId !== 'codex-2') return false;
      await capture.promise;
      hold(WT.b, 'reply B codex-2', NOW + PENDING_SCRAPE_HOLD_MS, otherKey);
      return false;
    });

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveTool);
    capture.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(g.__pendingScrapedResponses?.get(otherKey)?.content).toBe('reply B codex-2');
  });

  it('A→B with no poller at A leaves the tick already running at B able to hold', async () => {
    startPolling(WT.b, TOOL);
    const capture = deferred<void>();
    tickBody.mockImplementationOnce(async () => {
      await capture.promise;
      hold(WT.b, 'reply B');
      return false;
    });

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveTool);
    capture.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(heldAt(WT.b)).toMatchObject({ worktreeId: WT.b, content: 'reply B' });
  });

  it('a tick of an instance the migrate abandons on the source worktree does not hold after it (A:codex-2)', async () => {
    const otherKey = `${WT.a}:codex-2`;
    startPolling(WT.a, TOOL);
    startPolling(WT.a, 'codex', 'codex-2');
    const capture = deferred<void>();
    tickBody.mockImplementation(async (worktreeId, instanceId) => {
      if (instanceId !== 'codex-2') return false;
      await capture.promise;
      hold(worktreeId as string, 'reply A codex-2', NOW + PENDING_SCRAPE_HOLD_MS, otherKey);
      return false;
    });

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    // codex-2 cannot be resolved and is abandoned, so the migrate does touch
    // it: its late hold must not be written.
    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], (_wt, inst) =>
      inst === 'codex-2' ? null : TOOL
    );
    capture.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(g.__pendingScrapedResponses?.has(otherKey)).toBe(false);
  });
});
