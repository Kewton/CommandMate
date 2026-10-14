/**
 * A worktree-ID migration carries the held scrape, and a tick that no longer
 * owns its key cannot touch one (Issue #3663).
 *
 * `migrateResponsePollerWorktreeIds` moved the pollers and the dedup state to
 * the new IDs (#1621, #3553) but left #2436's held scrapes behind: a reply held
 * under the old key was flushed — if ever — with the old worktree ID, which the
 * rename has just removed from the table. And a tick already awaiting the
 * transcript reader when the migration ran came back and held, discarded or
 * flushed under the old key as if nothing had happened.
 *
 * The rule pinned here is "is the caller still the owner of this key?", read
 * from the tick's ownership token. So every case that needs a caller goes
 * through the real chain — timer → `runPollTick` → `ownerStorage.run` →
 * `checkForResponse` — with the transcript reader as a fake the test can hold
 * open while the migration runs. Rows are read off the `createMessage` mock,
 * which refuses a worktree ID the table does not hold (the foreign key).
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

/** What each session's pane shows, by poller key. */
const screens = new Map<string, string>();
const captureSessionOutput = vi.fn(
  async (worktreeId: string, _cli: CLIToolType, _lines: number, instanceId?: string) =>
    codexPane(screens.get(keyOf(worktreeId, instanceId)) ?? `idle reply of ${keyOf(worktreeId, instanceId)}`)
);
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: [string, CLIToolType, number, string | undefined]) => captureSessionOutput(...a),
  isSessionRunning: vi.fn(async () => true),
}));

/** Worktree IDs the table holds; a row for any other ID fails its foreign key. */
const dbWorktrees = new Set<string>();
const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => {
  if (!dbWorktrees.has(String(m.worktreeId))) throw new Error('FOREIGN KEY constraint failed');
  return { id: `msg-${createMessage.mock.calls.length}`, ...m };
});
const sessionLines = new Map<string, number>();
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  getSessionState: (_db: unknown, worktreeId: string, instanceId: string) => ({
    lastCapturedLine: sessionLines.get(`${worktreeId}:${instanceId}`) ?? CACHE_MAX_CAPTURE_LINES - 1,
    inProgressMessageId: null,
  }),
  updateSessionState: (_db: unknown, worktreeId: string, _cli: string, line: number, instanceId: string) => {
    sessionLines.set(`${worktreeId}:${instanceId}`, line);
  },
  getWorktreeById: (_db: unknown, id: string) => ({ id, name: id, path: `/repos/${id}` }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
const broadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: (...a: unknown[]) => broadcastMessage(...a),
}));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-session-ownership', () => ({
  findTerminalSessionRefusal: vi.fn(async () => null),
}));
vi.mock('@/lib/tasks/task-transition-service', () => ({ applyEventToActiveTask: vi.fn() }));
vi.mock('@/lib/tmux/geometry-delegation', () => ({
  probeGeometryDelegation: vi.fn(async () => ({ delegated: false, released: false })),
}));

/**
 * The transcript reader. `captured` = it wrote the turn (the row itself is not
 * modelled: these tests count scraped rows only); `not_yet_closed` = the turn
 * is still open, so the scrape is held; `absent` = nothing to read, so the
 * scrape is saved at once. A gate armed for a key makes the NEXT read of that
 * key wait until the test releases it with an outcome.
 */
type ReaderOutcome = 'captured' | 'not_yet_closed' | 'absent';
interface Gate {
  entered: Promise<void>;
  release: (outcome: ReaderOutcome) => void;
}
const readerOutcome = new Map<string, ReaderOutcome>();
const gates = new Map<string, { enter: () => void; wait: Promise<ReaderOutcome> }>();
const openGates: Array<(outcome: ReaderOutcome) => void> = [];

function armGate(pollerKey: string): Gate {
  let enter!: () => void;
  let release!: (outcome: ReaderOutcome) => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const wait = new Promise<ReaderOutcome>((r) => {
    release = r;
  });
  gates.set(pollerKey, { enter, wait });
  openGates.push(release);
  return { entered, release };
}

