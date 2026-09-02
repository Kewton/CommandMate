/**
 * One reply, one row — over a real database (Issue #2223).
 *
 * The unit suite pins the coordinator's bookkeeping. This one asks the question
 * the bug was actually reported as: *does the same agent reply land in History
 * twice?* It runs the real `checkForResponse` against a real SQLite file, with
 * only the boundaries stubbed (tmux capture, push, sockets, the Claude
 * transcript reader), and starts the poller from **two separate module
 * instances** — the closest a test gets to `next start`'s topology, where the
 * custom server's graph and a route bundle each evaluate the poller once.
 *
 * Why the duplicate survived every existing guard: the content-hash dedup that
 * stops an alternate-screen reply being saved on every 2-second tick
 * (`response-dedup.ts`, Issue #1268) was module scope too. Two poller instances
 * meant two hash caches, so each one's first save looked like a brand-new
 * screen to it. Sharing the registry without sharing that cache would fix the
 * count of timers and leave the duplicate row — which is why both moved.
 *
 * Claude is the tool under test because it renders in the alternate screen
 * (`usesAlternateScreen`) without being a full-screen TUI: the poller keeps
 * ticking after the save, so "saved once" has to be maintained by the dedup
 * cache tick after tick rather than by the chain stopping.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const stubs = vi.hoisted(() => ({
  captureSessionOutput: vi.fn<(...a: unknown[]) => Promise<string>>(),
  isSessionRunning: vi.fn<(...a: unknown[]) => Promise<boolean>>(),
  db: { current: null as Database.Database | null },
}));

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => stubs.captureSessionOutput(...a),
  isSessionRunning: (...a: unknown[]) => stubs.isSessionRunning(...a),
}));
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => stubs.db.current,
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshot: vi.fn(async () => {}),
}));
vi.mock('@/lib/polling/structured-history-gate', () => ({
  isStructuredHistoryWriterLive: vi.fn(() => false),
  captureStructuredHistoryTurn: vi.fn(async () => false),
}));

import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

const WT = 'wt-2223-db';
const POLLING_INTERVAL = 2000;

// ---------------------------------------------------------------------------
// Fixture: a saturated Claude alternate-screen pane carrying one finished turn.
// Same shape as the #1268 / #2121 fixtures — the footer is pinned to the bottom
// rows, so extraction anchors on it and the trimmed line count saturates at the
// pane height. A short pane would save nothing and every assertion would pass
// vacuously, so the sanity test below measures the premise first.
// ---------------------------------------------------------------------------

const SEPARATOR = '─'.repeat(40);
const REPLY = '⏺ CommandMate is a Git worktree management tool.';
const TURN_2_REPLY = '⏺ I ran the test suite and everything passes.';

function claudePane(paneHeight = 1000, reply: string = REPLY): string {
  const head = ['❯ summarize the project', reply];
  const tail = ['', SEPARATOR, '❯ ', SEPARATOR, '  ⏸ manual mode on · ? for shortcuts'];
  const filler = new Array(paneHeight - head.length - tail.length).fill('');
  return [...head, ...filler, ...tail].join('\n');
}

/**
 * The same pane while Claude is still working: the spinner row where the reply
 * would be, so `extractResponse` reports the turn incomplete and nothing is
 * saved. This is what the pane really looks like right after a `/send`, and the
 * reason a restart's dedup reset does not normally re-save the previous reply.
 */
function generatingPane(paneHeight = 1000): string {
  const head = ['❯ run the tests', '✳ Thinking… (esc to interrupt)'];
  const tail = ['', SEPARATOR, '❯ ', SEPARATOR, '  ⏸ manual mode on · ? for shortcuts'];
  const filler = new Array(paneHeight - head.length - tail.length).fill('');
  return [...head, ...filler, ...tail].join('\n');
}

interface Bundle {
  core: typeof import('@/lib/polling/response-poller-core');
}

async function loadBundle(): Promise<Bundle> {
  vi.resetModules();
  return { core: await import('@/lib/polling/response-poller-core') };
}

