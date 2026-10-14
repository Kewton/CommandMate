/**
 * A retired tick neither saves a prompt row nor announces a transcript
 * completion under the key it lost (Issue #3701).
 *
 * #3663 and #3684 turned a stopped tick away from the held scrape and the reply
 * saved at once. Two branches still acted after an `await` without asking
 * `mayActForPollerKey`:
 *
 *  1. the prompt branch (`savePromptMessage`), reached after the pane capture —
 *     a tick stopped while the capture was in flight saved the prompt row and
 *     broadcast it. The question is asked before the prompt dedup, so a refused
 *     tick registers no hash and its successor can still save the same prompt;
 *  2. (a) the completion announcement of `captureStructuredHistoryTurn`, made
 *     after the transcript reader's `await`. The question is asked before
 *     `claimCompletionAnnouncement`, so a refused tick claims nothing and its
 *     successor can still announce the same completion. The Stop hook calls the
 *     same function outside any tick, and keeps announcing.
 *
 * Same harness as the #3684 suite: the real chain — timer → `runPollTick` →
 * `pollerOwnerStorage.run` → `checkForResponse` — with the pane capture and the
 * codex transcript reader as fakes the test can hold open. The gate itself and
 * its per-instance queue are the real ones.
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

/**
 * A gate armed for a key makes the NEXT call keyed by it wait until the test
 * releases it. Used for the pane capture and for the transcript reader.
 */
interface Gate<T> {
  entered: Promise<void>;
  release: (value: T) => void;
}
type GateSlot<T> = { enter: () => void; wait: Promise<T> };
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

/** What each session's pane shows, by poller key. */
const screens = new Map<string, string>();
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
  isSessionRunning: vi.fn(async () => true),
}));

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({
  id: `msg-${createMessage.mock.calls.length}`,
  ...m,
}));
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
const notifyPushSubscribers = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: (...a: unknown[]) => notifyPushSubscribers(...a) }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-session-ownership', () => ({
  findTerminalSessionRefusal: vi.fn(async () => null),
}));
const applyEventToActiveTask = vi.fn();
vi.mock('@/lib/tasks/task-transition-service', () => ({
  applyEventToActiveTask: (...a: unknown[]) => applyEventToActiveTask(...a),
}));
vi.mock('@/lib/tmux/geometry-delegation', () => ({
  probeGeometryDelegation: vi.fn(async () => ({ delegated: false, released: false })),
}));

/** The relay's completion edge, counted as `[worktreeId, instanceId, settled]`. */
const relayCalls = vi.hoisted(() => [] as Array<[string, string | undefined, boolean]>);
vi.mock('@/lib/relay/relay-triggers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/relay-triggers')>()),
  onRelayTurnCompleted: (worktreeId: string, _cli: string, instanceId: string | undefined, settled: boolean) => {
    relayCalls.push([worktreeId, instanceId, settled]);
  },
}));

/**
 * The codex transcript reader the real gate calls. `captured` writes the turn
 * (the row itself is not modelled) and reports it settled under
 * `completionKey`; `absent` has nothing to read.
 */
type ReaderOutcome = 'captured' | 'absent';
const readerGates = new Map<string, GateSlot<ReaderOutcome>>();
const readerOutcome = new Map<string, ReaderOutcome>();
const reader = vi.hoisted(() => ({ completionKey: 'turn-1' as string | undefined }));
vi.mock('@/lib/hooks/sources/codex/history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/codex/history')>()),
  resolveCodexTranscriptPath: vi.fn(async () => null),
  captureCodexTranscriptTurn: async (
    target: { worktreeId: string; instanceId?: string },
    _capture: unknown,
    report?: { outcome?: string; completion?: string; completionKey?: string }
  ): Promise<boolean> => {
    const key = keyOf(target.worktreeId, target.instanceId);
    const outcome = await passGate(readerGates, key, readerOutcome.get(key) ?? 'captured');
    if (outcome === 'absent') return false;
    if (report) {
      report.outcome = 'captured';
      report.completion = 'settled';
      report.completionKey = reader.completionKey;
    }
    return true;
  },
}));

import {
  captureStructuredHistoryTurn,
  resetStructuredHistoryCaptureQueue,
} from '@/lib/polling/structured-history-gate';
import { resetPendingScrapedResponses } from '@/lib/polling/pending-scraped-response';
import {
  STALLED_TICK_TIMEOUT,
  startPolling,
  stopAllPolling,
  stopPolling,
} from '@/lib/polling/response-poller-core';

