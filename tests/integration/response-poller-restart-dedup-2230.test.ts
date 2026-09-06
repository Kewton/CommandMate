/**
 * A restart with the previous turn still on screen saves that turn once
 * (Issue #2230).
 *
 * `stopPollingByKey()` clears the response hash (Issue #1268) so that the next
 * turn can record a reply identical to the previous one. The Issue asks whether
 * that clear can fire while the pane is still showing the turn it protects, so
 * that the same finished screen is saved a second time — and, if so, whether
 * production ever reaches that state.
 *
 * It does, on one path, measured here against the real `checkForResponse` and a
 * real SQLite file (only tmux, sockets, push and the transcript reader are
 * stubbed):
 *
 *   1. turn A finishes; the poller records it and keeps ticking (claude renders
 *      in the alternate screen, so the content hash is what stops the static
 *      screen being saved on every tick);
 *   2. claude paints a dialog of its own AFTER the turn — observed live on
 *      2026-09-01 as `Teach auto mode about your environment?` — and the
 *      poller's prompt path records it and HALTS the chain, which cleared the
 *      hash;
 *   3. the operator answers through the dialog card, `/respond` calls
 *      `startPolling()` again, and the first tick sees the pane back on turn
 *      A's finished screen: without the hash, A is recorded again.
 *
 * `/send` does NOT reach it: the send is read-back verified and claude echoes
 * every submission — slash commands included — as a `❯ …` transcript row, so
 * the extraction anchor has moved off turn A before `startPolling()` runs
 * (the second block below pins that).
 *
 * The fix keeps the response hash across a chain that halted itself on a
 * prompt ("paused") and across the restart that resumes it, while a restart of
 * a RUNNING chain — the `/send` shape — still opens a new cycle. The #1268
 * guarantee is therefore asserted here too, through the new path: after the
 * resume, a `/send`-shaped restart followed by an identical reply records it.
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
// Issue #2317 Phase D asks tmux who owns the pane geometry on every claude poll.
// That is a real child process, which fake timers cannot drive: left unstubbed,
// the tick settles after the test has closed the database.
vi.mock('@/lib/tmux/geometry-delegation', () => ({
  probeGeometryDelegation: vi.fn(async () => ({ delegated: false, released: false })),
}));

import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

const WT = 'wt-2230-db';
const KEY = `${WT}:claude`;
const POLLING_INTERVAL = 2000;

// ---------------------------------------------------------------------------
// Fixtures: one claude alternate-screen pane in its three states.
//
// Same geometry as the #1268 / #2223 fixtures — 1000 rows, footer pinned to the
// bottom so the trimmed line count saturates at the pane height and dedup has
// to come from content. The dialog frame has NO footer: claude hides the input
// box while a dialog is up (see tests/unit/lib/detection/fixtures/claude-live-1708),
// and the prompt detector reads the frame that way.
// ---------------------------------------------------------------------------

const RULE = '─'.repeat(160);
const REPLY = '⏺ CommandMate is a Git worktree management tool.';
const TURN_2_REPLY = '⏺ I ran the test suite and everything passes.';
const PANE_HEIGHT = 1000;

function transcript(reply: string): string[] {
  return ['❯ summarize the project', '', reply, '', '✻ Churned for 2s'];
}

/** Turn A finished, composer idle. */
function finishedPane(reply: string = REPLY): string {
  const head = transcript(reply);
  const tail = ['', RULE, '❯ ', RULE, '  ⏸ manual mode on · ? for shortcuts'];
  const filler = new Array(PANE_HEIGHT - head.length - tail.length).fill('');
  return [...head, ...filler, ...tail].join('\n');
}

/**
 * Turn A finished, and claude has put its own dialog under it. The text is the
 * one measured live on 2026-09-01; the shape (a rule, one-column indent, a `❯`
 * default, an `Enter to confirm · Esc to cancel` footer) is claude's standard
 * dialog frame.
 */
function postTurnDialogPane(reply: string = REPLY): string {
  const body = [
    ...transcript(reply),
    '',
    RULE,
    ' Teach auto mode about your environment?',
    ' ❯ 1. Yes',
    '   2. Not now',
    "   3. Don't show again",
    '',
    ' Enter to confirm · Esc to cancel',
  ];
  const filler = new Array(PANE_HEIGHT - body.length).fill('');
  return [...body, ...filler].join('\n');
}

