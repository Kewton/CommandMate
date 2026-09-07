/**
 * Reading the transcript when the agent says it stopped (Issue #2246).
 *
 * ## Why the poller was not enough
 *
 * `lib/polling/structured-history-gate` is asked to record a turn from exactly
 * one place: the scraper's own judgement that the turn had finished and its copy
 * was about to be saved. That is the right place — doing the handover at the
 * point of the write is what makes it impossible for both writers to run — but
 * the judgement behind it is a string analysis of a terminal frame, and the
 * whole trigger hangs off it.
 *
 * Issue #2399 made the ask itself repeat: the poll that saves the scrape now
 * re-asks the reader on the duplicate ticks after it, throttled, until it
 * answers. That closes the case where the frame is judged finished BEFORE the
 * transcript closes — the ordinary one. It does nothing for a completion the
 * frame analysis never judges at all, which is the case below.
 *
 * When that analysis misses one completion the cost is not a delay. By the time
 * the next completion is judged, the newest turn is the next one; before #2246
 * the reader wrote only that, so the missed turn belonged to nobody and stayed
 * missing. One misjudged frame, one turn gone (measured 2026-09-02: a reply the
 * transcript held in full and History never showed).
 *
 * The agent itself knows the boundary exactly, and has been telling us: the
 * `stop` hook. This module is that second trigger.
 *
 * ## Knowing the boundary is not the same as the file having reached it
 *
 * The `stop` post and the transcript's last append are two events, and the
 * reader refuses a turn it cannot prove is closed — so the cost of asking too
 * early is a `false` rather than a truncated row. What to *do* about that
 * `false` is the whole of this module, and the answer depends on which of the
 * two events is waiting for the other.
 *
 * ## Waiting inside the hook is sometimes waiting on ourselves (Issue #2398)
 *
 * #2246 and #2264 both read the gap as a race — two appends with no ordering
 * between them, so asking again after half a second eventually wins. That
 * reading is Claude Code's, and for Claude Code it is true: claude writes the
 * transcript and *then* runs its Stop hook, which is why 506 of 508 measured
 * claude stops captured on the first ask, and why the two that did not were
 * caught by the retry #2264 added.
 *
 * codex is the other way round, and there the ordering is not a race but a
 * dependency. Measured across three days of logs (2026-09-07): of **105** codex
 * stop events, **0** captured. Every one of them logged
 * `codex-transcript-turn-open` three times, 500 ms apart, and the rollout's
 * `task_complete` for that same `turn_id` was appended **3–63 ms after the
 * receiver answered** — five turns measured, every one on that side of the
 * response. codex does not write the record that closes the turn until the Stop
 * hook's command exits, and the Stop hook's command is a synchronous `curl` at
 * this receiver. The retry loop was waiting for an append its own caller was
 * holding up. That is a self-wait: no number of attempts and no interval can
 * win it, and the 1 s it spent losing was added to the end of every codex turn.
 *
 * So the shape is not "ask again", it is **ask once, then get out of the way**:
 * one synchronous attempt — all claude, antigravity and command-code have ever
 * needed — and, for a tool whose transcript is waiting on this very hook, a
 * detached read that only starts once the receiver has answered. The detached
 * read goes through the same gate as everything else, so it inherits the
 * per-instance serialisation, the idempotent write, the `broadcastMessage` and
 * the relay's `onRelayTurnCompleted`; nothing about what a captured turn *does*
 * changes with when it is captured.
 *
 * ## What it does not do
 *
 * **It does not replace the poller's call.** A session with no hooks — or with
 * hooks the operator never wired up — sends no `stop`, and for it the poller is
 * still the only trigger there is. Two triggers for one turn cost nothing
 * because the readers are idempotent and the gate serialises them per instance;
 * one trigger that is sometimes absent costs a reply.
 *
 * **It does not decide anything about the turn.** The whole judgement stays in
 * the gate and the readers, so the two entry points cannot drift.
 *
 * Never throws: a hook post is fire-and-forget from a CLI's stop handler, and a
 * failure here must not become the agent's problem.
 *
 * @module lib/hooks/stop-history-capture
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { CODEX_CLI_TOOL_ID } from '@/lib/hooks/sources/codex/tool-id';
import { createLogger } from '@/lib/logger';

const logger = createLogger('lib/hooks/stop-history-capture');

/**
 * How long to wait before asking again, on the awaited path.
 *
 * The `stop` hook fires when the agent considers the turn over, and — for a tool
 * that writes its transcript first — the last assistant record is appended
 * around, not necessarily before, that instant. A reader that arrives in the gap
 * sees a turn that is not closed, answers false (correctly: the row it would
 * write is a reply with its last paragraph missing, frozen under the turn key
 * forever) and, without a retry, hands a turn the agent has definitely finished
 * back to the scraper.
 *
 * Half a second is chosen against what the gap actually is — a file append that
 * has already been issued — rather than against a timeout. Which is exactly why
 * it is the wrong instrument for a tool where the append has *not* been issued
 * because this handler has not returned; see
 * {@link STOP_HOOK_BLOCKS_TRANSCRIPT_CLOSE}.
 */
