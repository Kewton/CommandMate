/**
 * Issue #2399: the content-dedup guard must not be the transcript reader's
 * last word.
 *
 * ## What was measured
 *
 * `commandagent-develop`, codex, 2026-09-07:
 *
 * ```text
 * 12:05:21.833Z codex-transcript-turn-open      <- the reader's only ask
 * 12:05:21.895Z (chat_messages) a footer line saved as the assistant row
 * 12:05:23.607Z (rollout) task_complete         <- the turn closes, 1.8 s later
 * 12:05:23.918Z duplicate-response-skipped
 * 12:05:25.946Z duplicate-response-skipped
 *   ... every 2 s for the 30 minutes of MAX_POLLING_DURATION
 * ```
 *
 * `checkForResponse` asks the pull-mode reader about 100 lines BELOW the dedup
 * guard, so once the guard matched — which it does from the second poll of a
 * finished screen onwards — the reader was never asked again. For a screen
 * scraper "the frame stopped changing" is the end of the story; for a reader it
 * is the moment BEFORE the agent's own file closes the turn, so the single ask
 * is systematically too early and the Markdown row was lost for good.
 *
 * ## What this suite pins
 *
 * The reader is re-asked from inside the skip, throttled by
 * `STRUCTURED_HISTORY_RECHECK_TICK_INTERVAL`, until it answers — and asked once
 * per tick at most, so a turn is never written twice.
 *
 * ## Why the reader here is a fake that WRITES
 *
 * The gate is stubbed, as every `checkForResponse` suite stubs it, but the stub
 * is not `async () => true`. The production readers write a `chat_messages` row
 * and are idempotent through `findMessageByRequestId`, and both halves matter to
 * what is asserted below: "the Markdown row appears on the second tick" is a
 * claim about a write, and "the same turn is not written twice" is a claim about
 * that idempotence surviving repeated asks. A stub that only returned a boolean
 * would let a fix that asks ten times per tick pass.
 *
 * ## The four tools
 *
 * All four pull-mode tools reach the guard through the same two lines, but they
 * reach it for two different reasons: claude renders in the alternate screen, so
 * the line-count cursor is disabled by tool identity (#1268); codex, antigravity
 * and command-code keep scrollback and get there only once the capture window
 * saturates (#1670) — which is exactly the state the incident above was measured
 * in. Both are covered, per tool, rather than asserted once on claude.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CACHE_MAX_CAPTURE_LINES } from '@/lib/tmux/tmux-capture-cache';
import { usesAlternateScreen, type CLIToolType } from '@/lib/cli-tools/types';

// Built inside vi.hoisted() rather than from tests/helpers/logger-mock, because
// `@/lib/logger` is pulled in transitively by `cli-patterns` while the hoisted
// vi.mock factory runs (same reason as the #1695 and #2250 suites).
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

const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
const isSessionRunning = vi.fn<(...a: unknown[]) => Promise<boolean>>();
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
  isSessionRunning: (...a: unknown[]) => isSessionRunning(...a),
}));

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-1', ...m }));
const getSessionState = vi.fn();
const updateSessionState = vi.fn();
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  getSessionState: (...a: unknown[]) => getSessionState(...a),
  updateSessionState: (...a: unknown[]) => updateSessionState(...a),
  getWorktreeById: () => ({ id: 'wt-2399', name: 'wt-2399', path: '/repos/wt-2399' }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/tasks/task-transition-service', () => ({ applyEventToActiveTask: vi.fn() }));
// #2317 Phase D probes tmux for the pane's geometry owner on every claude poll.
// That is a real child process; stubbed so the ticks below stay deterministic.
vi.mock('@/lib/tmux/geometry-delegation', () => ({
  probeGeometryDelegation: vi.fn(async () => ({ delegated: false, released: false })),
}));

/** The reply as the agent's own transcript holds it — what the reader writes. */
const TRANSCRIPT_MARKDOWN = 'A **worktree** is a working directory for a repository.';

