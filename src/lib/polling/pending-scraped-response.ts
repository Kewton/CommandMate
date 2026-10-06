/** Held scraped responses for CLI tool polling (Issue #3213 split from response-checker.ts). */

import { getDbInstance } from '@/lib/db/db-instance';
import { createMessage } from '@/lib/db';
import { broadcastMessage } from '@/lib/ws-server';
import { recordClaudeConversation } from '@/lib/conversation-logger';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import { settleStructuredHistoryRecheck } from './response-dedup';
import { captureStructuredHistoryTurn } from './structured-history-gate';
import { STOP_TRANSCRIPT_DEFERRED_DELAYS_MS } from '@/lib/hooks/stop-history-capture';
import { getOrInitGlobal } from '../global-state';

const logger = createLogger('response-poller');

// ============================================================================
// The held scrape (Issue #2436)
// ============================================================================

/**
 * How long a scraped reply is held while its transcript finishes closing.
 *
 * Derived from `STOP_TRANSCRIPT_DEFERRED_DELAYS_MS`, not spelled again: those
 * are the instants the Stop receiver re-reads the transcript at after it has
 * answered the agent (#2398), so their SUM is the moment after which nobody is
 * still trying. Holding past it would be holding for a row that has no producer
 * left; stopping short of it would race the producer that is still running.
 *
 * The measured gap this covers is under a second — codex 2026-09-08 appended
 * `task_complete` ~700 ms after the frame went quiet — so the budget is roughly
 * ten times the case it exists for, spent only on turns that ask for it.
 */
export const PENDING_SCRAPE_HOLD_MS = STOP_TRANSCRIPT_DEFERRED_DELAYS_MS.reduce(
  (total, delay) => total + delay,
  0
);

/**
 * A scraped reply the poller has read but not written yet (Issue #2436).
 *
 * Everything `checkForResponse` would have passed to `createMessage`, plus the
 * instant it decided to and the instant it stops waiting. The timestamp is the
 * one taken when the turn was JUDGED finished rather than when the row is
 * finally written: History sorts on it, and a row dated seven seconds late would
 * sort under the next turn's prompt.
 */
interface PendingScrapedResponse {
  readonly worktreeId: string;
  readonly cliToolId: CLIToolType;
  readonly instanceId: string;
  /** The pane's copy of the reply, cleaned. Replaced if the frame moves on. */
  content: string;
  readonly timestamp: Date;
  readonly summary?: string;
  readonly logFileName?: string;
  readonly requestId?: string;
  /** `transcriptPathHint` for the last-chance re-ask; see {@link settleExpiredPendingScrapedResponse}. */
  readonly worktreePath: string;
  readonly transcriptPathHint: string | null;
  /** `Date.now()` after which the hold is over and the row is written. */
  readonly expiresAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __pendingScrapedResponses: Map<string, PendingScrapedResponse> | undefined;
}

/**
 * Held scrapes, by poller key.
 *
 * **Deliberately not in `./response-dedup`.** That module's two caches are
 * cleared by `stopPollingByKey` — `clearResponseHashCache` is called from
 * inside it — so a held reply parked beside them would be dropped by the very
 * event that has to write it (Issue #2436, requirement B). It lives here, next
 * to the code that fills it and the code that writes it out, and
 * `flushPendingScrapedResponse` is what the poller calls before it clears
 * anything.
 *
 * On `globalThis` for the reason every shared map in this subsystem is (#1736):
 * under `next dev` the poller's bundle and each route's bundle would otherwise
 * hold a private copy, and a held reply only one bundle can see is a lost one.
 */
const pendingScrapedResponses = getOrInitGlobal('__pendingScrapedResponses', () => new Map<
  string,
  PendingScrapedResponse
>());

/** Forget every held scrape. Test seam. */
export function resetPendingScrapedResponses(): void {
  pendingScrapedResponses.clear();
}

/** Whether a scrape is being held for this poller key. Test seam / diagnostics. */
export function hasPendingScrapedResponse(pollerKey: string): boolean {
  return pendingScrapedResponses.has(pollerKey);
}

/**
 * Hold this tick's scraped reply instead of writing it (Issue #2436).
 *
 * Called when the transcript reader has said `not_yet_closed`: the agent's own
 * Markdown for this turn is coming, and writing the pane's copy now is what put
 * 234,323 characters of prompt echo, intermediate output and footer into
 * History beside the real answer.
 *
 * A second hold for the same key REPLACES the content and keeps the original
 * deadline. Replaces, because a frame that moved on is a better copy of the
 * same turn; keeps, because a pane that redraws every tick would otherwise push
 * its own deadline forward forever and the hold would stop being bounded.
 */
