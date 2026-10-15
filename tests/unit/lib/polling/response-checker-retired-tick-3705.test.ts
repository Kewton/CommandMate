/**
 * A response-poller tick asks again after every `await` whether it still owns
 * its key, and a retired one writes nothing under it (Issue #3705).
 *
 * #3663, #3684 and #3701 added the question at the writes that had been
 * reported, one at a time. The rest of the tick still wrote after its awaits:
 * the prompt sweep (`markPendingPromptsAsAnswered` + `message_updated`), the
 * waiting edge, the completion push, the cursor (`updateSessionState`), the
 * fault notifier, the skip streaks and the #2399 recheck. These cases stop the
 * chain at each `await` of the tick — the session check, the capture, the
 * transcript reader (save path and recheck) and the Markdown log — with a
 * deferred promise, and check that nothing the tick would have written changes
 * after the stop; the negative cases run the same input through a tick that
 * still owns the key (or merely was superseded) and see every write arrive.
 *
 * The real chain throughout: timer → `runPollTick` → `pollerOwnerStorage.run`
 * → `checkForResponse` → the real structured-history gate and its per-instance
 * queue, with the pane, the session check, the codex reader and the log as
 * fakes the test can hold open.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CACHE_MAX_CAPTURE_LINES } from '@/lib/tmux/tmux-capture-cache';
import type { CLIToolType } from '@/lib/cli-tools/types';

const mockLogger = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

const TOOL: CLIToolType = 'codex';
/** Poller key, spelled here so the mocks below need no import of the core. */
const keyOf = (worktreeId: string, instanceId?: string): string =>
  `${worktreeId}:${instanceId ?? TOOL}`;

/** A deferred promise a fake waits on, keyed by poller key. */
type GateSlot<T> = { enter: () => void; wait: Promise<T> };
interface Gate<T> {
  entered: Promise<void>;
  release: (value: T) => void;
}
const openReleases: Array<() => void> = [];

function armGate<T>(slots: Map<string, GateSlot<T>>, key: string, fallback: T): Gate<T> {
  let enter!: () => void;
  let release!: (value: T) => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const wait = new Promise<T>((r) => {
    release = r;
  });
  slots.set(key, { enter, wait });
  openReleases.push(() => release(fallback));
  return { entered, release };
}

async function passGate<T>(slots: Map<string, GateSlot<T>>, key: string, value: T): Promise<T> {
  const slot = slots.get(key);
  if (!slot) return value;
  slots.delete(key);
  slot.enter();
  return slot.wait;
}

const screens = new Map<string, string>();
const sessionGates = new Map<string, GateSlot<boolean>>();
const captureGates = new Map<string, GateSlot<string | null>>();
const captureSessionOutput = vi.fn(
  async (worktreeId: string, _cli: CLIToolType, _lines: number, instanceId?: string) => {
    const key = keyOf(worktreeId, instanceId);
    const released = await passGate(captureGates, key, null);
    if (released !== null) screens.set(key, released);
    return screens.get(key) ?? codexReplyPane(`idle reply of ${key}`);
  }
);
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: [string, CLIToolType, number, string | undefined]) => captureSessionOutput(...a),
  isSessionRunning: async (worktreeId: string, _cli: CLIToolType, instanceId?: string) =>
    passGate(sessionGates, keyOf(worktreeId, instanceId), true),
}));

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({
  id: `msg-${createMessage.mock.calls.length}`,
  ...m,
}));
const sessionLines = new Map<string, number>();
const updateSessionState = vi.fn(
  (_db: unknown, worktreeId: string, _cli: string, line: number, instanceId: string) => {
    sessionLines.set(`${worktreeId}:${instanceId}`, line);
  }
);
const markPendingPromptsAsAnswered = vi.fn((..._a: unknown[]) => 0);
const clearInProgressMessageId = vi.fn();
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  getSessionState: (_db: unknown, worktreeId: string, instanceId: string) => ({
    lastCapturedLine: sessionLines.get(`${worktreeId}:${instanceId}`) ?? CACHE_MAX_CAPTURE_LINES - 1,
    inProgressMessageId: null,
  }),
  updateSessionState: (...a: [unknown, string, string, number, string]) => updateSessionState(...a),
  getWorktreeById: (_db: unknown, id: string) => ({ id, name: id, path: `/repos/${id}` }),
  clearInProgressMessageId: (...a: unknown[]) => clearInProgressMessageId(...a),
  markPendingPromptsAsAnswered: (...a: unknown[]) => markPendingPromptsAsAnswered(...a),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
const broadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: (...a: unknown[]) => broadcastMessage(...a),
}));
const notifyPushSubscribers = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: (...a: unknown[]) => notifyPushSubscribers(...a) }));
const notifyUpstreamFaultPush = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/push/failure-push-notifier', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push/failure-push-notifier')>()),
  notifyUpstreamFaultPush: (...a: unknown[]) => notifyUpstreamFaultPush(...a),
}));

/** The Markdown log, the save path's last `await` before the scrape decision. */
const logGates = new Map<string, GateSlot<void>>();
const recordClaudeConversation = vi.fn(
  async (_db: unknown, worktreeId: string, _content: string, _cli: string, _options?: unknown) => {
    await passGate(logGates, keyOf(worktreeId), undefined);
  }
);
vi.mock('@/lib/conversation-logger', () => ({
  recordClaudeConversation: (...a: [unknown, string, string, string, unknown]) => recordClaudeConversation(...a),
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-session-ownership', () => ({
  findTerminalSessionRefusal: vi.fn(async () => null),
}));
vi.mock('@/lib/tasks/task-transition-service', () => ({ applyEventToActiveTask: vi.fn() }));
vi.mock('@/lib/tmux/geometry-delegation', () => ({
  probeGeometryDelegation: vi.fn(async () => ({ delegated: false, released: false })),
}));
vi.mock('@/lib/relay/relay-triggers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/relay-triggers')>()),
  onRelayTurnCompleted: vi.fn(),
}));

/** The codex transcript reader the real gate calls. */
type ReaderOutcome = 'captured' | 'absent';
const readerGates = new Map<string, GateSlot<ReaderOutcome>>();
const readerOutcome = new Map<string, ReaderOutcome>();
vi.mock('@/lib/hooks/sources/codex/history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/codex/history')>()),
  resolveCodexTranscriptPath: vi.fn(async () => null),
  captureCodexTranscriptTurn: async (
    target: { worktreeId: string; instanceId?: string },
    _capture: unknown,
    report?: { outcome?: string; completion?: string; completionKey?: string }
  ): Promise<boolean> => {
    const key = keyOf(target.worktreeId, target.instanceId);
    const outcome = await passGate(readerGates, key, readerOutcome.get(key) ?? 'absent');
    if (outcome === 'absent') return false;
    if (report) {
      report.outcome = 'captured';
      report.completion = 'settled';
      report.completionKey = undefined;
    }
    return true;
  },
}));

import { resetStructuredHistoryCaptureQueue } from '@/lib/polling/structured-history-gate';
import { resetPendingScrapedResponses } from '@/lib/polling/pending-scraped-response';
import { markStructuredHistoryRecheckPending } from '@/lib/polling/response-dedup';
import { getWaitingEpisode, observeWaitingEdge } from '@/lib/session/waiting-episode-state';
import {
  STALLED_TICK_TIMEOUT,
  startPolling,
  stopAllPolling,
  stopPolling,
} from '@/lib/polling/response-poller-core';

const POLLING_INTERVAL = 2000;
const WT = { a: 'wt-3705-a', b: 'wt-3705-b' };
const KEY_A = keyOf(WT.a);

function saturate(rows: string[]): string {
  const filler = new Array(Math.max(0, CACHE_MAX_CAPTURE_LINES - rows.length)).fill(
    '  transcript row that has already scrolled past the window'
  );
  return [...filler, ...rows].join('\n');
}

/** codex's pane after a finished reply (the #3684 suite's frame). */
function codexReplyPane(reply: string): string {
  return saturate([
    '› summarize the project',
    '',
    `• ${reply}`,
    '',
    '─'.repeat(120),
    '',
    '› Find and fix a bug in @filename',
    '',
    '  gpt-5.6-sol xhigh · ~/share/work/github_kewton/CommandMate',
  ]);
}

/** codex's pane while it is working: an unfinished frame with the indicator. */
function codexWorkingPane(): string {
  return saturate(['› summarize the project', '', '• Working (4s • esc to interrupt)']);
}

/**
 * Every write the tick makes after its awaits, counted. The Markdown log is not
 * among them: it is still called, keyed, and refuses its own write (the log's
 * suite, `conversation-log-retired-tick-3705`, covers that).
 */
