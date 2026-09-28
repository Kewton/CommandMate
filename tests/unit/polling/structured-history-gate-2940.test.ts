/**
 * The scraper stands down for OpenCode V2 while its subscription writes History
 * (Issue #2940).
 *
 * The "no second row" half of the Issue: OpenCode V2 now declares
 * `transcriptHistory: 'push'`, and the gate asks its own subscription — never
 * v1's — whether the writer is live.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/sources/opencode/subscription', () => ({
  isOpencodeStructuredHistoryLive: vi.fn(),
}));
vi.mock('@/lib/hooks/sources/opencode-v2/subscription', () => ({
  isOpencodeV2StructuredHistoryLive: vi.fn(),
}));

import { isOpencodeStructuredHistoryLive } from '@/lib/hooks/sources/opencode/subscription';
import { isOpencodeV2StructuredHistoryLive } from '@/lib/hooks/sources/opencode-v2/subscription';
import {
  captureStructuredHistoryTurn,
  isStructuredHistoryWriterLive,
  type StructuredHistoryCaptureReport,
} from '@/lib/polling/structured-history-gate';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isOpencodeStructuredHistoryLive).mockReturnValue(false);
  vi.mocked(isOpencodeV2StructuredHistoryLive).mockReturnValue(false);
});

describe('isStructuredHistoryWriterLive for opencode-v2 (Issue #2940)', () => {
  it('is true while the v2 subscription is live, asking v2 with the instance', () => {
    vi.mocked(isOpencodeV2StructuredHistoryLive).mockReturnValue(true);
    expect(isStructuredHistoryWriterLive('wt-1', 'opencode-v2', 'opencode-v2-2')).toBe(true);
    expect(vi.mocked(isOpencodeV2StructuredHistoryLive)).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      cliToolId: 'opencode-v2',
      instanceId: 'opencode-v2-2',
    });
    expect(vi.mocked(isOpencodeStructuredHistoryLive)).not.toHaveBeenCalled();
  });

  it('is false when it is not live, so the scraper keeps the turn', () => {
    expect(isStructuredHistoryWriterLive('wt-1', 'opencode-v2')).toBe(false);
  });

  it('is false when the probe throws', () => {
    vi.mocked(isOpencodeV2StructuredHistoryLive).mockImplementation(() => {
      throw new Error('boom');
    });
    expect(isStructuredHistoryWriterLive('wt-1', 'opencode-v2')).toBe(false);
  });

  it('a live v1 subscription says nothing about v2, and the reverse', () => {
    vi.mocked(isOpencodeStructuredHistoryLive).mockReturnValue(true);
    expect(isStructuredHistoryWriterLive('wt-1', 'opencode-v2')).toBe(false);
    vi.mocked(isOpencodeStructuredHistoryLive).mockReturnValue(false);
    vi.mocked(isOpencodeV2StructuredHistoryLive).mockReturnValue(true);
    expect(isStructuredHistoryWriterLive('wt-1', 'opencode')).toBe(false);
  });

  it('is not a pull reader, so the poller never asks it to capture', async () => {
    const report: StructuredHistoryCaptureReport = {};
    await expect(
      captureStructuredHistoryTurn(
        'wt-1',
        'opencode-v2',
        undefined,
        { worktreePath: '/tmp/x', transcriptPathHint: null },
        report
      )
    ).resolves.toBe(false);
    expect(report.outcome).toBe('unavailable');
  });
});