vi.mock('@/lib/polling/structured-history-gate', () => ({
  isStructuredHistoryWriterLive: () => false,
  captureStructuredHistoryTurn: async (
    worktreeId: string,
    _cli: CLIToolType,
    instanceId: string | undefined,
    _capture: unknown,
    report?: { outcome?: string }
  ): Promise<boolean> => {
    const pollerKey = keyOf(worktreeId, instanceId);
    const gate = gates.get(pollerKey);
    let outcome = readerOutcome.get(pollerKey) ?? 'not_yet_closed';
    if (gate) {
      gates.delete(pollerKey);
      gate.enter();
      outcome = await gate.wait;
    }
    if (outcome === 'absent') return false;
    if (report) report.outcome = outcome;
    return outcome === 'captured';
  },
}));

import {
  PENDING_SCRAPE_HOLD_MS,
  hasPendingScrapedResponse,
  holdScrapedResponse,
  resetPendingScrapedResponses,
} from '@/lib/polling/pending-scraped-response';
import {
  STALLED_TICK_TIMEOUT,
  migrateResponsePollerWorktreeIds,
  startPolling,
  stopAllPolling,
  stopPolling,
} from '@/lib/polling/response-poller-core';

const POLLING_INTERVAL = 2000;
const WT = { a: 'wt-3663-a', b: 'wt-3663-b', c: 'wt-3663-c' };

/** codex's pane, saturated so the tick is on the content-dedup path (#1670). */
function codexPane(reply: string): string {
  const rows = [
    '› summarize the project',
    '',
    `• ${reply}`,
    '',
    '─'.repeat(120),
    '',
    '› Find and fix a bug in @filename',
    '',
    '  gpt-5.6-sol xhigh · ~/share/work/github_kewton/CommandMate',
  ];
  const filler = new Array(Math.max(0, CACHE_MAX_CAPTURE_LINES - rows.length)).fill(
    '  transcript row that has already scrolled past the window'
  );
  return [...filler, ...rows].join('\n');
}

/** Rows actually written (a call refused by the foreign key is not a row). */
function rows(): Array<Record<string, unknown>> {
  return createMessage.mock.results
    .filter((r) => r.type === 'return')
    .map((r) => r.value as Record<string, unknown>);
}

/** Rows whose content carries `marker`, as `[worktreeId, instanceId]` pairs. */
function rowsWith(marker: string): Array<[unknown, unknown]> {
  return rows()
    .filter((m) => String(m.content).includes(marker))
    .map((m) => [m.worktreeId, m.instanceId]);
}

/** Let every resolved continuation run without moving the clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

/** One polling interval: every armed chain runs one tick. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
  await settle();
}

const resolveAll = (): CLIToolType => TOOL;

/** Seed a held scrape from outside any tick (a caller with no ownership token). */
function seedHold(
  pollerKey: string,
  worktreeId: string,
  instanceId: string,
  content: string,
  extra: { timestamp?: Date; expiresAt?: number; summary?: string; logFileName?: string; requestId?: string } = {}
): void {
  holdScrapedResponse(pollerKey, {
    worktreeId,
    cliToolId: TOOL,
    instanceId,
    content,
    timestamp: extra.timestamp ?? new Date(),
    summary: extra.summary,
    logFileName: extra.logFileName,
    requestId: extra.requestId,
    worktreePath: `/repos/${worktreeId}`,
    transcriptPathHint: null,
    expiresAt: extra.expiresAt ?? Date.now() + PENDING_SCRAPE_HOLD_MS,
  });
}

type Globals = {
  __responseHashCache?: Map<string, string>;
  __structuredHistoryRecheckCache?: Map<string, number>;
  __duplicateResponseSkipStreak?: Map<string, number>;
  __promptHashCache?: Map<string, string>;
  __responsePollerCoordinator?: {
    pausedOnPrompt: Set<string>;
    running: Map<string, unknown>;
  };
};
const g = globalThis as Globals;

function resetState(): void {
  stopAllPolling();
  resetPendingScrapedResponses();
  g.__responsePollerCoordinator?.running.clear();
  g.__responsePollerCoordinator?.pausedOnPrompt.clear();
  g.__responseHashCache?.clear();
  g.__structuredHistoryRecheckCache?.clear();
  g.__duplicateResponseSkipStreak?.clear();
  g.__promptHashCache?.clear();
  screens.clear();
  readerOutcome.clear();
  gates.clear();
  sessionLines.clear();
  dbWorktrees.clear();
  for (const id of Object.values(WT)) dbWorktrees.add(id);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-14T09:00:00.000Z'));
  resetState();
  vi.clearAllMocks();
});

