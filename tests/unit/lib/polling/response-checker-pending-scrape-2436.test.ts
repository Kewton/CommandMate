/**
 * The scrape waits for the turn to close (Issue #2436).
 *
 * ## What was measured
 *
 * `commandagent-develop`, codex, 2026-09-08T14:08Z, one turn traced end to end
 * in the server log:
 *
 * ```text
 * :01.886  codex-transcript-turn-open      <- the reader: "not closed yet"
 *          (chat_messages) 140,811 characters of pane saved as the reply
 * :02.547  stop-history-capture-deferred {delaysMs:[150,500,2000,5000]}
 * :02.754  codex-transcript-turn-saved     <- the real Markdown row, ~700 ms on
 * :06.048  structured-history-scrape-suppressed
 * ```
 *
 * Two rows for one turn, and the junk one is the whole pane — prompt echo,
 * intermediate output, composer and footer, up to 234,323 characters.
 *
 * #2399 accepted that trade explicitly, and had to: the gate answered a bare
 * boolean, so "the turn is still open" and "there is no transcript here" were
 * the same `false`, and `false` could only mean "save the pane's copy". This
 * suite pins what the third value buys.
 *
 * ## The three ways a hold has to end
 *
 * Requirement A of the Issue: the deadline, and it must BYPASS the content
 * dedup — the hash for the held content was registered by the tick that decided
 * to hold it, so re-checking would answer "duplicate" for a reply that has never
 * been saved, and the held reply would be lost forever.
 *
 * Requirement B: the poller stopping. `checkForResponse` leaves on a dead
 * session ~300 lines above the save path, and `MAX_POLLING_DURATION` never
 * reaches `checkForResponse` at all, so a hold released only at the save path
 * would never be released. `stopPollingByKey` is the one funnel all of them
 * pass through — which is also why the held reply cannot live in
 * `./response-dedup`, whose caches that same function clears.
 *
 * And the case that must NOT write: the transcript closing first. That is the
 * whole point of holding.
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
  getWorktreeById: () => ({ id: 'wt-2436', name: 'wt-2436', path: '/repos/wt-2436' }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
const broadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: (...a: unknown[]) => broadcastMessage(...a),
}));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
const recordClaudeConversation = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
vi.mock('@/lib/conversation-logger', () => ({
  recordClaudeConversation: (...a: unknown[]) => recordClaudeConversation(...a),
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshot: vi.fn(async () => {}),
}));
vi.mock('@/lib/tasks/task-transition-service', () => ({ applyEventToActiveTask: vi.fn() }));
vi.mock('@/lib/tmux/geometry-delegation', () => ({
  probeGeometryDelegation: vi.fn(async () => ({ delegated: false, released: false })),
}));

/** The reply as the agent's own transcript holds it — what the reader writes. */
const TRANSCRIPT_MARKDOWN = 'A **worktree** is a working directory for a repository.';

/**
 * The reader, as a fake with the two properties this Issue turns on: it reports
 * `not_yet_closed` while the turn is open, and it WRITES the Markdown row (once)
 * when it is not. A stub that only returned a boolean could not tell the "held
 * then superseded" case from the "held then written" one.
 */
const transcriptState = vi.hoisted(() => ({
  /** false = this instance has no transcript at all (the `unavailable` case). */
  present: true as boolean,
  closed: false as boolean,
  written: new Set<string>(),
}));

const captureStructuredHistoryTurn = vi.fn(
  async (
    worktreeId: string,
    cliToolId: CLIToolType,
    instanceId: string | undefined,
    _capture: unknown,
    report?: { outcome?: string }
  ): Promise<boolean> => {
    const resolved = instanceId ?? cliToolId;
    const key = `${worktreeId} ${cliToolId} ${resolved}`;
    if (transcriptState.written.has(key)) {
      if (report) report.outcome = 'captured';
      return true;
    }
    if (!transcriptState.present) return false;
    if (!transcriptState.closed) {
      if (report) report.outcome = 'not_yet_closed';
      return false;
    }
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
        requestId: 'cx-turn:2436',
      }
    );
    if (report) report.outcome = 'captured';
    return true;
  }
);
vi.mock('@/lib/polling/structured-history-gate', () => ({
  isStructuredHistoryWriterLive: () => false,
  captureStructuredHistoryTurn: (
    ...a: [string, CLIToolType, string | undefined, unknown, { outcome?: string } | undefined]
  ) => captureStructuredHistoryTurn(...a),
}));

