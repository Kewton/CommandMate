/**
 * The hook cannot wait for a file its own return unblocks (Issue #2398).
 *
 * #2246 gave the Stop receiver a retry and #2264 raised it to three, both on the
 * reading that the `stop` post and the transcript's last append are two events
 * racing. For Claude Code that is what they are. For codex the ordering is a
 * dependency running the other way: codex does not append the `task_complete`
 * that closes the turn until the Stop hook's command exits, and that command is
 * a synchronous `curl` at this receiver. Measured 2026-09-07 over three days of
 * logs — **105 codex stop events, 0 captured**, every one of them three
 * `codex-transcript-turn-open` lines 500 ms apart, with `task_complete` landing
 * 3–63 ms *after* the receiver answered.
 *
 * So the fake reader in this file is not "sometimes slow". It is the measured
 * condition: **it closes the turn only once the receiver has answered**, and
 * nothing else. Two things follow, and both are asserted below:
 *
 *  - against that fake, the awaited retries of #2264 can never win — the
 *    positive control at the bottom, without which every assertion here would
 *    also pass on the old code;
 *  - the detached read wins on its first attempt, and writes through the same
 *    gate call the poller uses, so the per-instance serialisation, the
 *    idempotent write, the broadcast and the relay trigger are all unchanged.
 *
 * What is *not* here is claude's behaviour: it is unchanged by this Issue, and
 * `./stop-history-capture-2246.test.ts` and `./stop-history-capture-2264.test.ts`
 * pin it — unmodified, which is the point.
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
  resolveStopTranscriptCapture,
  STOP_HOOK_BLOCKS_TRANSCRIPT_CLOSE,
  STOP_TRANSCRIPT_DEFERRED_DELAYS_MS,
  STOP_TRANSCRIPT_MAX_ATTEMPTS,
  STOP_TRANSCRIPT_RETRY_DELAY_MS,
} from '@/lib/hooks/stop-history-capture';

const WORKTREE = { id: 'wt-2398', path: '/repos/commandmate-issue-2398' } as const;

/** Long enough to cover every deferred read the default list schedules. */
const WHOLE_DEFERRED_BUDGET_MS = STOP_TRANSCRIPT_DEFERRED_DELAYS_MS.reduce((a, b) => a + b, 0);

/**
 * The measured codex condition, as a reader.
 *
 * `answered` is flipped by the *test*, immediately after the receiver's promise
 * resolves — which is the only thing codex's rollout was waiting for. Before
 * that the turn is open and every ask answers false, however many are made and
 * however far apart.
 */