afterEach(async () => {
  // A tick still parked on a gate would otherwise resume in the next test.
  for (const release of openGates.splice(0)) release('not_yet_closed');
  await settle();
  resetState();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// ① A↔B while a tick is in flight
// ---------------------------------------------------------------------------

describe('[#3663] ① a swap while a tick is in flight', () => {
  it('a hold returned by the old tick does not change the scrape moved onto its key', async () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.b, TOOL);
    screens.set(keyOf(WT.a), 'alpha first');
    screens.set(keyOf(WT.b), 'bravo first');
    await tick();
    expect(hasPendingScrapedResponse(keyOf(WT.a))).toBe(true);
    expect(hasPendingScrapedResponse(keyOf(WT.b))).toBe(true);

    screens.set(keyOf(WT.a), 'alpha second');
    const gate = armGate(keyOf(WT.a));
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await gate.entered;

    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.a },
      ],
      resolveAll
    );
    gate.release('not_yet_closed');
    await settle();

    stopPolling(WT.a, TOOL);
    stopPolling(WT.b, TOOL);
    expect(rowsWith('bravo first')).toEqual([[WT.a, TOOL]]);
    expect(rowsWith('alpha first')).toEqual([[WT.b, TOOL]]);
    expect(rowsWith('alpha second')).toEqual([]);
  });

  it('negative: the chain that owns the key after the move holds and updates as before', async () => {
    startPolling(WT.a, TOOL);
    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.c }], resolveAll);

    screens.set(keyOf(WT.c), 'charlie one');
    await tick();
    expect(hasPendingScrapedResponse(keyOf(WT.c))).toBe(true);
    screens.set(keyOf(WT.c), 'charlie two');
    await tick();

    stopPolling(WT.c, TOOL);
    expect(rowsWith('charlie')).toEqual([[WT.c, TOOL]]);
    expect(rowsWith('charlie two')).toEqual([[WT.c, TOOL]]);
  });
});

// ---------------------------------------------------------------------------
// ② the expiry settle resumed across a migration
// ---------------------------------------------------------------------------

