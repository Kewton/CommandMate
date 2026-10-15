/**
 * A tick whose chain was retired writes no row, broadcast or relay edge from
 * the immediate-save branch (Issue #3684).
 *
 * #3663 turned a retired tick away from the held-scrape store and the hash
 * registration, but the other branch of `recordOrHoldScrapedResponse` — the
 * reply saved at once because the transcript reader had nothing to say — still
 * ran `createMessage` → `broadcastMessage` → `onRelayTurnCompleted` under the
 * key the tick had lost (a stop, a restart past `STALLED_TICK_TIMEOUT`, a
 * worktree-ID migration). The rule is the same `mayActForPollerKey` question.
 *
 * Same harness as the #3663 suite: every case goes through the real chain —
 * timer → `runPollTick` → `ownerStorage.run` → `checkForResponse` — with the
 * transcript reader (and here the Markdown log, the last `await` before the
 * row) as fakes the test can hold open. The reader answers `absent`, which is
 * what sends the scrape down the immediate-save branch.
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
/**
 * The Markdown log, the save path's last `await` before the row. A test sets
 * `conversationLog.wait` to hold the tick there.
 */
const conversationLog = vi.hoisted(() => ({
  wait: null as null | (() => Promise<void>),
  calls: 0,
}));
vi.mock('@/lib/conversation-logger', () => ({
  recordClaudeConversation: async () => {
    conversationLog.calls++;
    const wait = conversationLog.wait;
    conversationLog.wait = null;
    if (wait) await wait();
  },
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-session-ownership', () => ({
  findTerminalSessionRefusal: vi.fn(async () => null),
}));
vi.mock('@/lib/tasks/task-transition-service', () => ({ applyEventToActiveTask: vi.fn() }));

/**
 * The relay's completion edge, which the save path fires from INSIDE the tick:
 * whatever the relay does next (deliver to the requester, `sendUserMessage`,
 * `startPolling` of the requester's session) runs with the worker's tick's
 * ownership token still in its async context. A test sets the hook to stand
 * in for that delivery.
 */
const relay = vi.hoisted(() => ({
  hook: null as null | ((worktreeId: string, cliToolId: string, instanceId: string | undefined) => void),
  calls: [] as Array<[string, string | undefined]>,
}));
vi.mock('@/lib/relay/relay-triggers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/relay-triggers')>()),
  onRelayTurnCompleted: (worktreeId: string, cliToolId: string, instanceId: string | undefined) => {
    relay.calls.push([worktreeId, instanceId]);
    relay.hook?.(worktreeId, cliToolId, instanceId);
  },
}));
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

import { hasPendingScrapedResponse, resetPendingScrapedResponses } from '@/lib/polling/pending-scraped-response';
import {
  STALLED_TICK_TIMEOUT,
  getActivePollers,
  migrateResponsePollerWorktreeIds,
  startPolling,
  stopAllPolling,
  stopPolling,
} from '@/lib/polling/response-poller-core';

const POLLING_INTERVAL = 2000;
const WT = { a: 'wt-3684-a', b: 'wt-3684-b', c: 'wt-3684-c' };

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
  relay.hook = null;
  relay.calls.length = 0;
  conversationLog.wait = null;
  conversationLog.calls = 0;
  dbWorktrees.clear();
  for (const id of Object.values(WT)) dbWorktrees.add(id);
}

/** `message` broadcasts carrying `marker`, as worktree IDs. */
function broadcastsWith(marker: string): unknown[] {
  return broadcastMessage.mock.calls
    .filter(
      ([event, payload]) =>
        event === 'message' &&
        String((payload as { message?: { content?: unknown } }).message?.content).includes(marker)
    )
    .map(([, payload]) => (payload as { worktreeId: unknown }).worktreeId);
}

/** Relay completion edges for `worktreeId`. */
function relayEdgesFor(worktreeId: string): number {
  return relay.calls.filter(([id]) => id === worktreeId).length;
}

/** Every key's reader answers `absent`: a finished reply is saved at once. */
function saveAtOnce(...keys: string[]): void {
  for (const key of keys) readerOutcome.set(key, 'absent');
}

