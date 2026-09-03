/**
 * Asking again until the turn is closed (Issue #2264).
 *
 * #2246 asked twice, on the reading that the only thing a retry waits for is one
 * file append that has already been issued. The incident says otherwise: the
 * turns saved short had *tool* records still arriving, and a single 500 ms retry
 * lands inside that run rather than after it.
 *
 * The reader now refuses a turn it cannot prove is closed, so the cost of asking
 * too early is a `false` rather than a truncated row — and the right answer to a
 * `false` is to ask again. Three times in total and then hand the turn back,
 * because the poller's own trigger is still behind this and a hook handler that
 * waits on a file is one that can hang a turn.
 *
 * Fake timers throughout: the point of the assertions is the *number* of asks
 * and the fact that the handler waits between them, and pinning either against a
 * real clock is how a suite acquires a flake.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captureStructuredHistoryTurn = vi.fn(async () => false);
const hasStructuredHistoryTranscript = vi.fn(async () => true);
const isPullTranscriptHistory = vi.fn(() => true);

vi.mock('@/lib/polling/structured-history-gate', () => ({
  captureStructuredHistoryTurn: (...a: unknown[]) => captureStructuredHistoryTurn(...(a as [])),
  hasStructuredHistoryTranscript: (...a: unknown[]) =>
    hasStructuredHistoryTranscript(...(a as [])),
  isPullTranscriptHistory: (...a: unknown[]) => isPullTranscriptHistory(...(a as [])),
}));

import {
  captureTranscriptTurnOnStop,
  STOP_TRANSCRIPT_MAX_ATTEMPTS,
  STOP_TRANSCRIPT_RETRY_DELAY_MS,
} from '@/lib/hooks/stop-history-capture';

const WORKTREE = { id: 'wt-2264', path: '/repos/commandmate-issue-2264' } as const;

/**
 * Run the handler to completion on fake timers.
 *
 * The handler interleaves `await`s with `setTimeout`, so the timers have to be
 * advanced *while* it is suspended rather than before or after — which is what
 * `advanceTimersByTimeAsync` is for. Advancing past the whole budget in one call
 * settles every sleep it will take.
 */
async function runToCompletion(promise: Promise<boolean>): Promise<boolean> {
  await vi.advanceTimersByTimeAsync(STOP_TRANSCRIPT_RETRY_DELAY_MS * STOP_TRANSCRIPT_MAX_ATTEMPTS);
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  captureStructuredHistoryTurn.mockResolvedValue(false);
  hasStructuredHistoryTranscript.mockResolvedValue(true);
  isPullTranscriptHistory.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the turn closes on a later attempt', () => {
  it('asks a third time, and writes when the third one closes', async () => {
    // The measured shape: the `stop` post beat two of the turn's records.
    captureStructuredHistoryTurn
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(
      runToCompletion(captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude'))
    ).resolves.toBe(true);

    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(3);
  });

  it('stops asking the moment one attempt succeeds', async () => {
    captureStructuredHistoryTurn.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(
      runToCompletion(captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude'))
    ).resolves.toBe(true);

    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(2);
  });
});

describe('the ceiling', () => {
  it('gives the turn back to the poller after the third ask', async () => {
    await expect(
      runToCompletion(captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude'))
    ).resolves.toBe(false);

    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(STOP_TRANSCRIPT_MAX_ATTEMPTS);
  });

  it('is three', () => {
    // The budget this bounds is the agent's own stop path: three asks and two
    // sleeps is at most 1 s, and only for an instance that has a transcript and
    // an open turn.
    expect(STOP_TRANSCRIPT_MAX_ATTEMPTS).toBe(3);
    expect(STOP_TRANSCRIPT_RETRY_DELAY_MS).toBe(500);
  });

  it('waits the delay between asks rather than spinning', async () => {
    const promise = captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude');

    // The first ask is synchronous with the call; nothing more happens until the
    // clock moves, which is the property that would be lost by a busy loop.
    await vi.advanceTimersByTimeAsync(0);
    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(STOP_TRANSCRIPT_RETRY_DELAY_MS);
    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(STOP_TRANSCRIPT_RETRY_DELAY_MS);
    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(3);

    await expect(promise).resolves.toBe(false);
  });

  it('is honoured when a caller asks for fewer attempts', async () => {
    await expect(
      runToCompletion(
        captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude', { maxAttempts: 2 })
      )
    ).resolves.toBe(false);

    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(2);
  });

  it('never asks fewer than once, however small the ceiling', async () => {
    await expect(
      runToCompletion(
        captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude', { maxAttempts: 0 })
      )
    ).resolves.toBe(false);

    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(1);
  });
});

describe('what is still not retried', () => {
  it('does not sleep at all when there is no transcript to re-read', async () => {
    // Every failure but "the turn is not closed yet" is one waiting cannot fix,
    // and this handler is on the agent's own stop path.
    hasStructuredHistoryTranscript.mockResolvedValue(false);

    await expect(
      runToCompletion(captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude'))
    ).resolves.toBe(false);

    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(1);
  });

  it('asks the filesystem question once, not once per attempt', async () => {
    await runToCompletion(captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude'));

    expect(hasStructuredHistoryTranscript).toHaveBeenCalledTimes(1);
  });
});
