/**
 * Reading the transcript when the agent says it stopped (Issue #2246).
 *
 * ## Why the poller was not enough
 *
 * `lib/polling/structured-history-gate` is asked to record a turn at exactly one
 * moment: the poll on which the scraper decided the turn had finished and was
 * about to save its own copy. That is the right moment — doing the handover at
 * the point of the write is what makes it impossible for both writers to run —
 * but it is the *only* moment, and the decision behind it is a string analysis
 * of a terminal frame.
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
import { createLogger } from '@/lib/logger';

const logger = createLogger('lib/hooks/stop-history-capture');

/**
 * How long to wait before asking a second time.
 *
 * The `stop` hook fires when the agent considers the turn over, and the last
 * assistant record is appended to the transcript around — not necessarily
 * before — that instant. A reader that arrives in the gap sees the prompt
 * record and no body, answers false (correctly: an empty row would be a blank
 * reply forever) and, without a retry, hands a turn the agent has definitely
 * finished back to the scraper.
 *
 * Half a second is chosen against what the gap actually is — a file append that
 * has already been issued — rather than against a timeout. One retry and not a
 * loop, because the poller's own trigger is still behind this: if the file is
 * still empty after the retry, the next poll is the right place to notice, and
 * a hook handler that waits on a file is a hook handler that can hang a turn.
 */
export const STOP_TRANSCRIPT_RETRY_DELAY_MS = 500;

/** The worktree fields this module needs; a narrowing of `Worktree`. */
export interface StopCaptureWorktree {
  readonly id: string;
  readonly path: string;
}

/** Test seams for {@link captureTranscriptTurnOnStop}. */
export interface StopHistoryCaptureOptions {
  /** Defaults to {@link STOP_TRANSCRIPT_RETRY_DELAY_MS}. 0 skips the retry. */
  readonly retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Ask the pull-mode reader to record this instance's turn, now.
 *
 * The tool question is asked first and without doing any work
 * (`isPullTranscriptHistory`), so a `stop` from gemini, copilot or opencode
 * costs one map lookup and returns — in particular it never waits out the
 * retry delay. opencode has a second writer too, but a *push* one: its
 * subscription has already received the reply and there is nothing to pull.
 *
 * The import is dynamic so that the poller's module graph — which reaches every
 * transcript reader and the whole opencode client — does not become a static
 * dependency of the hook receiver.
 *
 * @param worktree - The worktree the event resolved to
 * @param cliToolId - The tool that sent the event
 * @param instanceId - The already-resolved instance id
 * @returns Whether History now holds this instance's newest turn as Markdown
 */
export async function captureTranscriptTurnOnStop(
  worktree: StopCaptureWorktree,
  cliToolId: CLIToolType,
  instanceId: string,
  options: StopHistoryCaptureOptions = {}
): Promise<boolean> {
  try {
    const { captureStructuredHistoryTurn, hasStructuredHistoryTranscript, isPullTranscriptHistory } =
      await import('@/lib/polling/structured-history-gate');
    if (!isPullTranscriptHistory(cliToolId)) return false;

    // No `transcriptPathHint`: that value is a line the *pane* printed, and the
    // hook receiver has not read the pane. A tool whose transcript can only be
    // found that way has no session pointer either, and therefore sends no stop
    // event this path could act on.
    const capture = { worktreePath: worktree.path, transcriptPathHint: null };

    if (await captureStructuredHistoryTurn(worktree.id, cliToolId, instanceId, capture)) {
      return true;
    }

    const retryDelayMs = options.retryDelayMs ?? STOP_TRANSCRIPT_RETRY_DELAY_MS;
    if (retryDelayMs <= 0) return false;

    // The retry is for one failure and one only: the turn's last assistant
    // record had not been appended yet. Every other reason the capture answers
    // false — no session pointer, no transcript, the operator never wired hooks
    // for this tool — is a reason waiting cannot fix, and this handler is on the
    // agent's own stop path, so half a second spent for nothing is half a second
    // added to every turn it is spent on.
    if (!(await hasStructuredHistoryTranscript(worktree.id, cliToolId, instanceId, capture))) {
      return false;
    }

    await sleep(retryDelayMs);
    const captured = await captureStructuredHistoryTurn(
      worktree.id,
      cliToolId,
      instanceId,
      capture
    );
    logger.debug('stop-history-capture-retried', {
      worktreeId: worktree.id,
      cliToolId,
      instanceId,
      captured,
    });
    return captured;
  } catch (error) {
    logger.warn('stop-history-capture-failed', {
      worktreeId: worktree.id,
      cliToolId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