/**
 * The pull reader, as a fake with the two properties production depends on: it
 * refuses a turn its file has not closed, and once it has written the row it
 * answers true without writing again.
 */
const transcriptState = vi.hoisted(() => ({ closed: false, written: new Set<string>() }));

const captureStructuredHistoryTurn = vi.fn(
  async (
    worktreeId: string,
    cliToolId: CLIToolType,
    instanceId: string | undefined,
    _capture: unknown
  ): Promise<boolean> => {
    const resolved = instanceId ?? cliToolId;
    const key = `${worktreeId} ${cliToolId} ${resolved}`;
    if (transcriptState.written.has(key)) return true;
    if (!transcriptState.closed) return false;
    transcriptState.written.add(key);
    createMessage(
      {},
      {
        worktreeId,
        role: 'assistant',
        content: TRANSCRIPT_MARKDOWN,
        messageType: 'normal',
        cliToolId,
        instanceId: resolved,
        requestId: 'turn-2399',
      }
    );
    return true;
  }
);
vi.mock('@/lib/polling/structured-history-gate', () => ({
  isStructuredHistoryWriterLive: () => false,
  captureStructuredHistoryTurn: (...a: [string, CLIToolType, string | undefined, unknown]) =>
    captureStructuredHistoryTurn(...a),
}));