export function holdScrapedResponse(pollerKey: string, pending: PendingScrapedResponse): void {
  const existing = pendingScrapedResponses.get(pollerKey);
  if (existing) {
    existing.content = pending.content;
    return;
  }
  pendingScrapedResponses.set(pollerKey, pending);
}

/**
 * Drop a held scrape without writing it (Issue #2436).
 *
 * The one thing that justifies dropping it: the transcript reader has since
 * written the turn as the agent's own Markdown, so the pane's copy is the
 * duplicate this Issue exists to stop.
 */
export function discardPendingScrapedResponse(pollerKey: string): void {
  pendingScrapedResponses.delete(pollerKey);
}

/**
 * Write a held scrape now, whatever the clock says (Issue #2436).
 *
 * Exported because `response-poller-core` calls it from `stopPollingByKey`,
 * which is every way a polling cycle ends: an explicit stop, the session going
 * away, `MAX_POLLING_DURATION`, and the restart that opens the NEXT turn. A
 * held reply must not be able to outlive the cycle that holds it — the caches
 * that key it are cleared in that same function, and a reply nobody writes is
 * strictly worse than the duplicate row this Issue is trading against.
 *
 * **Deliberately bypasses `isDuplicateResponse`.** The hash for this content was
 * registered by the tick that decided to hold it (the dedup guard's check is
 * also its write), so a re-check here would answer "duplicate" for the reply
 * that has never been saved. That is requirement A of the Issue in one line.
 *
 * Synchronous through the row: `better-sqlite3` is, and this runs on shutdown
 * paths where an awaited continuation may never be reached. The Markdown
 * conversation log is fired afterwards and not waited for, because it is a
 * secondary record and the row is the one History reads.
 *
 * @param pollerKey - Poller key ("worktreeId:instanceId")
 * @param reason - What ended the hold; logged, for the operator reading back
 * @returns Whether a held reply was written
 */
export function flushPendingScrapedResponse(pollerKey: string, reason: string): boolean {
  const pending = pendingScrapedResponses.get(pollerKey);
  if (!pending) return false;
  pendingScrapedResponses.delete(pollerKey);

  try {
    const db = getDbInstance();
    const message = createMessage(db, {
      worktreeId: pending.worktreeId,
      role: 'assistant',
      content: pending.content,
      messageType: 'normal',
      timestamp: pending.timestamp,
      cliToolId: pending.cliToolId,
      instanceId: pending.instanceId,
      summary: pending.summary,
      logFileName: pending.logFileName,
      requestId: pending.requestId,
    });
    broadcastMessage('message', { worktreeId: pending.worktreeId, message });
    logger.info('pending-scrape-flushed', {
      worktreeId: pending.worktreeId,
      cliToolId: pending.cliToolId,
      instanceId: pending.instanceId,
      reason,
      scrapedLength: pending.content.length,
      heldForMs: Date.now() - pending.timestamp.getTime(),
    });
    void recordClaudeConversation(db, pending.worktreeId, pending.content, pending.cliToolId).catch(
      () => {}
    );
    return true;
  } catch (error) {
    logger.warn('pending-scrape-flush-failed', {
      worktreeId: pending.worktreeId,
      cliToolId: pending.cliToolId,
      instanceId: pending.instanceId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * End a hold whose deadline has passed, one way or the other (Issue #2436).
 *
 * Run at the top of every tick, because the tick that has to notice an expiry
 * is very often one that returns early — a static frame yields no new lines for
 * a scrollback tool and is a duplicate for an alternate-screen one, and neither
 * of those paths reaches the save block at the bottom of `checkForResponse`.
 *
 * The reader is asked ONE more time before the row is written. By the deadline
 * the throttled recheck (#2399) has usually already captured the turn and
 * dropped the hold, but the two are not in step — the recheck is every third
 * duplicate tick and this is a wall clock — and a last read costs one tail
 * parse against writing a pane dump that is about to be superseded.
 */
export async function settleExpiredPendingScrapedResponse(pollerKey: string): Promise<void> {
  const pending = pendingScrapedResponses.get(pollerKey);
  if (!pending || Date.now() < pending.expiresAt) return;

  const captured = await captureStructuredHistoryTurn(
    pending.worktreeId,
    pending.cliToolId,
    pending.instanceId,
    { worktreePath: pending.worktreePath, transcriptPathHint: pending.transcriptPathHint }
  );
  if (captured) {
    discardPendingScrapedResponse(pollerKey);
    settleStructuredHistoryRecheck(pollerKey);
    logger.info('pending-scrape-superseded', {
      worktreeId: pending.worktreeId,
      cliToolId: pending.cliToolId,
      instanceId: pending.instanceId,
      heldForMs: Date.now() - pending.timestamp.getTime(),
    });
    return;
  }

  flushPendingScrapedResponse(pollerKey, 'hold-expired');
}