describe('[#3663] ② an expiry settle that resumes after a swap', () => {
  async function settleAcrossSwap(outcome: ReaderOutcome): Promise<void> {
    startPolling(WT.a, TOOL);
    screens.set(keyOf(WT.a), 'alpha first');
    await tick();
    expect(hasPendingScrapedResponse(keyOf(WT.a))).toBe(true);

    vi.setSystemTime(Date.now() + PENDING_SCRAPE_HOLD_MS + 1);
    startPolling(WT.b, TOOL);
    screens.set(keyOf(WT.b), 'bravo first');
    const gate = armGate(keyOf(WT.a));
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await gate.entered;
    expect(hasPendingScrapedResponse(keyOf(WT.b))).toBe(true);

    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.a },
      ],
      resolveAll
    );
    gate.release(outcome);
    await settle();
  }

  it('a capture that succeeds does not drop the scrape moved onto the old key', async () => {
    await settleAcrossSwap('captured');

    expect(hasPendingScrapedResponse(keyOf(WT.a))).toBe(true);
    stopPolling(WT.a, TOOL);
    stopPolling(WT.b, TOOL);
    expect(rowsWith('bravo first')).toEqual([[WT.a, TOOL]]);
    expect(rowsWith('alpha first')).toEqual([[WT.b, TOOL]]);
  });

  it('a capture that fails does not write the scrape moved onto the old key', async () => {
    await settleAcrossSwap('not_yet_closed');

    expect(rows()).toEqual([]);
    stopPolling(WT.a, TOOL);
    stopPolling(WT.b, TOOL);
    expect(rowsWith('bravo first')).toEqual([[WT.a, TOOL]]);
    expect(rowsWith('alpha first')).toEqual([[WT.b, TOOL]]);
  });

  it('negative: with no migration, a capture that succeeds drops the scrape', async () => {
    startPolling(WT.a, TOOL);
    screens.set(keyOf(WT.a), 'alpha first');
    await tick();
    vi.setSystemTime(Date.now() + PENDING_SCRAPE_HOLD_MS + 1);
    readerOutcome.set(keyOf(WT.a), 'captured');
    await tick();

    expect(hasPendingScrapedResponse(keyOf(WT.a))).toBe(false);
    stopPolling(WT.a, TOOL);
    expect(rowsWith('alpha first')).toEqual([]);
  });

  it('negative: with no migration, a capture that fails writes the scrape once', async () => {
    startPolling(WT.a, TOOL);
    screens.set(keyOf(WT.a), 'alpha first');
    await tick();
    vi.setSystemTime(Date.now() + PENDING_SCRAPE_HOLD_MS + 1);
    await tick();

    expect(hasPendingScrapedResponse(keyOf(WT.a))).toBe(false);
    expect(rowsWith('alpha first')).toEqual([[WT.a, TOOL]]);
    stopPolling(WT.a, TOOL);
    expect(rowsWith('alpha first')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ③ abandoned chains
// ---------------------------------------------------------------------------

describe('[#3663] ③ a chain the migration could not resolve', () => {
  const resolveExceptAcx = (worktreeId: string, instanceId: string): CLIToolType | null =>
    worktreeId === WT.a && instanceId === 'cx' ? null : TOOL;

  it('a hold returned by its tick creates nothing', async () => {
    startPolling(WT.a, TOOL, 'cx');
    screens.set(keyOf(WT.a, 'cx'), 'alpha cx');
    const gate = armGate(keyOf(WT.a, 'cx'));
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await gate.entered;

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveExceptAcx);
    gate.release('not_yet_closed');
    await settle();

    expect(hasPendingScrapedResponse(keyOf(WT.a, 'cx'))).toBe(false);
    expect(hasPendingScrapedResponse(keyOf(WT.b, 'cx'))).toBe(false);
  });

  it('the recheck discard of its tick leaves another hold under the key alone', async () => {
    startPolling(WT.a, TOOL, 'cx');
    screens.set(keyOf(WT.a, 'cx'), 'alpha cx');
    await tick();
    // The next tick sees the same frame: a duplicate, whose recheck asks the reader.
    const gate = armGate(keyOf(WT.a, 'cx'));
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await gate.entered;

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveExceptAcx);
    seedHold(keyOf(WT.a, 'cx'), WT.a, 'cx', 'someone else');
    gate.release('captured');
    await settle();

    expect(hasPendingScrapedResponse(keyOf(WT.a, 'cx'))).toBe(true);
  });

  it('the save-path discard of its tick leaves another hold under the key alone', async () => {
    startPolling(WT.a, TOOL, 'cx');
    screens.set(keyOf(WT.a, 'cx'), 'alpha cx');
    await tick();
    screens.set(keyOf(WT.a, 'cx'), 'alpha cx second');
    const gate = armGate(keyOf(WT.a, 'cx'));
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await gate.entered;

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveExceptAcx);
    seedHold(keyOf(WT.a, 'cx'), WT.a, 'cx', 'someone else');
    gate.release('captured');
    await settle();

    expect(hasPendingScrapedResponse(keyOf(WT.a, 'cx'))).toBe(true);
  });

  it('negative: a resolvable primary and alias instance both move with their scrapes', async () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.a, TOOL, 'cx');
    screens.set(keyOf(WT.a), 'alpha primary');
    screens.set(keyOf(WT.a, 'cx'), 'alpha alias');
    await tick();

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveAll);

    expect(hasPendingScrapedResponse(keyOf(WT.a))).toBe(false);
    expect(hasPendingScrapedResponse(keyOf(WT.a, 'cx'))).toBe(false);
    stopPolling(WT.b, TOOL);
    stopPolling(WT.b, TOOL, 'cx');
    expect(rowsWith('alpha primary')).toEqual([[WT.b, TOOL]]);
    expect(rowsWith('alpha alias')).toEqual([[WT.b, 'cx']]);
  });
});

// ---------------------------------------------------------------------------
// ④ stop, then migrate, then the old tick comes back
// ---------------------------------------------------------------------------