export const STOP_TRANSCRIPT_RETRY_DELAY_MS = 500;

/**
 * How many times the reader is asked in total, on the awaited path (Issue #2264).
 *
 * #2246 asked twice, on the reading that the only thing a retry waits for is one
 * append that has already been issued. The incident #2264 was reported for says
 * that is not always one append: the measured gap between the `stop` post and
 * the last `text` record was around 100 ms in the fast case, but the turns that
 * were saved short had *tool* records still arriving, and a single 500 ms retry
 * lands inside that run rather than after it.
 *
 * Three and not a loop, because a hook handler that waits on a file is a hook
 * handler that can hang a turn. The worst case this bounds is 1 s of the agent's
 * stop path, spent only on an instance that has a transcript and an open turn.
 *
 * #2264's own comment here used to add that "if the turn is still open after the
 * third ask, the next poll is the right place to notice". Issue #2398 measured
 * that sentence and found two claims of which only the first held: the poller
 * does run again when the pane returns to the composer, but on the measured
 * codex incident it never reached the gate — its content dedup returned before
 * the capture call. Issue #2399 fixed that half. A poll that skips a duplicate
 * frame now re-asks the reader from inside the skip, throttled to one ask every
 * three ticks, so the sentence is true again and the third attempt does have a
 * second chance behind it.
 *
 * Which is a reason to leave this ceiling where it is, not to raise it. The
 * recheck is what makes three enough: a fourth awaited ask would spend another
 * 500 ms of the agent's stop path buying what a tick of the poller now provides
 * for nothing. And it is still no answer for a tool that cannot close its turn
 * while this handler is running, because there the first thing that has to
 * happen is this handler returning — a backstop measured in poll ticks cannot
 * bring that forward. That case leaves the awaited path entirely:
 * {@link STOP_TRANSCRIPT_DEFERRED_DELAYS_MS}.
 */
export const STOP_TRANSCRIPT_MAX_ATTEMPTS = 3;

/**
 * When the detached reads happen, once the receiver has answered (Issue #2398).
 *
 * Each entry is the wait *before* that read, measured from the previous one, so
 * the reads land roughly 150 ms, 650 ms, 2.65 s and 7.65 s after the hook was
 * answered. Two facts set the shape:
 *
 *  - **The first entry is the one that matters.** codex appended
 *    `task_complete` 3, 16, 59, 61 and 63 ms after the response on the five
 *    turns that were timed, so a first read at 150 ms is past all of them with
 *    room to spare. Anything shorter starts betting on the scheduler.
 *  - **The tail is for the turn that was never going to close.** A turn
 *    interrupted, or a codex that exits before flushing, never appends anything,
 *    and the reads after the first exist so that a slow flush is caught rather
 *    than for the common case. They are cheap — a `false` from the gate is a
 *    tail read and a parse — and they cost the agent nothing at all, because by
 *    then the agent has its answer and this promise is detached.
 *
 * Finite, and short of the 30 min the poller runs for, because this is a
 * best-effort second trigger and not a queue: a turn nobody could read stays the
 * scraper's, which is the fail-open every one of these Issues asks for.
 */