function readerThatClosesOnlyAfterTheAnswer(): { answer(): void } {
  let answered = false;
  captureStructuredHistoryTurn.mockImplementation(async () => answered);
  return {
    answer() {
      answered = true;
    },
  };
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

describe('the turn that closes only after the receiver answers', () => {
  it('is written by the read that happens after the answer', async () => {
    const rollout = readerThatClosesOnlyAfterTheAnswer();

    const outcome = await resolveStopTranscriptCapture(WORKTREE, 'codex', 'codex');
    // codex appends `task_complete` 3–63 ms after this point, and not before it.
    rollout.answer();

    expect(outcome.status).toBe('deferred');
    await vi.advanceTimersByTimeAsync(STOP_TRANSCRIPT_DEFERRED_DELAYS_MS[0]);
    await expect(outcome.deferred).resolves.toBe(true);
  });

  it('writes through the gate the poller writes through, with the same arguments', async () => {
    // Requirement 2 of the Issue: the deferred read rides the existing
    // per-instance serialisation rather than opening a second way in. That is a
    // property of *which function it calls*, so that is what is asserted — the
    // broadcast and `onRelayTurnCompleted` are inside it and stay inside it.
    const rollout = readerThatClosesOnlyAfterTheAnswer();

    const outcome = await resolveStopTranscriptCapture(WORKTREE, 'codex', 'codex-2');
    rollout.answer();
    await vi.advanceTimersByTimeAsync(WHOLE_DEFERRED_BUDGET_MS);
    await outcome.deferred;

    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(2);
    for (const call of captureStructuredHistoryTurn.mock.calls) {
      expect(call).toEqual([
        'wt-2398',
        'codex',
        'codex-2',
        { worktreePath: WORKTREE.path, transcriptPathHint: null },
      ]);
    }
  });

  it('stops reading the moment one read writes the turn', async () => {
    const rollout = readerThatClosesOnlyAfterTheAnswer();

    const outcome = await resolveStopTranscriptCapture(WORKTREE, 'codex', 'codex');
    rollout.answer();
    await vi.advanceTimersByTimeAsync(WHOLE_DEFERRED_BUDGET_MS);
    await outcome.deferred;

    // One synchronous ask plus the first deferred one. The remaining three
    // entries of the list are not spent on a turn that is already written.
    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(2);
  });

  it('gives the turn back to the poller when it never closes at all', async () => {
    // An interrupted turn, or a codex that exited before flushing. The reads are
    // finite: this is a best-effort second trigger, not a queue.
    const outcome = await resolveStopTranscriptCapture(WORKTREE, 'codex', 'codex');

    await vi.advanceTimersByTimeAsync(WHOLE_DEFERRED_BUDGET_MS);

    await expect(outcome.deferred).resolves.toBe(false);
    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(
      1 + STOP_TRANSCRIPT_DEFERRED_DELAYS_MS.length
    );
  });
});

describe('what the agent waits for', () => {
  it('is one capture and no clock at all', async () => {
    // The acceptance criterion: the HTTP answer does not depend on the
    // transcript closing. Fake timers are never advanced in this test, so a
    // handler that slept for any length of time would hang it.
    readerThatClosesOnlyAfterTheAnswer();

    const outcome = await resolveStopTranscriptCapture(WORKTREE, 'codex', 'codex');

    expect(outcome.status).toBe('deferred');
    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(1);
  });

  it('is one capture even when the first one writes', async () => {
    captureStructuredHistoryTurn.mockResolvedValue(true);

    const outcome = await resolveStopTranscriptCapture(WORKTREE, 'codex', 'codex');

    expect(outcome.status).toBe('captured');
    expect(outcome.deferred).toBeUndefined();
    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(1);
    expect(hasStructuredHistoryTranscript).not.toHaveBeenCalled();
  });

  it('asks the filesystem question once, before scheduling anything', async () => {
    await resolveStopTranscriptCapture(WORKTREE, 'codex', 'codex');
    await vi.advanceTimersByTimeAsync(WHOLE_DEFERRED_BUDGET_MS);

    expect(hasStructuredHistoryTranscript).toHaveBeenCalledTimes(1);
  });
});

describe('the three answers', () => {
  it('says `unavailable` when there is no transcript to come back to', async () => {
    // No session pointer, no file, hooks the operator never wired up: nothing a
    // later read could find either, so nothing is scheduled.
    hasStructuredHistoryTranscript.mockResolvedValue(false);

    const outcome = await resolveStopTranscriptCapture(WORKTREE, 'codex', 'codex');

    expect(outcome.status).toBe('unavailable');
    expect(outcome.deferred).toBeUndefined();
    await vi.advanceTimersByTimeAsync(WHOLE_DEFERRED_BUDGET_MS);
    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(1);
  });

  it('says `unavailable` for a tool with nothing to pull', async () => {
    isPullTranscriptHistory.mockReturnValue(false);

    const outcome = await resolveStopTranscriptCapture(WORKTREE, 'codex', 'codex');

    expect(outcome.status).toBe('unavailable');
    expect(captureStructuredHistoryTurn).not.toHaveBeenCalled();
  });

  it('says `unavailable` when the caller asks for no deferred reads', async () => {
    const outcome = await resolveStopTranscriptCapture(WORKTREE, 'codex', 'codex', {
      deferredDelaysMs: [],
    });

    expect(outcome.status).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(WHOLE_DEFERRED_BUDGET_MS);
    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(1);
  });
});

describe('the boolean face the receiver has always had', () => {
  it('is false for a deferred turn, because the row is not written yet', async () => {
    // `captureTranscriptTurnOnStop` answers "History holds it *now*", which a
    // scheduled read is not — #2246 and #2264 pin that shape and this Issue does
    // not change it. The three-way word is what the receiver reads instead.
    readerThatClosesOnlyAfterTheAnswer();

    await expect(captureTranscriptTurnOnStop(WORKTREE, 'codex', 'codex')).resolves.toBe(false);
  });

  it('is true when the synchronous ask wrote the turn', async () => {
    captureStructuredHistoryTurn.mockResolvedValue(true);

    await expect(captureTranscriptTurnOnStop(WORKTREE, 'codex', 'codex')).resolves.toBe(true);
  });
});

describe('nothing here throws, and nothing rejects later', () => {
  it('answers false from the deferred read when the gate throws inside it', async () => {
    // A rejection from a detached promise is an unhandled rejection, which in
    // Node is a process-level event and not this hook's to cause.
    captureStructuredHistoryTurn
      .mockResolvedValueOnce(false)
      .mockRejectedValue(new Error('database closed'));

    const outcome = await resolveStopTranscriptCapture(WORKTREE, 'codex', 'codex');
    await vi.advanceTimersByTimeAsync(WHOLE_DEFERRED_BUDGET_MS);

    await expect(outcome.deferred).resolves.toBe(false);
  });

  it('answers unavailable when the capability lookup throws', async () => {
    isPullTranscriptHistory.mockImplementation(() => {
      throw new Error('registry unavailable');
    });

    await expect(resolveStopTranscriptCapture(WORKTREE, 'codex', 'codex')).resolves.toEqual({
      status: 'unavailable',
    });
  });
});

describe('who takes the deferred path', () => {
  it('is codex, and only codex', () => {
    // The membership is the whole decision, so it is pinned by value. A tool
    // added here stops retrying inside the hook; a tool removed goes back to
    // waiting on a file, which for codex is waiting on itself.
    expect([...STOP_HOOK_BLOCKS_TRANSCRIPT_CLOSE]).toEqual(['codex']);
  });

  it.each(['claude', 'antigravity', 'command-code'] as const)(
    'leaves %s on the awaited retries #2264 measured',
    async (cliToolId) => {
      const rollout = readerThatClosesOnlyAfterTheAnswer();

      const promise = resolveStopTranscriptCapture(WORKTREE, cliToolId, cliToolId);
      await vi.advanceTimersByTimeAsync(STOP_TRANSCRIPT_RETRY_DELAY_MS * STOP_TRANSCRIPT_MAX_ATTEMPTS);
      const outcome = await promise;
      rollout.answer();

      expect(outcome.status).toBe('unavailable');
      expect(outcome.deferred).toBeUndefined();
      expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(STOP_TRANSCRIPT_MAX_ATTEMPTS);
    }
  );

  it('is the control: the awaited retries can never win against this reader', async () => {
    // The positive control for the fake. If waiting *could* close the turn, the
    // three assertions in the first describe would pass on the old code too —
    // and this is what says they cannot. Three asks, a full second of the
    // agent's stop path, and the row is still unwritten when the hook answers.
    const rollout = readerThatClosesOnlyAfterTheAnswer();
    const startedAt = Date.now();

    const promise = resolveStopTranscriptCapture(WORKTREE, 'claude', 'claude');
    await vi.advanceTimersByTimeAsync(STOP_TRANSCRIPT_RETRY_DELAY_MS * STOP_TRANSCRIPT_MAX_ATTEMPTS);
    const outcome = await promise;
    rollout.answer();

    expect(outcome.status).toBe('unavailable');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
      STOP_TRANSCRIPT_RETRY_DELAY_MS * (STOP_TRANSCRIPT_MAX_ATTEMPTS - 1)
    );
  });
});

describe('the schedule', () => {
  it('starts past the longest measured append and stays finite', () => {
    // 3, 16, 59, 61 and 63 ms were the measured gaps between the receiver's
    // answer and codex's `task_complete`. The first read is at 150 ms, so it is
    // past all of them without betting on the scheduler.
    expect(STOP_TRANSCRIPT_DEFERRED_DELAYS_MS[0]).toBe(150);
    expect(STOP_TRANSCRIPT_DEFERRED_DELAYS_MS[0]).toBeGreaterThan(63);
    expect([...STOP_TRANSCRIPT_DEFERRED_DELAYS_MS]).toEqual([150, 500, 2_000, 5_000]);
  });

  it('waits between reads rather than spinning', async () => {
    await resolveStopTranscriptCapture(WORKTREE, 'codex', 'codex');
    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(STOP_TRANSCRIPT_DEFERRED_DELAYS_MS[0]);
    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(STOP_TRANSCRIPT_DEFERRED_DELAYS_MS[1]);
    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(3);
  });
});