import {
  PENDING_SCRAPE_HOLD_MS,
  checkForResponse,
  hasPendingScrapedResponse,
  resetPendingScrapedResponses,
} from '@/lib/polling/response-checker';
import { getPollerKey, startPolling, stopPolling } from '@/lib/polling/response-poller-core';
import { STOP_TRANSCRIPT_DEFERRED_DELAYS_MS } from '@/lib/hooks/stop-history-capture';

const WT = 'wt-2436';
const TOOL: CLIToolType = 'codex';
const KEY = getPollerKey(WT, TOOL);

const SCRAPED_REPLY = 'A worktree is a working directory for a Git repository.';
const FILLER = '  transcript row that has already scrolled past the window';

/**
 * codex's pane, saturated.
 *
 * Saturation is what disables the line-count cursor (#1670) and puts the poll
 * on the content-dedup path — the state the incident was measured in, and the
 * one where a held reply is at risk of being deduped out of existence.
 */
function codexPane(): string {
  const rows = [
    '› summarize the project',
    '',
    `• ${SCRAPED_REPLY}`,
    '',
    '─'.repeat(120),
    '',
    '› Find and fix a bug in @filename',
    '',
    '  gpt-5.6-sol xhigh · ~/share/work/github_kewton/CommandMate',
  ];
  const filler = new Array(Math.max(0, CACHE_MAX_CAPTURE_LINES - rows.length)).fill(FILLER);
  return [...filler, ...rows].join('\n');
}

function assistantRows(): Array<Record<string, unknown>> {
  return createMessage.mock.calls
    .map(([, m]) => m)
    .filter((m) => m.role === 'assistant' && m.messageType === 'normal');
}

function scrapedRows(): Array<Record<string, unknown>> {
  return assistantRows().filter((m) => String(m.content).includes('Git repository'));
}

function markdownRows(): Array<Record<string, unknown>> {
  return assistantRows().filter((m) => m.content === TRANSCRIPT_MARKDOWN);
}

function loggedActions(): string[] {
  return mockLogger.info.mock.calls.map(([action]) => String(action));
}