import { checkForResponse, extractResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import {
  STRUCTURED_HISTORY_RECHECK_TICK_INTERVAL,
  claimStructuredHistoryRecheck,
  clearResponseHashCache,
  markStructuredHistoryRecheckPending,
  renameResponseHashCacheKey,
  settleStructuredHistoryRecheck,
} from '@/lib/polling/response-dedup';

const WT = 'wt-2399';

/** The four tools whose replies live in a file the poller has to pull from. */
const PULL_TOOLS: CLIToolType[] = ['claude', 'codex', 'antigravity', 'command-code'];

// ---------------------------------------------------------------------------
// Panes
//
// One per tool, each a frame the extractor calls COMPLETE and each one static —
// the same bytes on every tick, which is what arms the dedup guard.
// ---------------------------------------------------------------------------

/** Scrollback that has already slid out from under the recorded cursor (#1670). */
const FILLER = '  transcript row that has already scrolled past the window';

const SCRAPED_REPLY = 'A worktree is a working directory for a Git repository.';

/**
 * claude's 1000-row alternate-screen pane: transcript, blank filler, then the
 * footer (rule / input box / rule / status bar). Extraction anchors on that
 * footer, so a bare two-line transcript would save nothing and every assertion
 * here would pass vacuously. Same shape as the #1268 / #1695 / #2121 fixtures.
 */
function claudePane(): string {
  const head = ['❯ summarize the project', `⏺ ${SCRAPED_REPLY}`];
  const rule = '─'.repeat(40);
  const tail = ['', rule, '❯ ', rule, '  ⏸ manual mode on · ? for shortcuts'];
  const filler = new Array(1000 - head.length - tail.length).fill('');
  return [...head, ...filler, ...tail].join('\n');
}

/**
 * Saturated inline panes: the turn at the bottom, one capture window of
 * scrollback above it, ending on a non-blank footer row so the trailing-blank
 * trim leaves the count pinned at the window size. Shapes transcribed from the
 * #1670 suite, which took them off a live `mcbd-codex-commandagent-develop`.
 */
const INLINE_TURNS: Partial<Record<CLIToolType, string[]>> = {
  codex: [
    '› summarize the project',
    '',
    `• ${SCRAPED_REPLY}`,
    '',
    '─'.repeat(120),
    '',
    '› Find and fix a bug in @filename',
    '',
    '  gpt-5.6-sol xhigh · ~/share/work/github_kewton/CommandMate',
  ],
  antigravity: [
    '> summarize the project',
    '',
    `  ${SCRAPED_REPLY}`,
    '',
    '─'.repeat(80),
    '>',
    '? for shortcuts   gemini-3-pro',
  ],
};

/**
 * command-code's frame is the live capture `command-code-live-2250/turn-version`
 * — the same file the #2250 suite measures — padded above with the scrollback
 * that makes the window saturate. Everything that decides the outcome (the echo,
 * the reply, the composer between its two rules, the footer) is the live capture
 * byte for byte; only the filler is reconstructed.
 */
const COMMAND_CODE_FRAME = fs
  .readFileSync(
    path.resolve(__dirname, '../../../fixtures/command-code-live-2250/turn-version.txt'),
    'utf-8'
  )
  .split('\n');

function saturatedPane(rows: string[]): string {
  const filler = new Array(Math.max(0, CACHE_MAX_CAPTURE_LINES - rows.length)).fill(FILLER);
  return [...filler, ...rows].join('\n');
}

function paneFor(tool: CLIToolType): string {
  if (tool === 'claude') return claudePane();
  if (tool === 'command-code') return saturatedPane(COMMAND_CODE_FRAME);
  return saturatedPane(INLINE_TURNS[tool]!);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assistantContents(): string[] {
  return createMessage.mock.calls
    .filter(([, m]) => m.role === 'assistant' && m.messageType === 'normal')
    .map(([, m]) => String(m.content));
}

function markdownRowCount(): number {
  return assistantContents().filter((c) => c === TRANSCRIPT_MARKDOWN).length;
}

function loggedActions(): string[] {
  return mockLogger.info.mock.calls.map(([action]) => String(action));
}

/**
 * Wire the session-state pair into one mutable row so the poller reads back what
 * it wrote. Without this a test keeps feeding a hand-picked cursor and never
 * notices the product re-pinning its own state.
 */
function useLiveSessionState(initial: number): void {
  let lastCapturedLine = initial;
  getSessionState.mockImplementation(() => ({ lastCapturedLine, inProgressMessageId: null }));
  updateSessionState.mockImplementation((...args: unknown[]) => {
    lastCapturedLine = args[3] as number;
  });
}

function arm(tool: CLIToolType): void {
  stopPolling(WT, tool);
  captureSessionOutput.mockResolvedValue(paneFor(tool));
  useLiveSessionState(tool === 'claude' ? 1000 : CACHE_MAX_CAPTURE_LINES - 1);
}

beforeEach(() => {
  vi.clearAllMocks();
  transcriptState.closed = false;
  transcriptState.written.clear();
  for (const tool of PULL_TOOLS) stopPolling(WT, tool);
  isSessionRunning.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Premises
// ---------------------------------------------------------------------------

describe('Issue #2399: fixture premises', () => {
  it.each(PULL_TOOLS)('%s reaches the content-dedup guard at all', (tool) => {
    // The guard runs only when the line count has stopped being a cursor, and
    // the four tools get there two different ways. If a fixture stopped
    // satisfying its own reason, every assertion below would measure the
    // line-count path instead and pass without touching this Issue.
    const result = extractResponse(paneFor(tool), 0, tool, CACHE_MAX_CAPTURE_LINES);

    expect(result?.isComplete).toBe(true);
    expect(usesAlternateScreen(tool) || result?.captureWindowSaturated).toBe(true);
  });

  it.each(PULL_TOOLS)(
    '%s: the first poll saves the scrape and asks the reader once',
    async (tool) => {
      arm(tool);

      expect(await checkForResponse(WT, tool)).toBe(true);
      expect(assistantContents()).toHaveLength(1);
      expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(1);
    }
  );

  it.each(PULL_TOOLS)('%s: the second poll of the same frame is a duplicate', async (tool) => {
    // The premise the whole Issue rests on. If the frame stopped hashing
    // identically, the reader would be re-asked by the ordinary path and the
    // recheck would never be exercised.
    arm(tool);

    await checkForResponse(WT, tool);
    await checkForResponse(WT, tool);

    expect(loggedActions()).toContain('duplicate-response-skipped');
  });
});

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------

describe('Issue #2399: a turn that closes after the frame goes quiet', () => {
  it.each(PULL_TOOLS)(
    '%s: the Markdown row is written on the second tick, same frame',
    async (tool) => {
      arm(tool);

      // Tick 1 — the incident's 12:05:21. The screen is finished, the file is
      // not: the reader refuses and the scrape becomes the only record.
      await checkForResponse(WT, tool);
      expect(markdownRowCount()).toBe(0);

      // The agent closes its turn (codex: `task_complete`, 1.8 s later).
      transcriptState.closed = true;

      // Tick 2 — byte-identical frame, so the dedup guard fires. Before this
      // Issue that was the end of the tick and of the turn.
      expect(await checkForResponse(WT, tool)).toBe(true);

      expect(markdownRowCount()).toBe(1);
      expect(loggedActions()).toContain('duplicate-response-skipped');
      expect(loggedActions()).toContain('structured-history-recheck-captured');
    }
  );

  it.each(PULL_TOOLS)('%s: the reader is asked once on that tick, not twice', async (tool) => {
    arm(tool);

    await checkForResponse(WT, tool);
    const afterFirstTick = captureStructuredHistoryTurn.mock.calls.length;
    transcriptState.closed = true;
    await checkForResponse(WT, tool);

    expect(captureStructuredHistoryTurn.mock.calls.length - afterFirstTick).toBe(1);
  });

  it.each(PULL_TOOLS)('%s: nine more polls add no second copy of the turn', async (tool) => {
    arm(tool);

    await checkForResponse(WT, tool);
    transcriptState.closed = true;
    for (let tick = 0; tick < 10; tick += 1) await checkForResponse(WT, tool);

    expect(markdownRowCount()).toBe(1);
  });

  it.each(PULL_TOOLS)(
    '%s: and the reader stops being asked once it has answered',
    async (tool) => {
      // The settle half. Without it the fix would trade a lost turn for a 4 MiB
      // tail read every third tick for the rest of the 30-minute cycle.
      arm(tool);

      await checkForResponse(WT, tool);
      transcriptState.closed = true;
      await checkForResponse(WT, tool);
      const afterCapture = captureStructuredHistoryTurn.mock.calls.length;

      for (let tick = 0; tick < 10; tick += 1) await checkForResponse(WT, tool);

      expect(captureStructuredHistoryTurn.mock.calls.length).toBe(afterCapture);
    }
  );

  it.each(PULL_TOOLS)('%s: the scraped row written first is kept, not retracted', async (tool) => {
    // The Issue asks for this decision to be made explicitly, and the decision
    // is to keep it. Nothing at the skip site can identify that row — the dedup
    // hash is per pollerKey and survives the `resume` of a chain paused on a
    // prompt, so the frame it stands for may belong to an earlier turn — and
    // `archived` in this schema is the tombstone of an operator clearing
    // History (#168), not a "superseded" marker. A visible duplicate is
    // recoverable; a deleted reply is not. See the comment at the skip site.
    arm(tool);

    await checkForResponse(WT, tool);
    const scraped = assistantContents()[0];
    transcriptState.closed = true;
    await checkForResponse(WT, tool);

    expect(assistantContents()).toEqual([scraped, TRANSCRIPT_MARKDOWN]);
  });
});

describe('Issue #2399: a turn that never closes', () => {
  it('the throttle actually swallows ticks', () => {
    // Guards every count below. At an interval of 1 "throttled" means "on every
    // tick", the assertions turn into restatements of the constant, and a
    // regression that removed the throttle would be indistinguishable from the
    // fix.
    expect(STRUCTURED_HISTORY_RECHECK_TICK_INTERVAL).toBeGreaterThan(1);
  });

  it.each(PULL_TOOLS)(
    '%s: the reader is re-asked on the throttle, not every tick',
    async (tool) => {
      // 4 MiB of transcript, parsed, is not free at 2 s a tick for 30 minutes.
      // The first duplicate tick always asks (so the ordinary case is not
      // delayed); after that it is one ask per interval.
      arm(tool);

      await checkForResponse(WT, tool);
      const afterFirstTick = captureStructuredHistoryTurn.mock.calls.length;

      const DUPLICATE_TICKS = 9;
      for (let tick = 0; tick < DUPLICATE_TICKS; tick += 1) await checkForResponse(WT, tool);

      const asks = captureStructuredHistoryTurn.mock.calls.length - afterFirstTick;
      expect(asks).toBeLessThan(DUPLICATE_TICKS);
      expect(asks).toBe(Math.ceil(DUPLICATE_TICKS / STRUCTURED_HISTORY_RECHECK_TICK_INTERVAL));
    }
  );

  it.each(PULL_TOOLS)('%s: and the scrape stays suppressed while it waits', async (tool) => {
    arm(tool);

    for (let tick = 0; tick < 8; tick += 1) await checkForResponse(WT, tool);

    expect(assistantContents()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The state itself
// ---------------------------------------------------------------------------

describe('Issue #2399: the recheck note lives and dies with the response hash', () => {
  const KEY = 'wt-2399:probe';
  const RENAMED = 'wt-2399:probe-renamed';

  beforeEach(() => {
    clearResponseHashCache(KEY);
    clearResponseHashCache(RENAMED);
  });

  it('owes nothing until a poll marks it', () => {
    expect(claimStructuredHistoryRecheck(KEY)).toBe(false);
  });

  it('asks on the very first tick after the mark', () => {
    markStructuredHistoryRecheckPending(KEY);
    expect(claimStructuredHistoryRecheck(KEY)).toBe(true);
  });

  it('then swallows the ticks the throttle covers', () => {
    markStructuredHistoryRecheckPending(KEY);
    claimStructuredHistoryRecheck(KEY);

    const asks = Array.from({ length: STRUCTURED_HISTORY_RECHECK_TICK_INTERVAL }, () =>
      claimStructuredHistoryRecheck(KEY)
    );

    // Exactly one more ask in a full interval, and it is the last tick of it —
    // so an interval of N really does swallow the N-1 ticks before it.
    expect(asks.filter(Boolean)).toHaveLength(1);
    expect(asks.filter((ask) => !ask)).toHaveLength(STRUCTURED_HISTORY_RECHECK_TICK_INTERVAL - 1);
    expect(asks[asks.length - 1]).toBe(true);
  });

  it('does not restart the countdown when a later poll marks it again', () => {
    // A poll that learns nothing new must not push a turn that has been waiting
    // back to the end of the queue.
    markStructuredHistoryRecheckPending(KEY);
    claimStructuredHistoryRecheck(KEY);
    markStructuredHistoryRecheckPending(KEY);

    const asks = Array.from({ length: STRUCTURED_HISTORY_RECHECK_TICK_INTERVAL }, () =>
      claimStructuredHistoryRecheck(KEY)
    );
    expect(asks.filter(Boolean)).toHaveLength(1);
  });

  it('stops asking once settled', () => {
    markStructuredHistoryRecheckPending(KEY);
    settleStructuredHistoryRecheck(KEY);

    expect(claimStructuredHistoryRecheck(KEY)).toBe(false);
  });

  it('is dropped by the same call that drops the hash', () => {
    // `stopPolling` is the only lifecycle this note has, and it reaches it
    // through `clearResponseHashCache`. The two must not drift: a note that
    // outlived its hash would spend reads on a turn that is over.
    markStructuredHistoryRecheckPending(KEY);
    clearResponseHashCache(KEY);

    expect(claimStructuredHistoryRecheck(KEY)).toBe(false);
  });

  it('moves with the hash when a worktree is renamed underneath the poller', () => {
    markStructuredHistoryRecheckPending(KEY);
    renameResponseHashCacheKey(KEY, RENAMED);

    expect(claimStructuredHistoryRecheck(KEY)).toBe(false);
    expect(claimStructuredHistoryRecheck(RENAMED)).toBe(true);
  });
});
