/**
 * wait Command - re-reading the pane after a hook_stop (Issue #3956)
 * Issue #3964: split out of wait.ts; wait.ts re-exports what it exported.
 */

import type { CurrentOutputResponse } from '../types/api-responses';
import { ApiError } from '../utils/api-client';
import { observedCurrentOutputPath } from './prompt';
import type { PollContext, PollState } from './wait-poll-state';
import { msBeforeDeadlines, sleep } from './wait-timing';
import {
  outstandingPrompt,
  readNewestPromptAt,
  reportsTurnBoundaries,
  turnSettled,
  type PromptLedgerRead,
} from './wait-turn-boundary';

/**
 * Interval between the re-reads of the pane after a `hook_stop`, under
 * `--fail-on-upstream-fault` (Issue #3956). See {@link settleAfterHookStop}.
 */
export const HOOK_STOP_SETTLE_INTERVAL_MS = 500;

/**
 * Longest `wait` re-reads the pane after a `hook_stop` before judging the last
 * frame it read (Issue #3956). See {@link settleAfterHookStop}.
 */
export const HOOK_STOP_SETTLE_MAX_MS = 5000;

/**
 * The path {@link settleAfterHookStop} re-reads the pane on (Issue #3956):
 * `?fresh=1` past the server's capture cache, whose 5 s TTL would otherwise
 * answer two reads 500 ms apart with the same capture and read a pane still
 * drawing as settled. A server older than the parameter ignores it and answers
 * as before, from the cache.
 */
export function settleCurrentOutputPath(worktreeId: string, instanceId?: string): string {
  return `${observedCurrentOutputPath(worktreeId, instanceId)}&fresh=1`;
}

/**
 * The frame a `hook_stop` completion is judged on, once the pane has settled
 * (Issue #3956).
 *
 * The agent's `Stop` can land before its reply is drawn. Measured 2026-10-27 on
 * codex-cli 0.164.0: `ask` returned on `basis=hook_stop` with the pane ending at
 * row 441–445 of 480, and the last rows were drawn ~3 s later. An upstream fault
 * printed at the end of the turn is in those rows, so the frame of the `Stop`
 * poll can carry no `upstreamFault` while the turn did fail.
 *
 * So the pane is read again every {@link HOOK_STOP_SETTLE_INTERVAL_MS} until two
 * reads in a row carry the same frame, and that frame is the one judged — by
 * every stage of a poll, not by the fault alone: {@link pollWorktree} judges it
 * as the next poll, so a prompt or a new turn drawn meanwhile is read as one.
 * The bound is {@link HOOK_STOP_SETTLE_MAX_MS}: no re-read starts after it, and
 * a pane still drawing then is judged on the last frame read rather than held.
 * The re-reads ask for a fresh capture ({@link settleCurrentOutputPath}); the
 * poll that saw the `Stop` does not.
 *
 * `--timeout` / `--stall-timeout` bound it too: no interval is slept that the
 * next re-read could not finish within, and each re-read is aborted at the
 * earliest of one interval, the bound and those deadlines — so the verdict
 * comes at most {@link HOOK_STOP_SETTLE_MAX_MS} after the `Stop` poll. The bound
 * is `settleDeadline`, set by {@link readyStage} when it reads the `Stop` poll and
 * shared with the ledger read of {@link faultFrameHasStop}, so time spent there
 * is not given again here. A re-read that is aborted or
 * fails ends the settle on the frame before it (an `ApiError` that is not an
 * abort still ends the wait, as on any poll). Frames that change count as
 * activity for `--stall-timeout`, as on any poll.
 */
export async function settleAfterHookStop<T extends CurrentOutputResponse>(
  poll: PollContext,
  state: PollState,
  data: T,
  settleDeadline: number,
): Promise<T> {
  const { client, worktreeId, options, startTime } = poll;
  const frameOf = (d: CurrentOutputResponse): string => d.fullOutput ?? d.content;
  let latest = data;
  while (Date.now() + HOOK_STOP_SETTLE_INTERVAL_MS <= settleDeadline) {
    if (msBeforeDeadlines(options, startTime, state.lastActivityTime, Date.now()) <= HOOK_STOP_SETTLE_INTERVAL_MS) {
      console.error(
        `Note: re-reading ${worktreeId} after its stop would pass --timeout/--stall-timeout; ` +
          'judging the last frame read.',
      );
      return latest;
    }
    await sleep(HOOK_STOP_SETTLE_INTERVAL_MS);
    const readBudgetMs = Math.min(
      HOOK_STOP_SETTLE_INTERVAL_MS,
      settleDeadline - Date.now(),
      msBeforeDeadlines(options, startTime, state.lastActivityTime, Date.now()),
    );
    // Past the bound already (a late timer): no read is started.
    if (readBudgetMs < 0) break;
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), readBudgetMs);
    let next: T;
    try {
      next = await client.get<T>(settleCurrentOutputPath(worktreeId, options.instance), {
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        console.error(
          `Note: ${worktreeId} did not answer a re-read after its stop within ${readBudgetMs}ms; ` +
            'judging the last frame read.',
        );
        return latest;
      }
      if (error instanceof ApiError) throw error;
      console.error(
        `Note: could not re-read ${worktreeId} after its stop ` +
          `(${error instanceof Error ? error.message : String(error)}); judging the last frame read.`,
      );
      return latest;
    } finally {
      clearTimeout(abortTimer);
    }
    if (next.content !== state.lastContent) {
      state.lastContent = next.content;
      state.lastActivityTime = Date.now();
    }
    const settled = frameOf(next) === frameOf(latest);
    latest = next;
    if (settled) return latest;
  }
  console.error(
    `Note: ${worktreeId} was still drawing ${HOOK_STOP_SETTLE_MAX_MS / 1000}s after its stop; ` +
      'judging the last frame read.',
  );
  return latest;
}

/**
 * Whether the agent has reported the end of the turn on a frame that carries an
 * upstream fault, so that frame is judged once settled (Issue #3956).
 *
 * The same two records {@link readyCompletionBasis} reads as `hook_stop`: a
 * `Stop` at or after the adopted turn, or — with no turn adopted — a `Stop`
 * after the newest prompt in the chat ledger. Neither is #1839's case (back at
 * the composer with no `Stop`), whose fault is reported on the spot as before.
 */
export async function faultFrameHasStop(
  poll: PollContext,
  state: PollState,
  data: CurrentOutputResponse,
  settleDeadline: number,
): Promise<boolean> {
  if (state.turnStartedAt !== null) return turnSettled(data, state.turnStartedAt);
  // No `Stop` on record at all: nothing the ledger says could make one, so it
  // is not asked and the fault is reported on the spot.
  if (data.lastStopEventAt == null) return false;
  if (!state.promptLedgerReadable || !reportsTurnBoundaries(data)) return false;
  // Bounded like the settle it decides on: a ledger that does not answer must
  // not hold an exit 11 past --timeout, nor without one past the settle's bound.
  const budgetMs = Math.min(
    settleDeadline - Date.now(),
    msBeforeDeadlines(poll.options, poll.startTime, state.lastActivityTime, Date.now()),
  );
  if (budgetMs <= 0) return false;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), budgetMs);
  let ledger: PromptLedgerRead;
  try {
    ledger = await readNewestPromptAt(poll.client, poll.worktreeId, poll.options, data, controller.signal);
  } finally {
    clearTimeout(abortTimer);
  }
  state.promptLedgerReadable = ledger.readable;
  return ledger.readable && ledger.submittedAt !== null && !outstandingPrompt(data, ledger.submittedAt);
}