const POLLING_INTERVAL = 2000;
const WT = { a: 'wt-3701-a', b: 'wt-3701-b' };

/** Filler that saturates the capture window, as a long session's pane does. */
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

/** codex's pane on its command-approval dialog. */
function codexPromptPane(command: string): string {
  return saturate([
    '› run the tests',
    '',
    '• I will run the test suite.',
    '',
    'Would you like to run the following command?',
    '',
    `  $ ${command}`,
    '',
    '› 1. Yes, proceed (y)',
    "  2. Yes, and don't ask again for commands that start with `npm` (p)",
    '  3. No, and tell Codex what to do differently (esc)',
    '',
    '  Press enter to confirm or esc to cancel',
  ]);
}

/** Prompt rows carrying `marker`, as `[worktreeId, instanceId]` pairs. */
function promptRowsWith(marker: string): Array<[unknown, unknown]> {
  return createMessage.mock.results
    .filter((r) => r.type === 'return')
    .map((r) => r.value as Record<string, unknown>)
    .filter((m) => m.messageType === 'prompt' && String(m.content).includes(marker))
    .map((m) => [m.worktreeId, m.instanceId]);
}

/** `message` broadcasts of prompt rows carrying `marker`, as worktree IDs. */
function promptBroadcastsWith(marker: string): unknown[] {
  return broadcastMessage.mock.calls
    .filter(([event, payload]) => {
      const message = (payload as { message?: { content?: unknown; messageType?: unknown } }).message;
      return event === 'message' && message?.messageType === 'prompt' && String(message.content).includes(marker);
    })
    .map(([, payload]) => (payload as { worktreeId: unknown }).worktreeId);
}

/** Settled relay edges (the gate's own announcements) for `worktreeId`. */
function settledEdgesFor(worktreeId: string): number {
  return relayCalls.filter(([id, , settled]) => id === worktreeId && settled).length;
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
  resetStructuredHistoryCaptureQueue();
  g.__responsePollerCoordinator?.running.clear();
  g.__responsePollerCoordinator?.pausedOnPrompt.clear();
  g.__responseHashCache?.clear();
  g.__structuredHistoryRecheckCache?.clear();
  g.__duplicateResponseSkipStreak?.clear();
  g.__promptHashCache?.clear();
  screens.clear();
  captureGates.clear();
  readerGates.clear();
  readerOutcome.clear();
  sessionLines.clear();
  relayCalls.length = 0;
  reader.completionKey = 'turn-1';
}

/** Start A and park its next tick on the pane capture. */
async function alphaTickAtCapture(): Promise<Gate<string | null>> {
  startPolling(WT.a, TOOL);
  const gate = armGate(captureGates, keyOf(WT.a), null);
  await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
  await gate.entered;
  return gate;
}

/** Start A, show `reply`, and park its next tick on the transcript reader. */
async function alphaTickAtReader(reply: string): Promise<Gate<ReaderOutcome>> {
  startPolling(WT.a, TOOL);
  screens.set(keyOf(WT.a), codexReplyPane(reply));
  const gate = armGate(readerGates, keyOf(WT.a), 'absent');
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
  for (const release of openReleases.splice(0)) release();
  await settle();
  resetState();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. the prompt branch
// ---------------------------------------------------------------------------

describe('[#3701] 1. a tick stopped while it awaits the pane capture', () => {
  it('saves no prompt row and broadcasts no message for the prompt it then sees', async () => {
    const gate = await alphaTickAtCapture();

    stopPolling(WT.a, TOOL);
    gate.release(codexPromptPane('npm test -- alpha'));
    await settle();

    expect(promptRowsWith('npm test -- alpha')).toEqual([]);
    expect(promptBroadcastsWith('npm test -- alpha')).toEqual([]);
    expect(applyEventToActiveTask).not.toHaveBeenCalled();
    expect(notifyPushSubscribers).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      'prompt-save-refused',
      expect.objectContaining({ worktreeId: WT.a, cliToolId: TOOL, instanceId: TOOL })
    );
  });

  it('leaves the prompt dedup untouched, so the successor saves the same prompt', async () => {
    const gate = await alphaTickAtCapture();

    stopPolling(WT.a, TOOL);
    gate.release(codexPromptPane('npm test -- alpha'));
    await settle();
    expect(promptRowsWith('npm test -- alpha')).toEqual([]);

    startPolling(WT.a, TOOL);
    await tick();

    expect(promptRowsWith('npm test -- alpha')).toEqual([[WT.a, TOOL]]);
    expect(promptBroadcastsWith('npm test -- alpha')).toEqual([WT.a]);
  });

  it('negative: a tick that still owns the key saves and broadcasts the prompt', async () => {
    const gate = await alphaTickAtCapture();

    gate.release(codexPromptPane('npm test -- alpha'));
    await settle();

    expect(promptRowsWith('npm test -- alpha')).toEqual([[WT.a, TOOL]]);
    expect(promptBroadcastsWith('npm test -- alpha')).toEqual([WT.a]);
    expect(applyEventToActiveTask).toHaveBeenCalledTimes(1);
  });

  it('negative: a merely superseded tick saves and broadcasts the prompt', async () => {
    const gate = await alphaTickAtCapture();

    vi.setSystemTime(Date.now() + STALLED_TICK_TIMEOUT - 1_000);
    startPolling(WT.a, TOOL);
    gate.release(codexPromptPane('npm test -- alpha'));
    await settle();

    expect(promptRowsWith('npm test -- alpha')).toEqual([[WT.a, TOOL]]);
    expect(promptBroadcastsWith('npm test -- alpha')).toEqual([WT.a]);
  });

  it('negative: stopping another key does not refuse this tick', async () => {
    startPolling(WT.b, TOOL);
    const gate = await alphaTickAtCapture();

    stopPolling(WT.b, TOOL);
    gate.release(codexPromptPane('npm test -- alpha'));
    await settle();

    expect(promptRowsWith('npm test -- alpha')).toEqual([[WT.a, TOOL]]);
  });
});

