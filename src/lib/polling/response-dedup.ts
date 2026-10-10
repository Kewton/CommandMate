/**
 * Assistant response deduplication module (SRP: single responsibility)
 * Issue #1268: Prevents duplicate assistant messages for alternate-screen CLI tools
 *
 * Mirrors prompt-dedup.ts (Issue #565), but for normal (non-prompt) responses.
 *
 * Why this exists: tools that render in the terminal's alternate screen
 * (see `usesAlternateScreen`) have no scrollback, so the poller cannot use the
 * captured line count to tell "already saved" from "new". Without a line-count
 * cursor the poller would re-save the same finished screen on every tick, so
 * dedup has to be content-based instead.
 *
 * Design decision: in-memory only (no DB layer), keyed by pollerKey, and
 * cleared by stopPolling() — i.e. the cache lives exactly as long as one
 * polling cycle (one user turn). It answers "did I already save this screen
 * during THIS turn?" and deliberately does NOT persist across turns: an
 * identical response in a later turn is a real response and must be saved.
 * Suppressing it would reproduce the very bug this module fixes.
 *
 * ## The second cache: what the dedup skip owes the transcript reader (#2399)
 *
 * The guard above answers a question about the SCREEN, and `response-checker`
 * used to read its answer as a question about the TURN — a duplicate frame ended
 * the tick before `captureStructuredHistoryTurn` was reached, so for a pull-mode
 * tool (claude, codex, antigravity, command-code) the transcript reader was
 * asked exactly once per turn: on the poll that saved the scrape. For a reader
 * the premise is backwards. "The screen stopped changing" is precisely the
 * moment BEFORE the agent's own file closes the turn, so the one ask lands too
 * early, answers false, and the 900 ticks that follow — 30 minutes of
 * `MAX_POLLING_DURATION` at 2 s each — all return at the guard. Measured on
 * codex 2026-09-07: `codex-transcript-turn-open` once, then
 * `duplicate-response-skipped` until the poller's budget ran out, with the
 * rollout's `task_complete` appended 1.8 s after the single ask.
 *
 * So the dedup verdict now carries a caveat, and it lives here rather than in
 * `response-checker` for one reason: its lifetime is the response hash's
 * lifetime exactly. `stopPolling`, the `resume` that keeps a paused chain's
 * hash, and the worktree rename all have to treat the two the same, and the
 * only way to guarantee that without touching `response-poller-core` (which
 * owns those three calls) is for one function to clear both.
 *
 * ## The third cache: how often the skip says so (#3519)
 *
 * The skip logs `duplicate-response-skipped` so a reply missing from History
 * leaves a grep-able trace (#1695). Logged on every tick, a screen that stays
 * up writes that line every 2 s for the whole cycle — 51,933 lines in 24 h,
 * 80% of the server log. The run of duplicate ticks is counted here so the line
 * is written on the first tick of a run and then once per
 * {@link DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL} ticks. The count is about
 * one particular cached hash, so it lives and dies with it for the same reason
 * the recheck does.
 */

import { createHash } from 'crypto';
import { getOrInitGlobal } from '../global-state';

/**
 * In-memory cache: pollerKey -> SHA-256 hash of the last saved response content.
 *
 * On `globalThis` for the same reason `promptHashCache` is (Issue #2223): the
 * cache is owned by one polling cycle, and the poller module is evaluated once
 * per Next route bundle plus once in the custom server's graph. Per-graph
 * copies meant the guard that stops an alternate-screen reply being saved twice
 * was cleared by whichever bundle happened to call `stopPolling` — not the one
 * whose tick had populated it.
 */
declare global {
  // eslint-disable-next-line no-var
  var __responseHashCache: Map<string, string> | undefined;
  // eslint-disable-next-line no-var
  var __structuredHistoryRecheckCache: Map<string, number> | undefined;
  // eslint-disable-next-line no-var
  var __duplicateResponseSkipStreak: Map<string, number> | undefined;
}

const responseHashCache = getOrInitGlobal('__responseHashCache', () => new Map<string, string>());

/**
 * In-memory cache: pollerKey -> ticks still to wait before the transcript reader
 * is asked again (Issue #2399). Absence means nothing is owed.
 *
 * On `globalThis` for the same reason `responseHashCache` is, and populated and
 * cleared at exactly the same moments — see the module comment.
 */
const structuredHistoryRecheckCache = getOrInitGlobal('__structuredHistoryRecheckCache', () => new Map<string, number>());