/** The next turn under way: the new echo and the spinner where its reply will go. */
function generatingPane(): string {
  const head = [...transcript(REPLY), '', '❯ run the tests', '✳ Thinking… (esc to interrupt)'];
  const tail = ['', RULE, '❯ ', RULE, '  ⏸ manual mode on · ? for shortcuts'];
  const filler = new Array(PANE_HEIGHT - head.length - tail.length).fill('');
  return [...head, ...filler, ...tail].join('\n');
}

/**
 * The next turn finished. With `reply === REPLY` the extracted turn is
 * byte-identical to turn A's — the completion marker included, because
 * `cleanClaudeResponse` keeps it and a marker that differed would make the two
 * replies distinct for reasons that have nothing to do with the dedup cache.
 */
function secondTurnFinishedPane(reply: string): string {
  const head = [...transcript(REPLY), '', '❯ run the tests', '', reply, '', '✻ Churned for 2s'];
  const tail = ['', RULE, '❯ ', RULE, '  ⏸ manual mode on · ? for shortcuts'];
  const filler = new Array(PANE_HEIGHT - head.length - tail.length).fill('');
  return [...head, ...filler, ...tail].join('\n');
}

interface CoordinatorShape {
  activePollers: Map<string, NodeJS.Timeout>;
  pollingStartTimes: Map<string, number>;
  owners: Map<string, unknown>;
  running: Map<string, unknown>;
  pendingRestart: Map<string, unknown>;
  pausedOnPrompt?: Set<string>;
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
    coordinator.pausedOnPrompt?.clear();
  }
  g.__tuiResponseAccumulator?.clear();
  g.__promptHashCache?.clear();
  g.__responseHashCache?.clear();
}

function responseHashCache(): Map<string, string> | undefined {
  return (globalThis as { __responseHashCache?: Map<string, string> }).__responseHashCache;
}

function rows(db: Database.Database, messageType: 'normal' | 'prompt'): string[] {
  return db
    .prepare("SELECT content FROM chat_messages WHERE role = 'assistant' AND message_type = ? ORDER BY rowid")
    .all(messageType)
    .map((row) => String((row as { content: string }).content));
}