/** Start A, show `reply`, and park A's next tick on the transcript reader. */
async function alphaTickAtReader(reply: string): Promise<Gate> {
  startPolling(WT.a, TOOL);
  screens.set(keyOf(WT.a), reply);
  const gate = armGate(keyOf(WT.a));
  await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
  await gate.entered;
  return gate;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T09:00:00.000Z'));
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
// ① retired while awaiting the reader
// ---------------------------------------------------------------------------

describe('[#3684] ① a tick retired while it awaits the reader', () => {
  it('stopped, then migrated: no row, broadcast or relay edge under the old ID', async () => {
    const gate = await alphaTickAtReader('alpha old');

    stopPolling(WT.a, TOOL);
    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveAll);
    gate.release('absent');
    await settle();

    expect(createMessage).not.toHaveBeenCalled();
    expect(broadcastsWith('alpha old')).toEqual([]);
    expect(relayEdgesFor(WT.a)).toBe(0);
  });

  it('migrated while running: no row, broadcast or relay edge under the old ID', async () => {
    const gate = await alphaTickAtReader('alpha old');

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveAll);
    gate.release('absent');
    await settle();

    expect(rowsWith('alpha old')).toEqual([]);
    expect(broadcastsWith('alpha old')).toEqual([]);
    expect(relayEdgesFor(WT.a)).toBe(0);
  });

  it('negative: the chain that still owns the key writes, broadcasts and announces once each', async () => {
    const gate = await alphaTickAtReader('alpha only');

    gate.release('absent');
    await settle();

    expect(rowsWith('alpha only')).toEqual([[WT.a, TOOL]]);
    expect(broadcastsWith('alpha only')).toEqual([WT.a]);
    expect(relayEdgesFor(WT.a)).toBe(1);
  });

  it('negative: the successor under the new ID saves its own reply once', async () => {
    const gate = await alphaTickAtReader('alpha old');
    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveAll);
    gate.release('absent');
    await settle();

    saveAtOnce(keyOf(WT.b));
    screens.set(keyOf(WT.b), 'bravo new');
    await tick();

    expect(rowsWith('bravo new')).toEqual([[WT.b, TOOL]]);
    expect(broadcastsWith('bravo new')).toEqual([WT.b]);
    expect(relayEdgesFor(WT.b)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ② STALLED_TICK_TIMEOUT
// ---------------------------------------------------------------------------

describe('[#3684] ② a restart while the tick awaits the reader', () => {
  it('past STALLED_TICK_TIMEOUT: the cut-loose tick saves nothing', async () => {
    const gate = await alphaTickAtReader('alpha old');

    vi.setSystemTime(Date.now() + STALLED_TICK_TIMEOUT + 1);
    startPolling(WT.a, TOOL);
    gate.release('absent');
    await settle();

    expect(rowsWith('alpha old')).toEqual([]);
    expect(broadcastsWith('alpha old')).toEqual([]);
    expect(relayEdgesFor(WT.a)).toBe(0);

    // The chain that replaced it saves its own reply.
    saveAtOnce(keyOf(WT.a));
    screens.set(keyOf(WT.a), 'alpha new');
    await tick();
    expect(rowsWith('alpha new')).toEqual([[WT.a, TOOL]]);
  });

  it('negative: under a minute the merely superseded tick saves, and the queued restart still runs', async () => {
    const gate = await alphaTickAtReader('alpha old');

    vi.setSystemTime(Date.now() + STALLED_TICK_TIMEOUT - 1_000);
    startPolling(WT.a, TOOL);
    gate.release('absent');
    await settle();

    expect(rowsWith('alpha old')).toEqual([[WT.a, TOOL]]);
    expect(broadcastsWith('alpha old')).toEqual([WT.a]);
    expect(relayEdgesFor(WT.a)).toBe(1);

    // The restart was applied in the tick's epilogue: a new chain polls.
    expect(getActivePollers()).toContain(keyOf(WT.a));
    saveAtOnce(keyOf(WT.a));
    screens.set(keyOf(WT.a), 'alpha new');
    await tick();
    expect(rowsWith('alpha new')).toEqual([[WT.a, TOOL]]);
  });
});

// ---------------------------------------------------------------------------
// ③ paused / another key from inside a stopped tick
// ---------------------------------------------------------------------------

describe('[#3684] ③ a resumed pause, and another key restarted from a stopped tick', () => {
  it('negative: a chain resumed after a prompt pause saves as the same turn', async () => {
    startPolling(WT.a, TOOL);
    // What `settleSelfStop` leaves after a prompt: the chain stopped and the key paused.
    stopPolling(WT.a, TOOL);
    g.__responsePollerCoordinator!.pausedOnPrompt.add(keyOf(WT.a));
    startPolling(WT.a, TOOL);

    saveAtOnce(keyOf(WT.a));
    screens.set(keyOf(WT.a), 'alpha resumed');
    await tick();

    expect(rowsWith('alpha resumed')).toEqual([[WT.a, TOOL]]);
    expect(relayEdgesFor(WT.a)).toBe(1);
  });

  it('a stopped A cannot save under its own key, while B restarted in A\'s context still saves', async () => {
    const gate = await alphaTickAtReader('alpha old');
    stopPolling(WT.a, TOOL);
    // The Markdown log runs in A's async context, after A was stopped.
    conversationLog.wait = async () => {
      startPolling(WT.b, TOOL);
    };
    gate.release('absent');
    await settle();

    expect(conversationLog.calls).toBe(1);
    expect(rowsWith('alpha old')).toEqual([]);
    expect(relayEdgesFor(WT.a)).toBe(0);

    saveAtOnce(keyOf(WT.b));
    screens.set(keyOf(WT.b), 'bravo first');
    await tick();
    expect(rowsWith('bravo first')).toEqual([[WT.b, TOOL]]);
    expect(broadcastsWith('bravo first')).toEqual([WT.b]);
    expect(relayEdgesFor(WT.b)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ④ the last await before the save
// ---------------------------------------------------------------------------

describe('[#3684] ④ retired during the last await before the save', () => {
  async function alphaTickAtConversationLog(): Promise<{ entered: Promise<void>; release: () => void }> {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const wait = new Promise<void>((r) => {
      release = r;
    });
    conversationLog.wait = () => {
      enter();
      return wait;
    };
    saveAtOnce(keyOf(WT.a));
    startPolling(WT.a, TOOL);
    screens.set(keyOf(WT.a), 'alpha only');
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await entered;
    return { entered, release };
  }

  it('a stop there means no row, broadcast or relay edge', async () => {
    const log = await alphaTickAtConversationLog();

    stopPolling(WT.a, TOOL);
    log.release();
    await settle();

    expect(rowsWith('alpha only')).toEqual([]);
    expect(broadcastsWith('alpha only')).toEqual([]);
    expect(relayEdgesFor(WT.a)).toBe(0);
  });

  it('negative: with no retirement the row, broadcast and relay edge follow', async () => {
    const log = await alphaTickAtConversationLog();

    log.release();
    await settle();

    expect(rowsWith('alpha only')).toEqual([[WT.a, TOOL]]);
    expect(broadcastsWith('alpha only')).toEqual([WT.a]);
    expect(relayEdgesFor(WT.a)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ⑤ many-to-one (item 2 of the Issue, pinned as found — not changed here)
// ---------------------------------------------------------------------------

describe('[#3684] ⑤ two sources moved onto one key', () => {
  it('the overwritten chain\'s timer fires without running the checker and leaves the successor registered', async () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.b, TOOL);

    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.c },
        { oldId: WT.b, newId: WT.c },
      ],
      resolveAll
    );
    expect(getActivePollers()).toEqual([keyOf(WT.c)]);

    captureSessionOutput.mockClear();
    await tick();
    // Two timers fired for C; only the chain that owns C read the pane.
    expect(captureSessionOutput.mock.calls.filter(([id]) => id === WT.c)).toHaveLength(1);
    expect(getActivePollers()).toEqual([keyOf(WT.c)]);

    captureSessionOutput.mockClear();
    await tick();
    expect(captureSessionOutput.mock.calls.filter(([id]) => id === WT.c)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ⑥ the hold branch's completion edge (integrity review P2)
// ---------------------------------------------------------------------------

describe('[#3684] ⑥ the completion edge of the hold branch', () => {
  it('a tick stopped while it awaits the reader has its hold refused and announces nothing', async () => {
    const gate = await alphaTickAtReader('alpha old');

    stopPolling(WT.a, TOOL);
    gate.release('not_yet_closed');
    await settle();

    expect(hasPendingScrapedResponse(keyOf(WT.a))).toBe(false);
    expect(relayEdgesFor(WT.a)).toBe(0);
  });

  it('negative: the chain that owns the key holds and announces once', async () => {
    const gate = await alphaTickAtReader('alpha only');

    gate.release('not_yet_closed');
    await settle();

    expect(hasPendingScrapedResponse(keyOf(WT.a))).toBe(true);
    expect(relayEdgesFor(WT.a)).toBe(1);
  });

  it('negative: a merely superseded tick holds and announces once, and the restart writes the hold', async () => {
    const gate = await alphaTickAtReader('alpha old');

    vi.setSystemTime(Date.now() + STALLED_TICK_TIMEOUT - 1_000);
    startPolling(WT.a, TOOL);
    gate.release('not_yet_closed');
    await settle();

    expect(relayEdgesFor(WT.a)).toBe(1);
    expect(rowsWith('alpha old')).toEqual([[WT.a, TOOL]]);
  });
});
