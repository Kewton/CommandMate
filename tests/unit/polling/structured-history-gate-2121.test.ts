/**
 * The pull-mode half of the scraper's stand-down (Issue #2121).
 *
 * `./structured-history-gate-2041.test.ts` pins the push-mode question — "is
 * opencode's subscription live?" — and this file pins the one Claude needs,
 * which is a different question with a different shape: "record this turn now,
 * and tell me whether you did".
 *
 * The predicate is wrong in only one direction, the same way its sibling is.
 * Answering true when nothing was written loses the reply; answering false when
 * something was written duplicates it. So every path that is not a completed
 * write must answer false, and the tool check must come first — the other five
 * tools have no transcript file and must never reach a reader for one.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/sources/opencode/subscription', () => ({
  isOpencodeStructuredHistoryLive: vi.fn(() => false),
}));
vi.mock('@/lib/hooks/sources/claude/history', () => ({
  captureClaudeTranscriptTurn: vi.fn(async () => false),
}));

import { captureClaudeTranscriptTurn } from '@/lib/hooks/sources/claude/history';
import { captureStructuredHistoryTurn } from '@/lib/polling/structured-history-gate';

const CAPTURE = { worktreePath: '/repos/wt-2121', transcriptPathHint: null } as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(captureClaudeTranscriptTurn).mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('captureStructuredHistoryTurn', () => {
  it('is true when the transcript reader recorded the turn', async () => {
    vi.mocked(captureClaudeTranscriptTurn).mockResolvedValue(true);
    expect(await captureStructuredHistoryTurn('wt-1', 'claude', 'claude', CAPTURE)).toBe(true);
  });

  it('is false when the transcript reader did not', async () => {
    expect(await captureStructuredHistoryTurn('wt-1', 'claude', 'claude', CAPTURE)).toBe(false);
  });

  it.each(['opencode', 'gemini', 'copilot'] as const)(
    'never asks the claude reader about %s',
    async (cliToolId) => {
      // The capability check is first for the same reason its sibling's is: a
      // reader that answered for a tool it cannot read would suppress the only
      // record that tool has.
      //
      // codex and antigravity used to be on this list and are not any more —
      // #2197 and #2198 gave each of them a reader, both pinned in
      // `./structured-history-gate-2197.test.ts`. What still holds for them, and
      // is asserted there, is that neither ever reaches *claude's* reader.
      vi.mocked(captureClaudeTranscriptTurn).mockResolvedValue(true);
      expect(await captureStructuredHistoryTurn('wt-1', cliToolId, undefined, CAPTURE)).toBe(false);
      expect(vi.mocked(captureClaudeTranscriptTurn)).not.toHaveBeenCalled();
    }
  );

  it('defaults the instance to the primary, as every other keyed lookup does', async () => {
    await captureStructuredHistoryTurn('wt-1', 'claude', undefined, CAPTURE);
    expect(vi.mocked(captureClaudeTranscriptTurn)).toHaveBeenCalledWith(
      { worktreeId: 'wt-1', cliToolId: 'claude', instanceId: 'claude' },
      CAPTURE
    );
  });

  it('carries a named instance through unchanged', async () => {
    await captureStructuredHistoryTurn('wt-1', 'claude', 'claude-3', CAPTURE);
    expect(vi.mocked(captureClaudeTranscriptTurn)).toHaveBeenCalledWith(
      { worktreeId: 'wt-1', cliToolId: 'claude', instanceId: 'claude-3' },
      CAPTURE
    );
  });

  it('hands the reader the worktree path and the pane’s hint verbatim', async () => {
    const capture = { worktreePath: '/repos/wt', transcriptPathHint: '/home/me/.claude/projects/x/s.jsonl' };
    await captureStructuredHistoryTurn('wt-1', 'claude', 'claude', capture);
    expect(vi.mocked(captureClaudeTranscriptTurn).mock.calls[0][1]).toBe(capture);
  });

  it('falls back to the scraper when the reader cannot be reached', async () => {
    // A throwing reader must not silence the only writer there is, and it must
    // not take the poller's save path down either — this runs inside it.
    vi.mocked(captureClaudeTranscriptTurn).mockRejectedValue(new Error('registry not ready'));
    expect(await captureStructuredHistoryTurn('wt-1', 'claude', 'claude', CAPTURE)).toBe(false);
  });
});