describe('a restart with the finished turn still on screen (Issue #2230)', () => {
  let db: Database.Database;
  let core: typeof import('@/lib/polling/response-poller-core');

  beforeEach(async () => {
    vi.useFakeTimers();
    resetProcessState();
    vi.resetModules();
    core = await import('@/lib/polling/response-poller-core');

    db = new Database(':memory:');
    runMigrations(db);
    stubs.db.current = db;

    const worktree: Worktree = {
      id: WT,
      name: 'Restart Dedup',
      path: '/repos/wt-2230-db',
      branch: 'main',
      status: 'ready',
      repositoryPath: '/repos',
      repositoryName: 'repos',
      updatedAt: new Date(),
    };
    upsertWorktree(db, worktree);

    stubs.isSessionRunning.mockResolvedValue(true);
    stubs.captureSessionOutput.mockResolvedValue(finishedPane());
  });

  afterEach(() => {
    resetProcessState();
    vi.useRealTimers();
    stubs.db.current = null;
    db.close();
    vi.clearAllMocks();
  });

  /** Turn A recorded, chain ticking, hash armed — the state every case starts from. */
  async function finishTurnA(): Promise<void> {
    core.startPolling(WT, 'claude');
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    expect(rows(db, 'normal')).toEqual([expect.stringContaining('Git worktree management tool')]);
    expect(responseHashCache()?.has(KEY)).toBe(true);
    // A second tick on the same screen adds nothing — the premise the whole
    // suite rests on. Without it every "exactly one" below would be vacuous.
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    expect(rows(db, 'normal')).toHaveLength(1);
  }

  describe('the production path: a dialog after the turn, answered through /respond', () => {
    it('sanity: the dialog frame is a prompt to the real detector, and it halts the chain', async () => {
      await finishTurnA();

      stubs.captureSessionOutput.mockResolvedValue(postTurnDialogPane());
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);

      expect(rows(db, 'prompt')).toEqual([expect.stringContaining('Teach auto mode about your environment?')]);
      // claude is not a full-screen TUI, so the prompt path stops the chain and
      // waits for `/respond` to start it again.
      expect(core.getActivePollers()).toEqual([]);
      // And the dialog frame itself was NOT taken for a reply.
      expect(rows(db, 'normal')).toHaveLength(1);
    });

    it('records turn A once when /respond restarts the poller onto the finished screen', async () => {
      await finishTurnA();

      // The dialog: recorded as a prompt, chain halted.
      stubs.captureSessionOutput.mockResolvedValue(postTurnDialogPane());
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
      expect(rows(db, 'prompt')).toHaveLength(1);
      expect(core.getActivePollers()).toEqual([]);

      // The operator answers `2. Not now`; the dialog closes and the pane is turn
      // A's finished screen again. `/respond` resumes polling exactly like this.
      stubs.captureSessionOutput.mockResolvedValue(finishedPane());
      core.startPolling(WT, 'claude');

      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL * 5);

      expect(rows(db, 'normal')).toEqual([expect.stringContaining('Git worktree management tool')]);
      expect(core.getActivePollers()).toEqual([KEY]);
    });

    it('still records an identical reply in the NEXT turn after such a resume (Issue #1268)', async () => {
      await finishTurnA();

      stubs.captureSessionOutput.mockResolvedValue(postTurnDialogPane());
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
      stubs.captureSessionOutput.mockResolvedValue(finishedPane());
      core.startPolling(WT, 'claude'); // /respond
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL * 2);
      expect(rows(db, 'normal')).toHaveLength(1);

      // Now a real new turn: `/send` restarts the RUNNING chain, the pane shows
      // the new echo and the spinner, and the reply turns out byte-identical.
      core.startPolling(WT, 'claude');
      stubs.captureSessionOutput.mockResolvedValue(generatingPane());
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL * 2);
      expect(rows(db, 'normal')).toHaveLength(1);

      stubs.captureSessionOutput.mockResolvedValue(secondTurnFinishedPane(REPLY));
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL * 3);

      expect(rows(db, 'normal')).toEqual([
        expect.stringContaining('Git worktree management tool'),
        expect.stringContaining('Git worktree management tool'),
      ]);
    });

    it('a second prompt after the resume is recorded, not deduped against the first', async () => {
      // The prompt hash is NOT carried across the pause: if the answer did not
      // take and the same dialog is still up, the operator must get a new card.
      await finishTurnA();

      stubs.captureSessionOutput.mockResolvedValue(postTurnDialogPane());
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
      expect(rows(db, 'prompt')).toHaveLength(1);

      core.startPolling(WT, 'claude'); // /respond, but the dialog is still on screen
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);

      expect(rows(db, 'prompt')).toHaveLength(2);
      expect(rows(db, 'normal')).toHaveLength(1);
    });
  });

  describe('the /send path: the pane has moved on before the poller restarts', () => {
    it('a restart of the running chain onto the next turn records that turn once, and turn A not again', async () => {
      await finishTurnA();

      // `sendUserMessage` verifies the submit before it calls startPolling(), so
      // the first tick of the new chain already sees the new echo.
      core.startPolling(WT, 'claude');
      stubs.captureSessionOutput.mockResolvedValue(generatingPane());
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL * 2);
      expect(rows(db, 'normal')).toHaveLength(1);

      stubs.captureSessionOutput.mockResolvedValue(secondTurnFinishedPane(TURN_2_REPLY));
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL * 3);

      expect(rows(db, 'normal')).toEqual([
        expect.stringContaining('Git worktree management tool'),
        expect.stringContaining('ran the test suite'),
      ]);
    });

    it('a restart of the running chain is a new cycle: the same reply in the next turn is recorded (Issue #1268)', async () => {
      await finishTurnA();

      core.startPolling(WT, 'claude');
      stubs.captureSessionOutput.mockResolvedValue(generatingPane());
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
      stubs.captureSessionOutput.mockResolvedValue(secondTurnFinishedPane(REPLY));
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL * 2);

      expect(rows(db, 'normal')).toHaveLength(2);
    });
  });

  describe('an explicit stop ends the cycle', () => {
    it('stopPolling on a paused chain drops the hash, so the next start is a fresh cycle', async () => {
      await finishTurnA();

      stubs.captureSessionOutput.mockResolvedValue(postTurnDialogPane());
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
      expect(core.getActivePollers()).toEqual([]);
      expect(responseHashCache()?.has(KEY)).toBe(true);

      // kill-session / session-cleanup: the session is over, nothing to protect.
      core.stopPolling(WT, 'claude');
      expect(responseHashCache()?.has(KEY)).toBe(false);

      // A brand-new session whose first reply happens to read the same is a
      // real reply. (Two ticks: the prompt path left `last_captured_line` at the
      // dialog frame's 13 rows, so the first tick over the 1000-row pane
      // extracts nothing and only re-anchors the cursor.)
      stubs.captureSessionOutput.mockResolvedValue(finishedPane());
      core.startPolling(WT, 'claude');
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL * 3);
      expect(rows(db, 'normal')).toHaveLength(2);
    });
  });
});