export const STOP_TRANSCRIPT_DEFERRED_DELAYS_MS: readonly number[] = [150, 500, 2_000, 5_000];

/**
 * Tools whose transcript cannot close while this handler is still running
 * (Issue #2398).
 *
 * A tool id table, which this layer otherwise refuses to keep — the gate's own
 * comment on `PULL_TRANSCRIPT_READERS` argues the case, and the rule there is
 * that a table is allowed when it dispatches on a fact and forbidden when it
 * *decides* one. The fact here is an ordering, and it was measured per tool:
 *
 * | tool | stop hook vs. the transcript's last record | captured on the first ask |
 * |---|---|---|
 * | claude | hook runs **after** the record is written | 506 / 508 |
 * | antigravity | after | 9 / 9 |
 * | command-code | after | 1 / 1 |
 * | codex | hook runs **before**, and the record waits for it | **0 / 105** |
 *
 * Membership therefore says one thing only: for this tool, a `false` from the
 * synchronous ask means "the agent is waiting for me", so the answer is to
 * answer and read afterwards. A tool that is *not* here keeps #2264's behaviour
 * exactly — the awaited retries — because for it the append really is in flight
 * and waiting really does win.
 *
 * Where this belongs eventually is `AgentSourceCapabilities`, beside
 * `transcriptHistory`: a source declaring `stopBlocksTranscriptClose` would let
 * this module stop naming anybody. It is not there yet because the ordering has
 * only been measured for four tools and only one of them needs it, and a
 * capability every source has to answer is a claim every source has to have
 * measured. The second member is the right moment to move it.
 */
export const STOP_HOOK_BLOCKS_TRANSCRIPT_CLOSE: ReadonlySet<CLIToolType> = new Set<CLIToolType>([
  CODEX_CLI_TOOL_ID,
]);

/** The worktree fields this module needs; a narrowing of `Worktree`. */
export interface StopCaptureWorktree {
  readonly id: string;
  readonly path: string;
}

/**
 * What the receiver was able to do about this instance's newest turn.
 *
 * Three words rather than a boolean because #2398 splits the old `false` in two,
 * and the halves want opposite reactions from whoever reads the log: `deferred`
 * is the ordinary state of every codex turn and means the row is coming,
 * `unavailable` is the old "nobody is writing this down but the scraper".
 *
 *  - `captured` — History holds the turn as the agent's own Markdown, written
 *    before the hook was answered.
 *  - `deferred` — the turn was open, the transcript exists, and detached reads
 *    are scheduled. Whether they succeed is logged, not returned: the receiver
 *    has answered by then.
 *  - `unavailable` — nothing was written and nothing is scheduled: a tool with
 *    no transcript to pull from, an instance with no session pointer or no file,
 *    or an awaited retry budget that ran out.
 */
export type StopTranscriptCaptureStatus = 'captured' | 'deferred' | 'unavailable';

/** The outcome of {@link resolveStopTranscriptCapture}. */
export interface StopTranscriptCaptureResult {
  readonly status: StopTranscriptCaptureStatus;
  /**
   * Settles with whether the detached reads ended up writing the turn.
   *
   * Present only for `deferred`, and deliberately **not** awaited by the hook
   * receiver — awaiting it is the defect this Issue is about. It is here so a
   * test can be deterministic about work that is, in production, nobody's to
   * wait for.
   */
  readonly deferred?: Promise<boolean>;
}