describe('[#3663] ④ a stopped chain whose tick returns after a migration', () => {
  it('does not bring a held scrape back', async () => {
    startPolling(WT.a, TOOL);
    screens.set(keyOf(WT.a), 'alpha first');
    const gate = armGate(keyOf(WT.a));
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await gate.entered;

    stopPolling(WT.a, TOOL);
    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveAll);
    gate.release('not_yet_closed');
    await settle();

    expect(hasPendingScrapedResponse(keyOf(WT.a))).toBe(false);
    expect(hasPendingScrapedResponse(keyOf(WT.b))).toBe(false);
  });

  it('negative: a restart queued behind the tick still holds, then writes it on the restart', async () => {
    startPolling(WT.a, TOOL);
    screens.set(keyOf(WT.a), 'alpha first');
    const gate = armGate(keyOf(WT.a));
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await gate.entered;

    startPolling(WT.a, TOOL);
    gate.release('not_yet_closed');
    await settle();

    expect(rowsWith('alpha first')).toEqual([[WT.a, TOOL]]);
  });
});

// ---------------------------------------------------------------------------
// ⑤ a stalled tick cut loose by a restart
// ---------------------------------------------------------------------------

describe('[#3663] ⑤ a tick past STALLED_TICK_TIMEOUT', () => {
  it('does not change the hold of the chain that replaced it', async () => {
    startPolling(WT.a, TOOL);
    screens.set(keyOf(WT.a), 'alpha old');
    const gate = armGate(keyOf(WT.a));
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await gate.entered;

    vi.setSystemTime(Date.now() + STALLED_TICK_TIMEOUT + 1);
    startPolling(WT.a, TOOL);
    screens.set(keyOf(WT.a), 'alpha new');
    await tick();
    expect(hasPendingScrapedResponse(keyOf(WT.a))).toBe(true);

    gate.release('not_yet_closed');
    await settle();

    stopPolling(WT.a, TOOL);
    expect(rowsWith('alpha new')).toEqual([[WT.a, TOOL]]);
    expect(rowsWith('alpha old')).toEqual([]);
  });

  it('negative: a restart under a minute waits for the tick and keeps its hold', async () => {
    startPolling(WT.a, TOOL);
    screens.set(keyOf(WT.a), 'alpha old');
    const gate = armGate(keyOf(WT.a));
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await gate.entered;

    vi.setSystemTime(Date.now() + STALLED_TICK_TIMEOUT - 1_000);
    startPolling(WT.a, TOOL);
    gate.release('not_yet_closed');
    await settle();

    expect(rowsWith('alpha old')).toEqual([[WT.a, TOOL]]);
  });
});

// ---------------------------------------------------------------------------
// ⑥ a destination key that already had a chain
// ---------------------------------------------------------------------------

describe('[#3663] ⑥ moving onto a key another chain holds', () => {
  async function bravoHoldingWithTickInFlight(): Promise<Gate> {
    startPolling(WT.b, TOOL);
    screens.set(keyOf(WT.b), 'bravo first');
    await tick();
    expect(hasPendingScrapedResponse(keyOf(WT.b))).toBe(true);
    screens.set(keyOf(WT.b), 'bravo second');
    const gate = armGate(keyOf(WT.b));
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await gate.entered;
    return gate;
  }

  it('a running A: B\'s scrape is written under B, and B\'s old tick cannot touch A\'s', async () => {
    startPolling(WT.a, TOOL);
    screens.set(keyOf(WT.a), 'alpha first');
    await tick();
    const gate = await bravoHoldingWithTickInFlight();

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveAll);
    expect(rowsWith('bravo first')).toEqual([[WT.b, TOOL]]);

    gate.release('not_yet_closed');
    await settle();
    stopPolling(WT.b, TOOL);
    expect(rowsWith('alpha first')).toEqual([[WT.b, TOOL]]);
    expect(rowsWith('bravo second')).toEqual([]);
  });

  it('a paused A: B\'s scrape is written under B, and B\'s old tick holds nothing', async () => {
    g.__responsePollerCoordinator!.pausedOnPrompt.add(keyOf(WT.a));
    const gate = await bravoHoldingWithTickInFlight();

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveAll);
    expect(rowsWith('bravo first')).toEqual([[WT.b, TOOL]]);

    gate.release('not_yet_closed');
    await settle();
    expect(hasPendingScrapedResponse(keyOf(WT.b))).toBe(false);
    expect(g.__responsePollerCoordinator!.pausedOnPrompt.has(keyOf(WT.b))).toBe(true);
  });

  it('negative: another instance of B keeps its scrape and its chain', async () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.b, TOOL, 'cy');
    screens.set(keyOf(WT.b, 'cy'), 'bravo y one');
    await tick();

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveAll);
    expect(rowsWith('bravo y')).toEqual([]);

    screens.set(keyOf(WT.b, 'cy'), 'bravo y two');
    await tick();
    stopPolling(WT.b, TOOL, 'cy');
    expect(rowsWith('bravo y')).toEqual([[WT.b, 'cy']]);
    expect(rowsWith('bravo y two')).toEqual([[WT.b, 'cy']]);
  });

  it('negative: a rename whose source has no chain leaves B\'s scrape and chain alone', async () => {
    startPolling(WT.b, TOOL);
    screens.set(keyOf(WT.b), 'bravo one');
    await tick();

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveAll);
    migrateResponsePollerWorktreeIds([{ oldId: WT.b, newId: WT.b }], resolveAll);
    expect(rows()).toEqual([]);

    screens.set(keyOf(WT.b), 'bravo two');
    await tick();
    stopPolling(WT.b, TOOL);
    expect(rowsWith('bravo')).toEqual([[WT.b, TOOL]]);
    expect(rowsWith('bravo two')).toEqual([[WT.b, TOOL]]);
  });
});

