/**
 * One writer at a time, and one question asked without doing the work
 * (Issue #2246).
 *
 * The gate grew a second caller. Until this Issue `captureStructuredHistoryTurn`
 * was reached from exactly one place — the poller's save path, whose ticks do
 * not overlap — and the Stop hook receiver arrives at the moment the poller is
 * most likely to be inside the same turn.
 *
 * **What the queue is for, stated precisely**, because #2246's text is not: the
 * duplicate-row race it describes is *not* open in the readers as they stand.
 * `findMessageByRequestId` and `createMessage` are adjacent and synchronous, so
 * a second caller has no point to interleave at, and two concurrent captures of
 * one turn already end in one row. What the queue does is keep that true — the
 * property is two adjacent statements, and an `await` slipped between them
 * re-opens the window in silence — and stop both triggers reading, parsing and
 * rendering the same 4 MiB tail at once.
 *
 * So the first describe block drives the two entry points against a reader with
 * a deliberate gap between its check and its write: the shape a reader would
 * have the moment anything asynchronous entered that stretch. Without the queue
 * it writes twice.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/sources/opencode/subscription', () => ({
  isOpencodeStructuredHistoryLive: vi.fn(() => false),
}));

/** A reader that behaves like the real one: read the row, then write it. */
const rows = new Set<string>();
let readerDelayMs = 0;
const readerCalls: string[] = [];

async function fakeReader(): Promise<boolean> {
  readerCalls.push('start');
  if (rows.has('turn')) return true;
  // The window every one of these Issues' writers has between the lookup and
  // the insert. Widened here so that an unserialised second caller lands in it.
  await new Promise((resolve) => setTimeout(resolve, readerDelayMs));
  rows.add('turn');
  return true;
}

vi.mock('@/lib/hooks/sources/claude/history', () => ({
  captureClaudeTranscriptTurn: vi.fn(async () => fakeReader()),
  resolveClaudeTranscriptPath: vi.fn(async () => '/transcripts/claude.jsonl'),
}));
vi.mock('@/lib/hooks/sources/codex/history', () => ({
  captureCodexTranscriptTurn: vi.fn(async () => false),
  resolveCodexTranscriptPath: vi.fn(async () => null),
}));
vi.mock('@/lib/hooks/sources/antigravity/history', () => ({
  captureAntigravityTranscriptTurn: vi.fn(async () => false),
  resolveAntigravityTranscriptPath: vi.fn(async () => null),
}));

import { captureClaudeTranscriptTurn, resolveClaudeTranscriptPath } from '@/lib/hooks/sources/claude/history';
import {
  captureStructuredHistoryTurn,
  hasStructuredHistoryTranscript,
  isPullTranscriptHistory,
  resetStructuredHistoryCaptureQueue,
} from '@/lib/polling/structured-history-gate';

const CAPTURE = { worktreePath: '/repos/wt-2246', transcriptPathHint: null } as const;

/** How many times the fake reader actually inserted. */
let inserts = 0;