/** Test seams for {@link captureTranscriptTurnOnStop}. */
export interface StopHistoryCaptureOptions {
  /** Defaults to {@link STOP_TRANSCRIPT_RETRY_DELAY_MS}. 0 skips every retry. */
  readonly retryDelayMs?: number;
  /** Defaults to {@link STOP_TRANSCRIPT_MAX_ATTEMPTS}; counts the first ask. */
  readonly maxAttempts?: number;
  /**
   * Defaults to {@link STOP_TRANSCRIPT_DEFERRED_DELAYS_MS}. An empty list turns
   * the detached read off, which is what a caller that wants the synchronous
   * answer and nothing else asks for.
   */
  readonly deferredDelaysMs?: readonly number[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The gate's three entry points, as this module uses them. */
type StructuredHistoryGate = typeof import('@/lib/polling/structured-history-gate');

/**
 * Read again, after the receiver has already answered (Issue #2398).
 *
 * Detached: nothing awaits the returned promise in production, which is the
 * whole point — for codex this loop only gets to see a closed turn *because*
 * the hook it was posted by has returned. Each read goes through the gate, so a
 * poll that beats it to the same turn is serialised behind it and the write
 * stays idempotent either way.
 *
 * Stops at the first success and never throws.
 */
async function readAfterResponding(
  gate: StructuredHistoryGate,
  worktree: StopCaptureWorktree,
  cliToolId: CLIToolType,
  instanceId: string,
  capture: { worktreePath: string; transcriptPathHint: null },
  delaysMs: readonly number[]
): Promise<boolean> {
  const startedAt = Date.now();
  try {
    for (const [index, delayMs] of delaysMs.entries()) {
      await sleep(delayMs);
      const captured = await gate.captureStructuredHistoryTurn(
        worktree.id,
        cliToolId,
        instanceId,
        capture
      );
      if (captured) {
        // The line an operator greps when a codex reply did reach the chat
        // surface: the receiver's own `agent-event-stop-applied` cannot carry
        // it, because it was written before this read existed.
        logger.info('stop-history-capture-deferred-captured', {
          worktreeId: worktree.id,
          cliToolId,
          instanceId,
          attempt: index + 1,
          attempts: delaysMs.length,
          elapsedMs: Date.now() - startedAt,
        });
        return true;
      }
      logger.debug('stop-history-capture-deferred-open', {
        worktreeId: worktree.id,
        cliToolId,
        instanceId,
        attempt: index + 1,
        attempts: delaysMs.length,
        elapsedMs: Date.now() - startedAt,
      });
    }
    logger.info('stop-history-capture-deferred-exhausted', {
      worktreeId: worktree.id,
      cliToolId,
      instanceId,
      attempts: delaysMs.length,
      elapsedMs: Date.now() - startedAt,
    });
    return false;
  } catch (error) {
    logger.warn('stop-history-capture-deferred-failed', {
      worktreeId: worktree.id,
      cliToolId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Ask the pull-mode reader to record this instance's turn, and say what happened.
 *
 * The tool question is asked first and without doing any work
 * (`isPullTranscriptHistory`), so a `stop` from gemini, copilot or opencode
 * costs one map lookup and returns — in particular it never waits out the
 * retry delay. opencode has a second writer too, but a *push* one: its
 * subscription has already received the reply and there is nothing to pull.
 *
 * Exactly **one** capture is awaited, whichever path is taken. What happens on a
 * `false` is the fork: a tool whose transcript is waiting on this hook gets the
 * detached reads and an immediate answer, and every other tool keeps #2264's
 * awaited retries. See {@link STOP_HOOK_BLOCKS_TRANSCRIPT_CLOSE}.
 *
 * The import is dynamic so that the poller's module graph — which reaches every
 * transcript reader and the whole opencode client — does not become a static
 * dependency of the hook receiver.
 *
 * @param worktree - The worktree the event resolved to
 * @param cliToolId - The tool that sent the event
 * @param instanceId - The already-resolved instance id
 * @returns What was written, or scheduled; see {@link StopTranscriptCaptureStatus}
 */
export async function resolveStopTranscriptCapture(
  worktree: StopCaptureWorktree,
  cliToolId: CLIToolType,
  instanceId: string,
  options: StopHistoryCaptureOptions = {}
): Promise<StopTranscriptCaptureResult> {
  try {
    const gate: StructuredHistoryGate = await import('@/lib/polling/structured-history-gate');
    if (!gate.isPullTranscriptHistory(cliToolId)) return { status: 'unavailable' };

    // No `transcriptPathHint`: that value is a line the *pane* printed, and the
    // hook receiver has not read the pane. A tool whose transcript can only be
    // found that way has no session pointer either, and therefore sends no stop
    // event this path could act on.
    const capture = { worktreePath: worktree.path, transcriptPathHint: null };

    if (await gate.captureStructuredHistoryTurn(worktree.id, cliToolId, instanceId, capture)) {
      return { status: 'captured' };
    }

    // Asked once, before any waiting, on either path: every failure other than
    // "the turn is not closed yet" — no session pointer, no transcript, hooks
    // the operator never wired up for this tool — is a reason neither waiting
    // nor deferring can fix, and an instance with no transcript will not have
    // one in 150 ms either. A transcript that exists does not stop existing
    // between attempts, so this is not re-asked.
    const hasTranscript = (): Promise<boolean> =>
      gate.hasStructuredHistoryTranscript(worktree.id, cliToolId, instanceId, capture);

    if (STOP_HOOK_BLOCKS_TRANSCRIPT_CLOSE.has(cliToolId)) {
      const delaysMs = options.deferredDelaysMs ?? STOP_TRANSCRIPT_DEFERRED_DELAYS_MS;
      if (delaysMs.length === 0) return { status: 'unavailable' };
      if (!(await hasTranscript())) return { status: 'unavailable' };

      const deferred = readAfterResponding(
        gate,
        worktree,
        cliToolId,
        instanceId,
        capture,
        delaysMs
      );
      logger.info('stop-history-capture-deferred', {
        worktreeId: worktree.id,
        cliToolId,
        instanceId,
        delaysMs,
      });
      return { status: 'deferred', deferred };
    }

    const retryDelayMs = options.retryDelayMs ?? STOP_TRANSCRIPT_RETRY_DELAY_MS;
    if (retryDelayMs <= 0) return { status: 'unavailable' };
    if (!(await hasTranscript())) return { status: 'unavailable' };

    const maxAttempts = Math.max(1, options.maxAttempts ?? STOP_TRANSCRIPT_MAX_ATTEMPTS);
    for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
      await sleep(retryDelayMs);
      const captured = await gate.captureStructuredHistoryTurn(
        worktree.id,
        cliToolId,
        instanceId,
        capture
      );
      logger.debug('stop-history-capture-retried', {
        worktreeId: worktree.id,
        cliToolId,
        instanceId,
        attempt,
        maxAttempts,
        captured,
      });
      if (captured) return { status: 'captured' };
    }
    return { status: 'unavailable' };
  } catch (error) {
    logger.warn('stop-history-capture-failed', {
      worktreeId: worktree.id,
      cliToolId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 'unavailable' };
  }
}

/**
 * Whether History now holds this instance's newest turn as Markdown.
 *
 * The boolean face of {@link resolveStopTranscriptCapture}, and the shape #2246
 * and #2264 pinned: `true` means the row is written *now*. A scheduled read is
 * not one, so codex answers false here on the turns it later captures — which is
 * why the receiver reads the status word instead (`AgentStopOutcome`), and why
 * the deferred outcome is logged rather than returned.
 */
export async function captureTranscriptTurnOnStop(
  worktree: StopCaptureWorktree,
  cliToolId: CLIToolType,
  instanceId: string,
  options: StopHistoryCaptureOptions = {}
): Promise<boolean> {
  const { status } = await resolveStopTranscriptCapture(
    worktree,
    cliToolId,
    instanceId,
    options
  );
  return status === 'captured';
}
