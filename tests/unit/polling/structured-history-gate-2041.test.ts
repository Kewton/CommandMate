/**
 * When the screen scraper stands down (Issue #2041).
 *
 * The half of "port 接続中は scrape を止める" that is checkable without a live
 * server. The predicate has to be wrong in only one direction: standing down
 * when nobody else is writing loses a reply, while failing to stand down
 * duplicates one — so every state that is not positively `live` must answer
 * false.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/sources/opencode/subscription', () => ({
  isOpencodeStructuredHistoryLive: vi.fn(),
}));

import { isOpencodeStructuredHistoryLive } from '@/lib/hooks/sources/opencode/subscription';
import { isStructuredHistoryWriterLive } from '@/lib/polling/structured-history-gate';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isOpencodeStructuredHistoryLive).mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isStructuredHistoryWriterLive', () => {
  it('is true only when opencode has a live subscription', () => {
    vi.mocked(isOpencodeStructuredHistoryLive).mockReturnValue(true);
    expect(isStructuredHistoryWriterLive('wt-1', 'opencode', 'opencode')).toBe(true);
  });

  it('is false when the opencode subscription is not live', () => {
    vi.mocked(isOpencodeStructuredHistoryLive).mockReturnValue(false);
    expect(isStructuredHistoryWriterLive('wt-1', 'opencode', 'opencode')).toBe(false);
  });

  it.each(['claude', 'codex', 'gemini', 'copilot', 'antigravity'] as const)(
    'never asks about %s, which has no server to ask',
    (cliToolId) => {
      // The tool check is first on purpose: the other five have no port, so a
      // liveness answer for them could only ever come from a stale map entry.
      // Three of the five now declare `transcriptHistory: 'pull'` (#2121/#2197/
      // #2198), which is why this stays a list of five rather than shrinking:
      // `'pull'` is not `'push'`, and a pull tool must never be asked about a
      // subscription it does not have.
      vi.mocked(isOpencodeStructuredHistoryLive).mockReturnValue(true);
      expect(isStructuredHistoryWriterLive('wt-1', cliToolId)).toBe(false);
      expect(vi.mocked(isOpencodeStructuredHistoryLive)).not.toHaveBeenCalled();
    }
  );

  it('defaults the instance to the primary, as every other keyed lookup does', () => {
    isStructuredHistoryWriterLive('wt-1', 'opencode');
    expect(vi.mocked(isOpencodeStructuredHistoryLive)).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      cliToolId: 'opencode',
      instanceId: 'opencode',
    });
  });

  it('carries a named instance through unchanged', () => {
    isStructuredHistoryWriterLive('wt-1', 'opencode', 'opencode-3');
    expect(vi.mocked(isOpencodeStructuredHistoryLive)).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      cliToolId: 'opencode',
      instanceId: 'opencode-3',
    });
  });

  it('falls back to the scraper when the source cannot be asked', () => {
    // A throwing source must not silence the only writer there is. The safe
    // direction is a duplicated reply, never a lost one.
    vi.mocked(isOpencodeStructuredHistoryLive).mockImplementation(() => {
      throw new Error('registry not ready');
    });
    expect(isStructuredHistoryWriterLive('wt-1', 'opencode')).toBe(false);
  });
});