// ---------------------------------------------------------------------------
// 2 (a). the transcript gate's completion announcement
// ---------------------------------------------------------------------------

describe('[#3701] 2(a) a tick stopped while it awaits the transcript reader', () => {
  it('announces no completion for the turn the reader then captures', async () => {
    const gate = await alphaTickAtReader('alpha done');

    stopPolling(WT.a, TOOL);
    gate.release('captured');
    await settle();

    expect(settledEdgesFor(WT.a)).toBe(0);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'structured-history-completion-refused',
      expect.objectContaining({ worktreeId: WT.a, cliToolId: TOOL, instanceId: TOOL })
    );
  });

  it('claims nothing, so the successor announces the same completion', async () => {
    const gate = await alphaTickAtReader('alpha done');

    stopPolling(WT.a, TOOL);
    gate.release('captured');
    await settle();
    expect(settledEdgesFor(WT.a)).toBe(0);

    startPolling(WT.a, TOOL);
    await tick();

    expect(settledEdgesFor(WT.a)).toBe(1);
  });

  it('negative: a tick that still owns the key announces once', async () => {
    const gate = await alphaTickAtReader('alpha done');

    gate.release('captured');
    await settle();

    expect(settledEdgesFor(WT.a)).toBe(1);
  });

  it('negative: a merely superseded tick announces once', async () => {
    const gate = await alphaTickAtReader('alpha done');

    vi.setSystemTime(Date.now() + STALLED_TICK_TIMEOUT - 1_000);
    startPolling(WT.a, TOOL);
    gate.release('captured');
    await settle();

    expect(settledEdgesFor(WT.a)).toBe(1);
  });

  it('negative: the Stop hook (outside any tick) announces, even while a stopped tick waits in the queue', async () => {
    const gate = await alphaTickAtReader('alpha done');
    stopPolling(WT.a, TOOL);

    // Queued behind the stopped tick's read on the gate's per-instance queue.
    const fromHook = captureStructuredHistoryTurn(WT.a, TOOL, undefined, { worktreePath: '/repos/wt-3701-a' });
    gate.release('captured');
    await settle();

    expect(await fromHook).toBe(true);
    expect(settledEdgesFor(WT.a)).toBe(1);
  });

  it('negative: the Stop hook with no tick at all announces', async () => {
    expect(await captureStructuredHistoryTurn(WT.a, TOOL, undefined, { worktreePath: '/repos/wt-3701-a' })).toBe(true);
    expect(settledEdgesFor(WT.a)).toBe(1);
  });

  it('the refused tick still takes the reader\'s capture as the save: no scraped row', async () => {
    const gate = await alphaTickAtReader('alpha done');

    stopPolling(WT.a, TOOL);
    gate.release('captured');
    await settle();

    // Only the announcement is refused; the return value is the reader's, so
    // the scraped copy is suppressed exactly as when the tick owns the key.
    expect(
      createMessage.mock.calls.filter(([, m]) => String((m as { content?: unknown }).content).includes('alpha done'))
    ).toEqual([]);
  });
});