// ---------------------------------------------------------------------------
// ⑦ migration between the hash and the hold
// ---------------------------------------------------------------------------

describe('[#3663] ⑦ a migration after the hash is registered and before the hold', () => {
  it('the successor still holds the unsaved reply and writes it in the end', async () => {
    startPolling(WT.a, TOOL);
    screens.set(keyOf(WT.a), 'alpha only');
    const gate = armGate(keyOf(WT.a));
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await gate.entered;

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveAll);
    screens.set(keyOf(WT.b), 'alpha only');
    // The successor's first tick sees the moved hash and skips the frame.
    await tick();
    gate.release('not_yet_closed');
    await settle();
    await tick();

    expect(hasPendingScrapedResponse(keyOf(WT.b))).toBe(true);
    stopPolling(WT.b, TOOL);
    expect(rowsWith('alpha only')).toEqual([[WT.b, TOOL]]);
  });

  it('negative: a reply already saved is not saved again by the successor', async () => {
    readerOutcome.set(keyOf(WT.a), 'absent');
    startPolling(WT.a, TOOL);
    screens.set(keyOf(WT.a), 'alpha only');
    await tick();
    expect(rowsWith('alpha only')).toEqual([[WT.a, TOOL]]);

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveAll);
    screens.set(keyOf(WT.b), 'alpha only');
    await tick();
    await tick();
    stopPolling(WT.b, TOOL);

    expect(rowsWith('alpha only')).toEqual([[WT.a, TOOL]]);
  });
});

// ---------------------------------------------------------------------------
// ⑧ what a moved scrape carries
// ---------------------------------------------------------------------------