beforeEach(() => {
  vi.clearAllMocks();
  resetStructuredHistoryCaptureQueue();
  rows.clear();
  readerCalls.length = 0;
  inserts = 0;
  readerDelayMs = 0;
  vi.mocked(captureClaudeTranscriptTurn).mockImplementation(async () => {
    const before = rows.size;
    const answer = await fakeReader();
    if (rows.size > before) inserts += 1;
    return answer;
  });
  vi.mocked(resolveClaudeTranscriptPath).mockResolvedValue('/transcripts/claude.jsonl');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('two triggers, one row', () => {
  it('does not let a second caller into a reader’s check-then-write window', async () => {
    readerDelayMs = 20;

    // The Stop hook and the poller, in the same tick, against a reader whose
    // lookup and insert are not adjacent. Unqueued, the second one reads "no
    // row", waits, and inserts a duplicate.
    const [stop, poller] = await Promise.all([
      captureStructuredHistoryTurn('wt-2246', 'claude', 'claude', CAPTURE),
      captureStructuredHistoryTurn('wt-2246', 'claude', 'claude', CAPTURE),
    ]);

    expect(stop).toBe(true);
    expect(poller).toBe(true);
    expect(inserts).toBe(1);
    expect(captureClaudeTranscriptTurn).toHaveBeenCalledTimes(2);
  });

  it('runs the second caller after the first rather than sharing its answer', async () => {
    // A shared promise would be wrong: the second caller may be asking about a
    // newer turn, and the answer it needs is about the file as it is now.
    readerDelayMs = 10;

    await Promise.all([
      captureStructuredHistoryTurn('wt-2246', 'claude', 'claude', CAPTURE),
      captureStructuredHistoryTurn('wt-2246', 'claude', 'claude', CAPTURE),
    ]);

    expect(readerCalls).toHaveLength(2);
  });

  it('does not serialise two different instances against each other', async () => {
    // The queue is per instance. `claude` and `claude-2` share a worktree and a
    // project directory, and one waiting on the other would be a self-inflicted
    // latency on every turn of a two-agent worktree.
    readerDelayMs = 30;
    let secondStarted = false;

    vi.mocked(captureClaudeTranscriptTurn).mockImplementation(async (target) => {
      if (target.instanceId === 'claude-2') secondStarted = true;
      await new Promise((resolve) => setTimeout(resolve, readerDelayMs));
      return true;
    });

    const first = captureStructuredHistoryTurn('wt-2246', 'claude', 'claude', CAPTURE);
    const second = captureStructuredHistoryTurn('wt-2246', 'claude', 'claude-2', CAPTURE);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(secondStarted).toBe(true);
    await Promise.all([first, second]);
  });

  it('releases the queue when a reader throws, so the next caller still runs', async () => {
    vi.mocked(captureClaudeTranscriptTurn)
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockResolvedValueOnce(true);

    const [first, second] = await Promise.all([
      captureStructuredHistoryTurn('wt-2246', 'claude', 'claude', CAPTURE),
      captureStructuredHistoryTurn('wt-2246', 'claude', 'claude', CAPTURE),
    ]);

    expect(first).toBe(false);
    expect(second).toBe(true);
  });

  it('lets a later caller run once the queue has drained', async () => {
    await captureStructuredHistoryTurn('wt-2246', 'claude', 'claude', CAPTURE);
    // A microtask for the entry to be removed by whoever put it there.
    await Promise.resolve();
    await captureStructuredHistoryTurn('wt-2246', 'claude', 'claude', CAPTURE);

    expect(captureClaudeTranscriptTurn).toHaveBeenCalledTimes(2);
  });
});

describe('isPullTranscriptHistory', () => {
  it.each(['claude', 'codex', 'antigravity'] as const)('is true for %s', (cliToolId) => {
    expect(isPullTranscriptHistory(cliToolId)).toBe(true);
  });

  it.each(['opencode', 'gemini', 'copilot'] as const)('is false for %s', (cliToolId) => {
    // opencode has a second writer too, but a *push* one — its subscription has
    // already received the reply and there is nothing to pull.
    expect(isPullTranscriptHistory(cliToolId)).toBe(false);
  });
});

describe('hasStructuredHistoryTranscript', () => {
  it('is true when the reader can name a file', async () => {
    await expect(
      hasStructuredHistoryTranscript('wt-2246', 'claude', 'claude', CAPTURE)
    ).resolves.toBe(true);
  });

  it('is false when it cannot', async () => {
    vi.mocked(resolveClaudeTranscriptPath).mockResolvedValue(null);
    await expect(
      hasStructuredHistoryTranscript('wt-2246', 'claude', 'claude', CAPTURE)
    ).resolves.toBe(false);
  });

  it.each(['opencode', 'gemini', 'copilot'] as const)(
    'never asks a reader about %s',
    async (cliToolId) => {
      await expect(
        hasStructuredHistoryTranscript('wt-2246', cliToolId, cliToolId, CAPTURE)
      ).resolves.toBe(false);
      expect(resolveClaudeTranscriptPath).not.toHaveBeenCalled();
    }
  );

  it('writes nothing — it is the question asked without the work', async () => {
    await hasStructuredHistoryTranscript('wt-2246', 'claude', 'claude', CAPTURE);
    expect(captureClaudeTranscriptTurn).not.toHaveBeenCalled();
  });

  it('is false when the lookup throws', async () => {
    vi.mocked(resolveClaudeTranscriptPath).mockRejectedValue(new Error('no such home'));
    await expect(
      hasStructuredHistoryTranscript('wt-2246', 'claude', 'claude', CAPTURE)
    ).resolves.toBe(false);
  });
});
