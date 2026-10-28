/**
 * wait Command - what pollWorktree records off each frame before its stages judge it
 * Issue #3966: split out of pollWorktree to bring its complexity under 25.
 */

import type { CurrentOutputResponse } from '../types/api-responses';
import type { PollState, PollWorktreeOptions } from './wait-poll-state';
import { adoptTurnStart } from './wait-turn-boundary';

/** Stall detection and `everRunning` off one frame. */
export function trackPollActivity(state: PollState, data: CurrentOutputResponse): void {
  // Track content changes for stall detection
  if (data.content !== state.lastContent) {
    state.lastContent = data.content;
    state.lastActivityTime = Date.now();
  }

  if (data.isRunning) {
    state.everRunning = true;
  }
}

/** Adopt the turn this frame names and tell the caller's turn callbacks. */
export function adoptAndPublishTurn(
  state: PollState,
  data: CurrentOutputResponse,
  startTime: number,
  options: PollWorktreeOptions,
): void {
  // Issue #1839: done before any exit path so the turn is adopted even on a
  // poll that ends in a prompt — the same turn is still open when the human
  // answers and `--on-prompt human` resumes polling.
  state.turnStartedAt = adoptTurnStart(data, startTime, state.turnStartedAt);
  if (options.onTurnStart) {
    const published = data.structuredEvents;
    const closedAt = published?.openedAt != null && published.openedAt === state.turnStartedAt
      ? published.closedAt ?? null
      : null;
    options.onTurnStart(state.turnStartedAt, closedAt);
  }
  if (options.onTurnRecord) {
    options.onTurnRecord(data.structuredEvents?.openedAt ?? null, data.structuredEvents?.closedAt ?? null);
  }
}

/** Drop a self-resume hold whose `stop` is no longer the newest word. */
export function releaseMovedSelfResumeHold(
  worktreeId: string,
  state: PollState,
  selfResumeStopAt: number | null,
): void {
  if (state.selfResumeHold !== null && state.selfResumeHold.stopAt !== selfResumeStopAt) {
    const heldMs = Date.now() - state.selfResumeHold.since;
    state.selfResumeHeldMs += heldMs;
    state.selfResumeHold = null;
    console.error(
      `Note: ${worktreeId} has moved past the stop it said it would resume from ` +
        `(held ${Math.round(heldMs / 1000)}s); judging its current state.`,
    );
  }
}

/** Say that the prompt an Auto-Yes hold was waiting on has cleared, and end the hold. */
export function noteAutoYesPromptCleared(worktreeId: string, state: PollState): void {
  if (state.autoYesAnsweringSince !== null) {
    console.error(
      `Prompt on ${worktreeId} cleared after ` +
        `${Math.round((Date.now() - state.autoYesAnsweringSince) / 1000)}s; judging completion as usual.`,
    );
    state.autoYesAnsweringSince = null;
  }
}