/**
 * How many duplicate ticks separate two asks of the transcript reader (#2399).
 *
 * The reader's work is a tail read of the agent's transcript — 4 MiB for codex
 * — parsed and rendered, so asking on all 900 ticks of a 30-minute cycle is not
 * free even though the poller has nothing else to do with them. Three is chosen
 * against the two numbers that bracket it:
 *
 *  - the FIRST duplicate tick always asks (the countdown starts at zero), so in
 *    the ordinary case — the turn closed between the scrape and the next poll —
 *    the Markdown row lands ~2 s later and the throttle never applies at all;
 *  - a turn that closes late is then re-asked every ~6 s, which is inside the
 *    window where a missing reply is still an operator's "it hasn't shown up
 *    yet" rather than a lost turn.
 *
 * The cost this bounds is only ever paid while a turn is BOTH finished on screen
 * and still open in the transcript; the moment either the reader writes the row
 * or the cycle ends, the entry is gone.
 */
export const STRUCTURED_HISTORY_RECHECK_TICK_INTERVAL = 3;

/**
 * In-memory cache: pollerKey -> how many duplicate ticks in a row the current
 * cached hash has been skipped (Issue #3519). Absence means none yet.
 *
 * On `globalThis` for the same reason `responseHashCache` is, and cleared and
 * moved at exactly the same moments — see the module comment. A new
 * (non-duplicate) response restarts it in {@link isDuplicateResponse}.
 */
const duplicateResponseSkipStreak = getOrInitGlobal('__duplicateResponseSkipStreak', () => new Map<string, number>());

/**
 * How many duplicate ticks separate two `duplicate-response-skipped` lines
 * (Issue #3519).
 *
 * At the poller's 2 s tick this is one line a minute while a finished screen
 * stays up, so a 900-tick cycle writes 30 lines instead of 899. The first tick
 * of a run always logs, so the #1695 trace — "this reply was skipped, at this
 * time" — is still there for every run; what is dropped is the repetition.
 */
export const DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL = 30;

/** What {@link claimDuplicateResponseSkipLog} answers for one duplicate tick. */
export interface DuplicateResponseSkipLogClaim {
  /** true when this tick should write `duplicate-response-skipped` */
  log: boolean;
  /** 1-based position of this tick in the current run of duplicate ticks */
  consecutive: number;
  /** ticks skipped without a log line since the previous logged one */
  suppressed: number;
}

/**
 * Check whether the given response content was already saved during the current
 * polling cycle for the same pollerKey. If it is new, updates the cache.
 *
 * @param pollerKey - Poller key ("worktreeId:instanceId")
 * @param content - Cleaned response content to check
 * @returns true if this is a duplicate (same content already saved this cycle)
 */
export function isDuplicateResponse(pollerKey: string, content: string): boolean {
  const hash = createHash('sha256').update(content).digest('hex');

  if (responseHashCache.get(pollerKey) === hash) {
    return true;
  }

  responseHashCache.set(pollerKey, hash);
  // Issue #3519: a new response starts a new run of duplicate ticks.
  duplicateResponseSkipStreak.delete(pollerKey);
  return false;
}

/**
 * Count one duplicate tick for this pollerKey and say whether it should be
 * logged (Issue #3519).
 *
 * A claim, like {@link claimStructuredHistoryRecheck}: it advances the count, so
 * call it exactly once per duplicate tick. Logs on the first tick of a run and
 * then on every {@link DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL}th tick after
 * it (ticks 1, 1+N, 1+2N, …).
 *
 * @param pollerKey - Poller key ("worktreeId:instanceId")
 * @returns Whether to log, the run length so far, and the ticks left unlogged
 *   since the previous line
 */
export function claimDuplicateResponseSkipLog(pollerKey: string): DuplicateResponseSkipLogClaim {
  const consecutive = (duplicateResponseSkipStreak.get(pollerKey) ?? 0) + 1;
  duplicateResponseSkipStreak.set(pollerKey, consecutive);

  const log = (consecutive - 1) % DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL === 0;
  const suppressed = consecutive === 1 ? 0 : DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL - 1;
  return { log, consecutive, suppressed };
}

/**
 * Note that the transcript reader has unfinished business for this pollerKey
 * (Issue #2399).
 *
 * Called by `response-checker` on every poll that gets PAST the guard above and
 * finds neither structured writer willing to own the turn — i.e. the push
 * subscription is not live and the pull reader answered false. That false is the
 * one the poller used to treat as final, and this records that it was not.
 *
 * Idempotent, and deliberately does not restart the countdown: a turn that has
 * been waiting five ticks for its transcript to close must not be pushed back to
 * the end of the queue by a sixth poll that learned nothing new.
 *
 * The tool is not consulted. `captureStructuredHistoryTurn` answers "does this
 * tool keep a transcript at all?" in a map lookup and returns false for gemini,
 * copilot and opencode without touching a file, so an entry for one of them
 * costs a lookup every third tick and duplicating the gate's own dispatch here
 * would cost a second place for it to go stale.
 *
 * @param pollerKey - Poller key ("worktreeId:instanceId")
 */