function writes(): Record<string, number> {
  return {
    rows: createMessage.mock.calls.length,
    broadcasts: broadcastMessage.mock.calls.length,
    sweeps: markPendingPromptsAsAnswered.mock.calls.length,
    cursor: updateSessionState.mock.calls.length,
    completionPush: notifyPushSubscribers.mock.calls.filter(
      ([p]) => (p as { kind?: string }).kind === 'completion'
    ).length,
    faultPush: notifyUpstreamFaultPush.mock.calls.length,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
  await settle();
}

type Globals = {
  __responseHashCache?: Map<string, string>;
  __structuredHistoryRecheckCache?: Map<string, number>;
  __duplicateResponseSkipStreak?: Map<string, number>;
  __duplicatePromptSkipStreak?: Map<string, number>;
  __promptHashCache?: Map<string, string>;
  __sessionWaitingEpisodes?: Map<string, unknown>;
  __responsePollerCoordinator?: {
    pausedOnPrompt: Set<string>;
    running: Map<string, unknown>;
  };
};
const g = globalThis as Globals;

function resetState(): void {
  stopAllPolling();
  resetPendingScrapedResponses();
  resetStructuredHistoryCaptureQueue();
  g.__responsePollerCoordinator?.running.clear();
  g.__responsePollerCoordinator?.pausedOnPrompt.clear();
  g.__responseHashCache?.clear();
  g.__structuredHistoryRecheckCache?.clear();
  g.__duplicateResponseSkipStreak?.clear();
  g.__duplicatePromptSkipStreak?.clear();
  g.__promptHashCache?.clear();
  g.__sessionWaitingEpisodes?.clear();
  screens.clear();
  sessionGates.clear();
  captureGates.clear();
  readerGates.clear();
  readerOutcome.clear();
  logGates.clear();
  sessionLines.clear();
}

/** A wait this suite can stop the tick at, and how to arm it for A. */
type WaitPoint = 'session-check' | 'capture' | 'reader' | 'conversation-log';
function armAt(point: WaitPoint): { entered: Promise<void>; release: () => void } {
  switch (point) {
    case 'session-check': {
      const gate = armGate(sessionGates, KEY_A, true);
      return { entered: gate.entered, release: () => gate.release(true) };
    }
    case 'capture': {
      const gate = armGate(captureGates, KEY_A, null);
      return { entered: gate.entered, release: () => gate.release(null) };
    }
    case 'reader': {
      const gate = armGate(readerGates, KEY_A, 'absent' as ReaderOutcome);
      return { entered: gate.entered, release: () => gate.release('absent') };
    }
    case 'conversation-log': {
      const gate = armGate(logGates, KEY_A, undefined);
      return { entered: gate.entered, release: () => gate.release(undefined) };
    }
  }
}

/** Open the waiting episode the tick's completion would close. */
function openWait(worktreeId: string): void {
  observeWaitingEdge({ worktreeId, cliToolId: TOOL, instanceId: undefined, waiting: true, kind: 'prompt', now: Date.now() });
}

/** Start A on a finished reply and park its first tick at `point`. */
async function alphaParkedAt(point: WaitPoint, reply = 'alpha reply'): Promise<() => void> {
  startPolling(WT.a, TOOL);
  screens.set(KEY_A, codexReplyPane(reply));
  openWait(WT.a);
  const gate = armAt(point);
  await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
  await gate.entered;
  return gate.release;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T09:00:00.000Z'));
  resetState();
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const release of openReleases.splice(0)) release();
  await settle();
  resetState();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. checker: stopped at each await
// ---------------------------------------------------------------------------

describe('[#3705] 1. a tick stopped at each await of the checker writes nothing after it', () => {
  const POINTS: WaitPoint[] = ['session-check', 'capture', 'reader', 'conversation-log'];

  for (const point of POINTS) {
    it(`stopped at ${point}: no row, sweep, waiting edge, completion push, cursor or fault push`, async () => {
      const release = await alphaParkedAt(point);

      stopPolling(WT.a, TOOL);
      const atStop = writes();
      release();
      await settle();

      expect(writes()).toEqual(atStop);
      expect(getWaitingEpisode(WT.a, TOOL, undefined)).not.toBeNull();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'retired-tick-refused',
        expect.objectContaining({ worktreeId: WT.a, cliToolId: TOOL, instanceId: TOOL })
      );
    });

    it(`negative: a tick that still owns the key, held at ${point}, makes every write`, async () => {
      const release = await alphaParkedAt(point);

      const before = writes();
      release();
      await settle();
      const after = writes();

      expect(after.rows - before.rows).toBe(1);
      expect(after.sweeps - before.sweeps).toBe(1);
      expect(after.completionPush - before.completionPush).toBe(1);
      expect(after.cursor - before.cursor).toBeGreaterThanOrEqual(1);
      expect(getWaitingEpisode(WT.a, TOOL, undefined)).toBeNull();
    });
  }

  it('the Markdown log of the save path is keyed, so it can refuse its own write', async () => {
    const release = await alphaParkedAt('conversation-log');
    release();
    await settle();

    expect(recordClaudeConversation).toHaveBeenCalledWith(
      expect.anything(),
      WT.a,
      expect.stringContaining('alpha reply'),
      TOOL,
      { pollerKey: KEY_A }
    );
  });

  it('stopped at the capture: the working frame sweeps no pending prompt and resets no skip streak', async () => {
    startPolling(WT.a, TOOL);
    const gate = armGate(captureGates, KEY_A, null);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await gate.entered;

    stopPolling(WT.a, TOOL);
    g.__duplicateResponseSkipStreak?.set(KEY_A, 7);
    g.__duplicatePromptSkipStreak?.set(KEY_A, 7);
    gate.release(codexWorkingPane());
    await settle();

    expect(markPendingPromptsAsAnswered).not.toHaveBeenCalled();
    expect(notifyUpstreamFaultPush).not.toHaveBeenCalled();
    expect(g.__duplicateResponseSkipStreak?.get(KEY_A)).toBe(7);
    expect(g.__duplicatePromptSkipStreak?.get(KEY_A)).toBe(7);
  });

  it('negative: the owning tick sweeps on the working frame and ends the skip streaks', async () => {
    startPolling(WT.a, TOOL);
    const gate = armGate(captureGates, KEY_A, null);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await gate.entered;

    g.__duplicateResponseSkipStreak?.set(KEY_A, 7);
    g.__duplicatePromptSkipStreak?.set(KEY_A, 7);
    gate.release(codexWorkingPane());
    await settle();

    expect(markPendingPromptsAsAnswered).toHaveBeenCalledTimes(1);
    expect(notifyUpstreamFaultPush).toHaveBeenCalledTimes(1);
    expect(g.__duplicateResponseSkipStreak?.has(KEY_A)).toBe(false);
    expect(g.__duplicatePromptSkipStreak?.has(KEY_A)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. the successor's state
// ---------------------------------------------------------------------------

describe('[#3705] 2. the old result arriving after the successor began changes none of its state', () => {
  it('past STALLED_TICK_TIMEOUT: the successor\'s wait, recheck and cursor stand, and it saves and notifies itself', async () => {
    const release = await alphaParkedAt('reader', 'shared reply');

    vi.setSystemTime(Date.now() + STALLED_TICK_TIMEOUT + 1);
    startPolling(WT.a, TOOL);
    // What the successor has written by now: a wait it opened, a recheck it is
    // owed and its cursor.
    openWait(WT.a);
    markStructuredHistoryRecheckPending(KEY_A);
    sessionLines.set(KEY_A, 42);
    const atRestart = writes();
    release();
    await settle();

    expect(writes()).toEqual(atRestart);
    expect(getWaitingEpisode(WT.a, TOOL, undefined)).not.toBeNull();
    expect(g.__structuredHistoryRecheckCache?.get(KEY_A)).toBe(0);
    expect(sessionLines.get(KEY_A)).toBe(42);

    // The successor saves the same reply, sweeps, closes the wait and pushes.
    await tick();
    const after = writes();
    expect(after.rows - atRestart.rows).toBe(1);
    expect(after.completionPush - atRestart.completionPush).toBe(1);
    expect(after.sweeps - atRestart.sweeps).toBe(1);
    expect(getWaitingEpisode(WT.a, TOOL, undefined)).toBeNull();

    // And dedups it on the next tick.
    await tick();
    expect(writes().rows).toBe(after.rows);
  });

  it('negative: a merely superseded tick (restart under a minute) still saves, sweeps, closes the wait and pushes', async () => {
    const release = await alphaParkedAt('reader');

    vi.setSystemTime(Date.now() + STALLED_TICK_TIMEOUT - 1_000);
    startPolling(WT.a, TOOL);
    const before = writes();
    release();
    await settle();
    const after = writes();

    expect(after.rows - before.rows).toBe(1);
    expect(after.sweeps - before.sweeps).toBe(1);
    expect(after.completionPush - before.completionPush).toBe(1);
    expect(getWaitingEpisode(WT.a, TOOL, undefined)).toBeNull();
  });

  it('negative: stopping another key does not refuse this tick', async () => {
    startPolling(WT.b, TOOL);
    const release = await alphaParkedAt('conversation-log');

    stopPolling(WT.b, TOOL);
    const before = writes();
    release();
    await settle();

    expect(writes().completionPush - before.completionPush).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. the #2399 recheck
// ---------------------------------------------------------------------------

describe('[#3705] 3. a tick stopped while its recheck asks the reader', () => {
  async function alphaRecheckParked(): Promise<Gate<ReaderOutcome>> {
    startPolling(WT.a, TOOL);
    screens.set(KEY_A, codexReplyPane('alpha reply'));
    await tick(); // saves the reply; the reader said nothing, so a recheck is owed
    expect(g.__structuredHistoryRecheckCache?.get(KEY_A)).toBe(0);
    const gate = armGate(readerGates, KEY_A, 'absent' as ReaderOutcome);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await gate.entered;
    return gate;
  }

  it('does not settle the recheck the successor is owed', async () => {
    const gate = await alphaRecheckParked();

    stopPolling(WT.a, TOOL);
    markStructuredHistoryRecheckPending(KEY_A);
    gate.release('captured');
    await settle();

    expect(g.__structuredHistoryRecheckCache?.get(KEY_A)).toBe(0);
  });

  it('negative: the owning tick settles it when the reader captured the turn', async () => {
    const gate = await alphaRecheckParked();

    gate.release('captured');
    await settle();

    expect(g.__structuredHistoryRecheckCache?.has(KEY_A)).toBe(false);
  });
});

describe('[#3705] 3b. a tick retired at the capture whose frame the successor has already saved', () => {
  /**
   * A is parked on its capture and cut loose past the timeout; B saves the same
   * reply (registering its hash and the recheck it is owed); then A's capture
   * returns that reply. Returns what B left behind.
   */
  async function successorSavedThenAlphaReturns(): Promise<{ readerCalls: () => number }> {
    startPolling(WT.a, TOOL);
    screens.set(KEY_A, codexReplyPane('shared reply'));
    const gate = armGate(captureGates, KEY_A, null);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await gate.entered;

    vi.setSystemTime(Date.now() + STALLED_TICK_TIMEOUT + 1);
    startPolling(WT.a, TOOL);
    await tick(); // B saves `shared reply`, registers its hash and is owed a recheck
    expect(g.__responseHashCache?.has(KEY_A)).toBe(true);
    expect(g.__structuredHistoryRecheckCache?.get(KEY_A)).toBe(0);

    let readerCalls = 0;
    const counting = armGate(readerGates, KEY_A, 'absent' as ReaderOutcome);
    void counting.entered.then(() => {
      readerCalls++;
      counting.release('absent');
    });
    sessionLines.set(KEY_A, 42);
    g.__duplicateResponseSkipStreak?.set(KEY_A, 5);
    gate.release(null); // A's capture returns the same reply
    await settle();
    return { readerCalls: () => readerCalls };
  }

  it('moves no cursor, claims no skip log and no recheck of the successor', async () => {
    const result = await successorSavedThenAlphaReturns();

    expect(sessionLines.get(KEY_A)).toBe(42);
    expect(g.__duplicateResponseSkipStreak?.get(KEY_A)).toBe(5);
    expect(g.__structuredHistoryRecheckCache?.get(KEY_A)).toBe(0);
    expect(result.readerCalls()).toBe(0);
  });

  it('negative: the successor\'s own next tick on the same frame is a duplicate that moves the cursor and asks the reader', async () => {
    const result = await successorSavedThenAlphaReturns();

    await tick();

    expect(sessionLines.get(KEY_A)).not.toBe(42);
    expect(g.__duplicateResponseSkipStreak?.get(KEY_A)).toBe(6);
    expect(g.__structuredHistoryRecheckCache?.get(KEY_A)).not.toBe(0);
    expect(result.readerCalls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. self-stop
// ---------------------------------------------------------------------------

describe('[#3705] 4. a stop the tick raised itself keeps what it recorded', () => {
  it('a prompt pauses the chain and keeps the response hash (the tick is stopped by then)', async () => {
    startPolling(WT.a, TOOL);
    screens.set(KEY_A, codexReplyPane('alpha reply'));
    await tick();
    expect(g.__responseHashCache?.has(KEY_A)).toBe(true);

    screens.set(
      KEY_A,
      saturate([
        '› run the tests',
        '',
        'Would you like to run the following command?',
        '',
        '  $ npm test',
        '',
        '› 1. Yes, proceed (y)',
        "  2. Yes, and don't ask again for commands that start with `npm` (p)",
        '  3. No, and tell Codex what to do differently (esc)',
        '',
        '  Press enter to confirm or esc to cancel',
      ])
    );
    await tick();

    expect(
      createMessage.mock.calls.filter(([, m]) => (m as { messageType?: string }).messageType === 'prompt')
    ).toHaveLength(1);
    expect(g.__responsePollerCoordinator?.pausedOnPrompt.has(KEY_A)).toBe(true);
    expect(g.__responseHashCache?.has(KEY_A)).toBe(true);
  });
});