describe('[#3663] ⑧ a moved scrape keeps everything but its worktree ID', () => {
  const T_A = new Date('2026-10-14T08:59:00.000Z');
  const T_B = new Date('2026-10-14T08:59:30.000Z');
  const extraA = { timestamp: T_A, summary: 'sum A', logFileName: 'a.md', requestId: 'req-a' };
  const extraB = { timestamp: T_B, summary: 'sum B', logFileName: 'b.md', requestId: 'req-b' };

  function rowFor(marker: string): Record<string, unknown> | undefined {
    return rows().find((m) => String(m.content).includes(marker));
  }

  it('a swap writes each scrape under the new ID, with its timestamp and metadata, and broadcasts it there', () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.b, TOOL);
    seedHold(keyOf(WT.a), WT.a, TOOL, 'held alpha', extraA);
    seedHold(keyOf(WT.b), WT.b, TOOL, 'held bravo', extraB);

    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.a },
      ],
      resolveAll
    );
    stopPolling(WT.a, TOOL);
    stopPolling(WT.b, TOOL);

    expect(rowFor('held alpha')).toMatchObject({
      worktreeId: WT.b,
      cliToolId: TOOL,
      instanceId: TOOL,
      timestamp: T_A,
      summary: 'sum A',
      logFileName: 'a.md',
      requestId: 'req-a',
    });
    expect(rowFor('held bravo')).toMatchObject({
      worktreeId: WT.a,
      timestamp: T_B,
      summary: 'sum B',
      logFileName: 'b.md',
      requestId: 'req-b',
    });
    expect(broadcastMessage).toHaveBeenCalledWith('message', {
      worktreeId: WT.b,
      message: expect.objectContaining({ content: 'held alpha' }),
    });
    expect(broadcastMessage).toHaveBeenCalledWith('message', {
      worktreeId: WT.a,
      message: expect.objectContaining({ content: 'held bravo' }),
    });
  });

  it('a chain moves each scrape one step and keeps its deadline', async () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.b, TOOL);
    seedHold(keyOf(WT.a), WT.a, TOOL, 'held alpha', { ...extraA, expiresAt: Date.now() + 1_000 });
    seedHold(keyOf(WT.b), WT.b, TOOL, 'held bravo', extraB);

    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.c },
      ],
      resolveAll
    );
    expect(hasPendingScrapedResponse(keyOf(WT.a))).toBe(false);
    stopPolling(WT.c, TOOL);
    expect(rowFor('held bravo')).toMatchObject({ worktreeId: WT.c, timestamp: T_B, requestId: 'req-b' });

    // The deadline came with it: the first tick at B finds it spent and writes.
    expect(rowFor('held alpha')).toBeUndefined();
    await tick();
    expect(rowFor('held alpha')).toMatchObject({ worktreeId: WT.b, timestamp: T_A, requestId: 'req-a' });
  });

  it('a paused chain\'s scrape moves with its pause mark', () => {
    g.__responsePollerCoordinator!.pausedOnPrompt.add(keyOf(WT.a));
    seedHold(keyOf(WT.a), WT.a, TOOL, 'held alpha', extraA);

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveAll);

    expect(g.__responsePollerCoordinator!.pausedOnPrompt.has(keyOf(WT.b))).toBe(true);
    expect(hasPendingScrapedResponse(keyOf(WT.a))).toBe(false);
    stopPolling(WT.b, TOOL);
    expect(rowFor('held alpha')).toMatchObject({ worktreeId: WT.b, timestamp: T_A, summary: 'sum A' });
  });

  it('negative: keys with no scrape, and keys outside the batch, are left as they were', () => {
    startPolling(WT.a, TOOL);
    seedHold(keyOf(WT.c), WT.c, TOOL, 'held charlie', extraB);

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveAll);

    expect(hasPendingScrapedResponse(keyOf(WT.b))).toBe(false);
    expect(hasPendingScrapedResponse(keyOf(WT.c))).toBe(true);
    expect(rows()).toEqual([]);
    stopPolling(WT.c, TOOL);
    expect(rowFor('held charlie')).toMatchObject({ worktreeId: WT.c, timestamp: T_B });
  });
});

// ---------------------------------------------------------------------------
// ⑨ the abandoned chain's scrape is written under the new ID
// ---------------------------------------------------------------------------

describe('[#3663] ⑨ an abandoned chain\'s scrape', () => {
  it('is written under the new ID even though the old one is gone from the table', async () => {
    startPolling(WT.a, TOOL, 'cx');
    screens.set(keyOf(WT.a, 'cx'), 'alpha cx');
    await tick();
    expect(hasPendingScrapedResponse(keyOf(WT.a, 'cx'))).toBe(true);
    // The rename has already been applied to the table.
    dbWorktrees.delete(WT.a);

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], () => null);

    expect(rowsWith('alpha cx')).toEqual([[WT.b, 'cx']]);
    expect(hasPendingScrapedResponse(keyOf(WT.a, 'cx'))).toBe(false);
  });

  it('negative: an ordinary stop under a valid ID writes the scrape exactly once', async () => {
    startPolling(WT.b, TOOL);
    screens.set(keyOf(WT.b), 'bravo only');
    await tick();

    stopPolling(WT.b, TOOL);
    stopPolling(WT.b, TOOL);

    expect(rowsWith('bravo only')).toEqual([[WT.b, TOOL]]);
  });
});