interface CoordinatorShape {
  activePollers: Map<string, NodeJS.Timeout>;
  pollingStartTimes: Map<string, number>;
  owners: Map<string, unknown>;
  running: Map<string, unknown>;
  pendingRestart: Map<string, unknown>;
}

/** `globalThis` outlives `vi.resetModules()`; timers first, then the maps. */
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

function assistantRows(db: Database.Database): string[] {
  return db
    .prepare("SELECT content FROM chat_messages WHERE role = 'assistant' ORDER BY rowid")
    .all()
    .map((row) => String((row as { content: string }).content));
}

describe('two poller instances, one saved reply (Issue #2223)', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    resetProcessState();
    db = new Database(':memory:');
    runMigrations(db);
    stubs.db.current = db;

    const worktree: Worktree = {
      id: WT,
      name: 'Poller Singleton',
      path: '/repos/wt-2223-db',
      branch: 'main',
      status: 'ready',
      repositoryPath: '/repos',
      repositoryName: 'repos',
      updatedAt: new Date(),
    };
    upsertWorktree(db, worktree);

    stubs.isSessionRunning.mockResolvedValue(true);
    stubs.captureSessionOutput.mockResolvedValue(claudePane());
  });

  afterEach(() => {
    resetProcessState();
    vi.useRealTimers();
    stubs.db.current = null;
    db.close();
    vi.clearAllMocks();
  });

  it('sanity: one poller does save the reply', async () => {
    // The premise every "exactly one" assertion below is measured against. A
    // fixture the extractor rejects would make them all pass for free.
    const a = await loadBundle();

    a.core.startPolling(WT, 'claude');
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);

    expect(assistantRows(db)).toHaveLength(1);
    expect(assistantRows(db)[0]).toContain('Git worktree management tool');
  });

  it('writes one chat_messages row when both module instances start the poller', async () => {
    const a = await loadBundle();
    const b = await loadBundle();
    expect(a.core).not.toBe(b.core);

    // The production sequence: a timer restored by the custom server starts the
    // poller, and the next `/send` through a route bundle starts it again.
    a.core.startPolling(WT, 'claude');
    b.core.startPolling(WT, 'claude');

    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL * 5);

    expect(assistantRows(db)).toEqual([expect.stringContaining('Git worktree management tool')]);
    // And only one chain is doing the capturing.
    expect(a.core.getActivePollers()).toEqual([`${WT}:claude`]);
  });

  it('a restart mid-capture leaves one chain capturing, and one row per turn', async () => {
    const a = await loadBundle();
    const b = await loadBundle();

    // Turn 1 finishes and is recorded normally.
    a.core.startPolling(WT, 'claude');
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    expect(assistantRows(db)).toHaveLength(1);

    // The next tick is inside its tmux capture when the user sends again.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubs.captureSessionOutput.mockImplementationOnce(async () => {
      await gate;
      return claudePane();
    });
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);

    // `/send` lands in exactly the window where `clearTimeout` is useless,
    // because the timer has already fired. The pane moves on to the new turn.
    b.core.startPolling(WT, 'claude');
    stubs.captureSessionOutput.mockResolvedValue(generatingPane());
    release();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // The superseded tick saw turn 1's screen, which is already recorded, so it
    // adds nothing — and it must not have left a chain of its own behind.
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    expect(assistantRows(db)).toHaveLength(1);
    expect(a.core.getActivePollers()).toEqual([`${WT}:claude`]);

    // One chain means one capture per interval. Two (the re-registered tick plus
    // its successor) would double this, and would then record turn 2 twice —
    // each with its own dedup cache.
    const before = stubs.captureSessionOutput.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL * 3);
    expect(stubs.captureSessionOutput.mock.calls.length - before).toBe(3);

    // Turn 2 arrives and is recorded exactly once.
    stubs.captureSessionOutput.mockResolvedValue(claudePane(1000, TURN_2_REPLY));
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL * 3);
    expect(assistantRows(db)).toEqual([
      expect.stringContaining('Git worktree management tool'),
      expect.stringContaining('ran the test suite'),
    ]);
  });
});