/** Wire the session-state pair into one mutable row, as the real poller sees it. */
function useLiveSessionState(initial: number): void {
  let lastCapturedLine = initial;
  getSessionState.mockImplementation(() => ({ lastCapturedLine, inProgressMessageId: null }));
  updateSessionState.mockImplementation((...args: unknown[]) => {
    lastCapturedLine = args[3] as number;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-08T14:08:00.000Z'));
  stopPolling(WT, TOOL);
  resetPendingScrapedResponses();
  transcriptState.present = true;
  transcriptState.closed = false;
  transcriptState.written.clear();
  isSessionRunning.mockResolvedValue(true);
  captureSessionOutput.mockResolvedValue(codexPane());
  useLiveSessionState(CACHE_MAX_CAPTURE_LINES - 1);
});

afterEach(() => {
  stopPolling(WT, TOOL);
  resetPendingScrapedResponses();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

describe('[#2436] how long the scrape is held', () => {
  it('is exactly the Stop receiver’s whole deferred-read budget', () => {
    // Derived, not spelled: those delays are when the Stop receiver re-reads
    // the transcript after answering the agent, so their sum is the moment
    // after which nobody is still trying to write the row.
    expect(PENDING_SCRAPE_HOLD_MS).toBe(
      STOP_TRANSCRIPT_DEFERRED_DELAYS_MS.reduce((total, delay) => total + delay, 0)
    );
    expect(PENDING_SCRAPE_HOLD_MS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Premises
// ---------------------------------------------------------------------------

describe('[#2436] premises', () => {
  it('a reader that reports nothing still saves the scrape on the first tick', async () => {
    // The pre-#2436 behaviour, which every existing stub of the gate relies on:
    // an unexplained `false` means the scraper owns the turn, now.
    transcriptState.present = false;

    expect(await checkForResponse(WT, TOOL)).toBe(true);

    expect(scrapedRows()).toHaveLength(1);
    expect(hasPendingScrapedResponse(KEY)).toBe(false);
  });

  it('the second poll of the same frame is a duplicate', async () => {
    // The guard the held reply has to survive: its hash was registered by the
    // tick that held it, so a re-check would call it a duplicate.
    transcriptState.present = false;

    await checkForResponse(WT, TOOL);
    await checkForResponse(WT, TOOL);

    expect(loggedActions()).toContain('duplicate-response-skipped');
  });
});

// ---------------------------------------------------------------------------
// The hold
// ---------------------------------------------------------------------------

describe('[#2436] a turn the agent has not closed yet', () => {
  it('does not put the pane beside the answer', async () => {
    expect(await checkForResponse(WT, TOOL)).toBe(true);

    expect(scrapedRows()).toHaveLength(0);
    expect(hasPendingScrapedResponse(KEY)).toBe(true);
    expect(loggedActions()).toContain('structured-history-scrape-held');
  });

  it('writes no Markdown conversation log for it either', async () => {
    await checkForResponse(WT, TOOL);
    expect(recordClaudeConversation).not.toHaveBeenCalled();
  });

  it('still advances the cursor and answers the tick', async () => {
    // Only the two writes that RECORD THE REPLY wait. The bookkeeping around
    // them has no second producer and must not be held with them.
    expect(await checkForResponse(WT, TOOL)).toBe(true);
    expect(updateSessionState).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Ending the hold: the transcript wins
// ---------------------------------------------------------------------------

describe('[#2436] the transcript closes before the deadline', () => {
  it('the pane is dropped and only the Markdown row is left', async () => {
    await checkForResponse(WT, TOOL);
    transcriptState.closed = true;

    // The #2399 recheck, from inside the dedup skip.
    await checkForResponse(WT, TOOL);

    expect(markdownRows()).toHaveLength(1);
    expect(scrapedRows()).toHaveLength(0);
    expect(hasPendingScrapedResponse(KEY)).toBe(false);
  });

  it('and no later tick resurrects it, however long the poller runs', async () => {
    await checkForResponse(WT, TOOL);
    transcriptState.closed = true;
    await checkForResponse(WT, TOOL);

    vi.setSystemTime(Date.now() + PENDING_SCRAPE_HOLD_MS * 4);
    for (let tick = 0; tick < 5; tick += 1) await checkForResponse(WT, TOOL);

    expect(scrapedRows()).toHaveLength(0);
    expect(markdownRows()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Ending the hold: the deadline (requirement A)
// ---------------------------------------------------------------------------

describe('[#2436] a turn that never closes', () => {
  it('writes the held scrape once the budget is spent, on a static screen', async () => {
    await checkForResponse(WT, TOOL);
    expect(scrapedRows()).toHaveLength(0);

    // Nothing changes on screen — every poll from here is a duplicate frame,
    // which before this Issue returned before anything else could happen.
    await checkForResponse(WT, TOOL);
    expect(scrapedRows()).toHaveLength(0);

    vi.setSystemTime(Date.now() + PENDING_SCRAPE_HOLD_MS + 1);
    await checkForResponse(WT, TOOL);

    expect(scrapedRows()).toHaveLength(1);
    expect(hasPendingScrapedResponse(KEY)).toBe(false);
    expect(loggedActions()).toContain('pending-scrape-flushed');
  });

  it('bypasses the content dedup to do it', async () => {
    // The mechanism, stated as its own assertion: the hash was registered on
    // the tick that held the reply, so the guard that ran between then and now
    // would have answered "duplicate" for a row that has never been saved.
    await checkForResponse(WT, TOOL);
    await checkForResponse(WT, TOOL);
    expect(loggedActions()).toContain('duplicate-response-skipped');

    vi.setSystemTime(Date.now() + PENDING_SCRAPE_HOLD_MS + 1);
    await checkForResponse(WT, TOOL);

    expect(scrapedRows()).toHaveLength(1);
  });

  it('writes it exactly once, however many ticks follow', async () => {
    await checkForResponse(WT, TOOL);
    vi.setSystemTime(Date.now() + PENDING_SCRAPE_HOLD_MS + 1);
    for (let tick = 0; tick < 6; tick += 1) await checkForResponse(WT, TOOL);

    expect(scrapedRows()).toHaveLength(1);
  });

  it('dates the row when the turn was judged finished, not when it was written', async () => {
    // History sorts on this. A row dated at the end of the hold would sort
    // under the NEXT turn's prompt.
    const heldAt = Date.now();
    await checkForResponse(WT, TOOL);

    vi.setSystemTime(heldAt + PENDING_SCRAPE_HOLD_MS + 1);
    await checkForResponse(WT, TOOL);

    expect((scrapedRows()[0].timestamp as Date).getTime()).toBe(heldAt);
  });

  it('broadcasts it, so an open transcript sees it arrive', async () => {
    await checkForResponse(WT, TOOL);
    vi.setSystemTime(Date.now() + PENDING_SCRAPE_HOLD_MS + 1);
    await checkForResponse(WT, TOOL);

    expect(broadcastMessage).toHaveBeenCalledWith('message', expect.objectContaining({
      worktreeId: WT,
    }));
  });

  it('takes one last look at the transcript before writing', async () => {
    // The deadline and the throttled #2399 recheck are not in step — one is a
    // wall clock, the other is every third duplicate tick — so the expiry asks
    // once more rather than racing a row that is about to land.
    await checkForResponse(WT, TOOL);
    transcriptState.closed = true;
    vi.setSystemTime(Date.now() + PENDING_SCRAPE_HOLD_MS + 1);

    await checkForResponse(WT, TOOL);

    expect(scrapedRows()).toHaveLength(0);
    expect(markdownRows()).toHaveLength(1);
    expect(loggedActions()).toContain('pending-scrape-superseded');
  });
});

// ---------------------------------------------------------------------------
// Ending the hold: the poller stopping (requirement B)
// ---------------------------------------------------------------------------

describe('[#2436] the cycle ends before the deadline', () => {
  it('an explicit stop writes the held reply', async () => {
    await checkForResponse(WT, TOOL);
    expect(scrapedRows()).toHaveLength(0);

    stopPolling(WT, TOOL);

    expect(scrapedRows()).toHaveLength(1);
    expect(hasPendingScrapedResponse(KEY)).toBe(false);
  });

  it('the session going away writes it, from inside the tick that noticed', async () => {
    // `checkForResponse` leaves on a dead session ~300 lines above the save
    // path, so this is the case a hold released only down there would lose.
    await checkForResponse(WT, TOOL);
    isSessionRunning.mockResolvedValue(false);

    expect(await checkForResponse(WT, TOOL)).toBe(false);

    expect(scrapedRows()).toHaveLength(1);
    expect(loggedActions()).toContain('session-not-running');
  });

  it('the next turn starting writes the previous one first', async () => {
    await checkForResponse(WT, TOOL);
    expect(scrapedRows()).toHaveLength(0);

    // What `sendUserMessage` does: a restart that opens a new cycle.
    startPolling(WT, TOOL);

    expect(scrapedRows()).toHaveLength(1);
  });

  it('and the row it writes is the one that was held, not an empty stand-in', async () => {
    await checkForResponse(WT, TOOL);
    stopPolling(WT, TOOL);

    expect(String(scrapedRows()[0].content)).toContain(SCRAPED_REPLY);
    expect(scrapedRows()[0].cliToolId).toBe(TOOL);
    expect(scrapedRows()[0].instanceId).toBe(TOOL);
  });
});
