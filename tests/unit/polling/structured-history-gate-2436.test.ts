/**
 * The gate's `false` can say which `false` it is (Issue #2436).
 *
 * ## The defect this pins
 *
 * `captureStructuredHistoryTurn` answered a bare boolean, and the caller could
 * only read `false` as "save the pane's copy". Two very different states arrived
 * as that one value:
 *
 *  - the agent has not closed this turn yet — the reader is about to write the
 *    row, measured at ~700 ms later on codex 2026-09-08;
 *  - there is no transcript here at all, and the scraper is the only writer this
 *    turn will ever have.
 *
 * The readers could already tell them apart (`codex-transcript-turn-open` is
 * logged on exactly one of them). The information stopped at the return.
 *
 * ## Why an out-parameter and not a third return value
 *
 * A string union would be TRUTHY in all three states, and `lib/hooks/
 * stop-history-capture` reads this function's answer with `if (await …)` on
 * three lines. Every one of them would have started calling an open turn a
 * captured one, silently, with nothing for `tsc` to catch — and the deferred
 * reads that go on to write the row would have been cancelled by their own
 * success report. The boolean keeps meaning exactly what it has meant since
 * #2121; the third value arrives beside it.
 *
 * A stub reader that reports nothing must therefore behave exactly as it did
 * before this Issue, which the last group below pins: that is what keeps every
 * existing test double honest.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/sources/opencode/subscription', () => ({
  isOpencodeStructuredHistoryLive: vi.fn(() => false),
}));
vi.mock('@/lib/hooks/sources/claude/history', () => ({
  captureClaudeTranscriptTurn: vi.fn(async () => false),
  resolveClaudeTranscriptPath: vi.fn(async () => null),
}));
vi.mock('@/lib/hooks/sources/codex/history', () => ({
  captureCodexTranscriptTurn: vi.fn(async () => false),
  resolveCodexTranscriptPath: vi.fn(async () => null),
}));
vi.mock('@/lib/hooks/sources/antigravity/history', () => ({
  captureAntigravityTranscriptTurn: vi.fn(async () => false),
  resolveAntigravityTranscriptPath: vi.fn(async () => null),
}));
vi.mock('@/lib/hooks/sources/command-code/history', () => ({
  captureCommandCodeTranscriptTurn: vi.fn(async () => false),
  resolveCommandCodeTranscriptPath: vi.fn(async () => null),
}));

import { captureCodexTranscriptTurn } from '@/lib/hooks/sources/codex/history';
import {
  captureStructuredHistoryTurn,
  resetStructuredHistoryCaptureQueue,
  type StructuredHistoryCaptureReport,
} from '@/lib/polling/structured-history-gate';

const CAPTURE = { worktreePath: '/repos/wt-2436', transcriptPathHint: null } as const;
const WT = 'wt-2436';

/** Run one capture and hand back what the gate reported about it. */
async function capture(
  cliToolId: 'codex' | 'gemini' = 'codex'
): Promise<{ captured: boolean; report: StructuredHistoryCaptureReport }> {
  const report: StructuredHistoryCaptureReport = {};
  const captured = await captureStructuredHistoryTurn(WT, cliToolId, cliToolId, CAPTURE, report);
  return { captured, report };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStructuredHistoryCaptureQueue();
  vi.mocked(captureCodexTranscriptTurn).mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('[#2436] the three answers', () => {
  it('reports `captured` when the reader wrote the turn', async () => {
    vi.mocked(captureCodexTranscriptTurn).mockResolvedValue(true);

    const { captured, report } = await capture();

    expect(captured).toBe(true);
    expect(report.outcome).toBe('captured');
  });

  it('reports `not_yet_closed` when the reader says the turn is still open', async () => {
    vi.mocked(captureCodexTranscriptTurn).mockImplementation(async (_t, _c, reader) => {
      if (reader) reader.outcome = 'not_yet_closed';
      return false;
    });

    const { captured, report } = await capture();

    expect(captured).toBe(false);
    expect(report.outcome).toBe('not_yet_closed');
  });

  it('reports `unavailable` for a tool that keeps no transcript at all', async () => {
    // gemini declares `transcriptHistory: null`, so the gate answers before any
    // reader is consulted — and must still fill the report in.
    const { captured, report } = await capture('gemini');

    expect(captured).toBe(false);
    expect(report.outcome).toBe('unavailable');
    expect(vi.mocked(captureCodexTranscriptTurn)).not.toHaveBeenCalled();
  });

  it('reports `unavailable` when the reader throws', async () => {
    vi.mocked(captureCodexTranscriptTurn).mockRejectedValue(new Error('rollout unreadable'));

    const { captured, report } = await capture();

    expect(captured).toBe(false);
    expect(report.outcome).toBe('unavailable');
  });

  it('lets `captured` win over a stale `not_yet_closed` from an earlier turn', async () => {
    // The backfill case: the reader walks several pending turns oldest-first,
    // and the caller's report is about the NEWEST one. A reader that wrote the
    // last turn answers true, and true is `captured` whatever it left behind.
    vi.mocked(captureCodexTranscriptTurn).mockImplementation(async (_t, _c, reader) => {
      if (reader) reader.outcome = 'not_yet_closed';
      return true;
    });

    const { captured, report } = await capture();

    expect(captured).toBe(true);
    expect(report.outcome).toBe('captured');
  });
});

describe('[#2436] a reader that reports nothing', () => {
  it('is read as `unavailable`, which is the pre-#2436 behaviour exactly', async () => {
    // Every existing stub of a reader — and there are eight in this repository —
    // answers a bare boolean. The fail-open direction has to be the old one:
    // the scraper keeps the turn.
    const { captured, report } = await capture();

    expect(captured).toBe(false);
    expect(report.outcome).toBe('unavailable');
  });

  it('still answers the boolean when no report is passed at all', async () => {
    vi.mocked(captureCodexTranscriptTurn).mockResolvedValue(true);

    await expect(captureStructuredHistoryTurn(WT, 'codex', 'codex', CAPTURE)).resolves.toBe(true);
  });
});