export function markStructuredHistoryRecheckPending(pollerKey: string): void {
  if (!structuredHistoryRecheckCache.has(pollerKey)) {
    structuredHistoryRecheckCache.set(pollerKey, 0);
  }
}

/**
 * Forget the outstanding recheck for this pollerKey (Issue #2399).
 *
 * Called when the question has an answer: the reader wrote the row, or a push
 * subscription turned out to own the turn after all. Nothing is owed and the
 * next duplicate tick returns at the guard exactly as it did before this Issue.
 *
 * @param pollerKey - Poller key ("worktreeId:instanceId")
 */
export function settleStructuredHistoryRecheck(pollerKey: string): void {
  structuredHistoryRecheckCache.delete(pollerKey);
}

/**
 * Take this tick's turn at asking the transcript reader again (Issue #2399).
 *
 * A claim rather than a query, because the throttle has to be spent exactly once
 * per tick and the caller is the only thing that knows a tick happened: this
 * both answers "ask now?" and advances the countdown, so two calls in one tick
 * would ask twice as often rather than twice.
 *
 * False when nothing is owed for this key ({@link markStructuredHistoryRecheckPending}
 * was never called, or {@link settleStructuredHistoryRecheck} has since run) and
 * false on the ticks the throttle swallows. True on the first duplicate tick
 * after a pending mark, and every
 * {@link STRUCTURED_HISTORY_RECHECK_TICK_INTERVAL} ticks after that.
 *
 * @param pollerKey - Poller key ("worktreeId:instanceId")
 * @returns true when the caller should ask the reader on this tick
 */
export function claimStructuredHistoryRecheck(pollerKey: string): boolean {
  const ticksToWait = structuredHistoryRecheckCache.get(pollerKey);
  if (ticksToWait === undefined) return false;

  if (ticksToWait > 0) {
    structuredHistoryRecheckCache.set(pollerKey, ticksToWait - 1);
    return false;
  }

  structuredHistoryRecheckCache.set(pollerKey, STRUCTURED_HISTORY_RECHECK_TICK_INTERVAL - 1);
  return true;
}

/**
 * Clear the response hash cache for a specific pollerKey.
 * Called during session cleanup / stopPolling, so each new user turn starts
 * with a clean slate.
 *
 * Issue #2399: the outstanding recheck goes with it. The caveat is a note about
 * one particular cached hash — "the screen behind it was static before the
 * transcript closed" — so it can outlive neither the hash nor the cycle, and
 * carrying it into a new turn would spend reads asking about a turn that is
 * over.
 *
 * @param pollerKey - Poller key ("worktreeId:instanceId")
 */
export function clearResponseHashCache(pollerKey: string): void {
  responseHashCache.delete(pollerKey);
  structuredHistoryRecheckCache.delete(pollerKey);
  // Issue #3519: the skip count is about the same hash.
  duplicateResponseSkipStreak.delete(pollerKey);
}

/**
 * Move the cached hash from one pollerKey to another.
 *
 * Used when a worktree ID is renamed underneath a running poller
 * (Issue #1621 Phase 3). The cache answers "did I already save this screen
 * during THIS turn?", and the turn does not end just because the ID moved —
 * dropping it would re-save the screen currently on display.
 *
 * No-op when nothing is cached under `oldKey`.
 *
 * @param oldKey - Poller key the cache entry lives under
 * @param newKey - Poller key it should live under
 */
export function renameResponseHashCacheKey(oldKey: string, newKey: string): void {
  if (oldKey === newKey) return;
  const hash = responseHashCache.get(oldKey);
  responseHashCache.delete(oldKey);
  if (hash !== undefined) responseHashCache.set(newKey, hash);

  // Issue #2399: the recheck caveat moves with the hash it is about. Leaving it
  // behind would strand a turn whose transcript is still open — the new key
  // starts owing nothing, so every later tick returns at the dedup guard and the
  // Markdown row is never written.
  const ticksToWait = structuredHistoryRecheckCache.get(oldKey);
  structuredHistoryRecheckCache.delete(oldKey);
  if (ticksToWait !== undefined) structuredHistoryRecheckCache.set(newKey, ticksToWait);

  // Issue #3519: the skip count moves with the hash too, so a rename mid-run
  // does not restart the thinning and log as if a new run had begun.
  const streak = duplicateResponseSkipStreak.get(oldKey);
  duplicateResponseSkipStreak.delete(oldKey);
  if (streak !== undefined) duplicateResponseSkipStreak.set(newKey, streak);
}
