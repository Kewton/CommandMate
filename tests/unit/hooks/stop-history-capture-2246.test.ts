/**
 * The second trigger: the agent's own `stop` event (Issue #2246).
 *
 * The poller's trigger is a string analysis of a terminal frame, and it is
 * wrong occasionally — which used to cost a turn permanently, because the
 * reader wrote only the newest one and by the next judgement the newest one had
 * moved on. The agent knows the boundary exactly and has been posting it all
 * along.
 *
 * Three properties are what this module is, and all three are asserted below:
 *
 *  - it goes through the **same gate** as the poller, so the two entry points
 *    cannot drift and so the serialisation applies to both;
 *  - it **retries once**, because the last assistant record is appended to the
 *    transcript around — not necessarily before — the `stop` fires;
 *  - it retries **only when a retry could help**, because this runs on the
 *    agent's stop path and half a second spent for nothing is half a second
 *    added to a turn.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  STOP_TRANSCRIPT_RETRY_DELAY_MS,
} from '@/lib/hooks/stop-history-capture';

const WORKTREE = { id: 'wt-2246', path: '/repos/commandmate-issue-2246' } as const;

/** Short enough to keep the suite fast, long enough to be observable. */
const RETRY_MS = 20;

beforeEach(() => {
  vi.clearAllMocks();
  captureStructuredHistoryTurn.mockResolvedValue(false);
  hasStructuredHistoryTranscript.mockResolvedValue(true);
  isPullTranscriptHistory.mockReturnValue(true);
});

describe('the happy path', () => {
  it('asks the gate the poller asks, with the worktree’s own path', async () => {
    captureStructuredHistoryTurn.mockResolvedValue(true);

    await expect(
      captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude-2')
    ).resolves.toBe(true);

    expect(captureStructuredHistoryTurn).toHaveBeenCalledWith('wt-2246', 'claude', 'claude-2', {
      worktreePath: WORKTREE.path,
      transcriptPathHint: null,
    });
  });

  it('does not retry when the first ask succeeded', async () => {
    captureStructuredHistoryTurn.mockResolvedValue(true);

    await captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude');

    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(1);
    expect(hasStructuredHistoryTranscript).not.toHaveBeenCalled();
  });
});

describe('the retry', () => {
  it('asks a second time when the first answer was false', async () => {
    // The Stop-hook race: the prompt record is in the file and the reply is not.
    captureStructuredHistoryTurn.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(
      captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude', { retryDelayMs: RETRY_MS })
    ).resolves.toBe(true);

    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(2);
  });

  it('waits before asking again, rather than spinning', async () => {
    const started = Date.now();
    captureStructuredHistoryTurn.mockResolvedValue(false);

    await captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude', { retryDelayMs: 40 });

    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it('asks exactly twice and then gives the turn back to the poller', async () => {
    // One retry and not a loop: the poller's own trigger is still behind this,
    // and a hook handler that waits on a file is one that can hang a turn.
    await expect(
      captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude', { retryDelayMs: RETRY_MS })
    ).resolves.toBe(false);

    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(2);
  });

  it('is skipped when there is no transcript for the retry to re-read', async () => {
    // Every failure but "the body has not been flushed" is one waiting cannot
    // fix — no session pointer, no file, hooks the operator never wired up.
    hasStructuredHistoryTranscript.mockResolvedValue(false);

    await expect(
      captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude', { retryDelayMs: 5_000 })
    ).resolves.toBe(false);

    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(1);
  });

  it('is skipped when the caller asks for no delay', async () => {
    await captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude', { retryDelayMs: 0 });

    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(1);
  });

  it('defaults to half a second', () => {
    expect(STOP_TRANSCRIPT_RETRY_DELAY_MS).toBe(500);
  });
});

describe('the tools that have nothing to pull', () => {
  it.each(['opencode', 'gemini', 'copilot'] as const)(
    'returns immediately for %s, without asking or waiting',
    async (cliToolId) => {
      isPullTranscriptHistory.mockReturnValue(false);
      const started = Date.now();

      await expect(
        captureTranscriptTurnOnStop(WORKTREE, cliToolId, cliToolId, { retryDelayMs: 5_000 })
      ).resolves.toBe(false);

      expect(captureStructuredHistoryTurn).not.toHaveBeenCalled();
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  );
});

describe('nothing here throws', () => {
  it('answers false when the gate throws', async () => {
    captureStructuredHistoryTurn.mockRejectedValue(new Error('module graph not ready'));

    await expect(captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude')).resolves.toBe(false);
  });

  it('answers false when the capability lookup throws', async () => {
    isPullTranscriptHistory.mockImplementation(() => {
      throw new Error('registry unavailable');
    });

    await expect(captureTranscriptTurnOnStop(WORKTREE, 'claude', 'claude')).resolves.toBe(false);
  });
});
