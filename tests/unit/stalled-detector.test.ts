/**
 * Unit tests for stalled-detector
 * Issue #600: UX refresh - isWorktreeStalled() threshold boundary tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { STALLED_THRESHOLD_MS } from '@/config/review-config';

// Mock auto-yes-manager before importing stalled-detector
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getLastServerResponseTimestamp: vi.fn(),
  buildCompositeKey: vi.fn((worktreeId: string, cliToolId: string) => `${worktreeId}:${cliToolId}`),
}));

import { isWorktreeStalled } from '@/lib/detection/stalled-detector';
import { getLastServerResponseTimestamp } from '@/lib/polling/auto-yes-manager';

const mockGetTimestamp = vi.mocked(getLastServerResponseTimestamp);

describe('isWorktreeStalled()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return false when no timestamp exists (no auto-yes poller active)', () => {
    mockGetTimestamp.mockReturnValue(null);
    expect(isWorktreeStalled('wt-1', 'claude')).toBe(false);
  });

  it('should return false when elapsed time is below threshold', () => {
    const now = 1000000;
    const recentTimestamp = now - (STALLED_THRESHOLD_MS - 1);
    mockGetTimestamp.mockReturnValue(recentTimestamp);
    expect(isWorktreeStalled('wt-1', 'claude', now)).toBe(false);
  });

  it('should return true when elapsed time equals threshold (boundary)', () => {
    const now = 1000000;
    const exactThresholdTimestamp = now - STALLED_THRESHOLD_MS;
    mockGetTimestamp.mockReturnValue(exactThresholdTimestamp);
    expect(isWorktreeStalled('wt-1', 'claude', now)).toBe(true);
  });

  it('should return true when elapsed time exceeds threshold', () => {
    const now = 1000000;
    const oldTimestamp = now - (STALLED_THRESHOLD_MS + 60000);
    mockGetTimestamp.mockReturnValue(oldTimestamp);
    expect(isWorktreeStalled('wt-1', 'claude', now)).toBe(true);
  });

  it('should use correct composite key', () => {
    mockGetTimestamp.mockReturnValue(null);
    isWorktreeStalled('my-worktree', 'codex');
    expect(mockGetTimestamp).toHaveBeenCalledWith('my-worktree:codex');
  });

  it('should work with different CLI tool types', () => {
    const now = 1000000;
    const oldTimestamp = now - (STALLED_THRESHOLD_MS + 1);
    mockGetTimestamp.mockReturnValue(oldTimestamp);

    expect(isWorktreeStalled('wt-1', 'claude', now)).toBe(true);
    expect(isWorktreeStalled('wt-1', 'codex', now)).toBe(true);
    expect(isWorktreeStalled('wt-1', 'gemini', now)).toBe(true);
    expect(isWorktreeStalled('wt-1', 'opencode', now)).toBe(true);
    expect(isWorktreeStalled('wt-1', 'copilot', now)).toBe(true);
    expect(isWorktreeStalled('wt-1', 'vibe-local', now)).toBe(true);
  });

  it('should return false when timestamp is very recent (1ms ago)', () => {
    const now = 1000000;
    mockGetTimestamp.mockReturnValue(now - 1);
    expect(isWorktreeStalled('wt-1', 'claude', now)).toBe(false);
  });

  it('should return false when timestamp equals now', () => {
    const now = 1000000;
    mockGetTimestamp.mockReturnValue(now);
    expect(isWorktreeStalled('wt-1', 'claude', now)).toBe(false);
  });

  it('should verify STALLED_THRESHOLD_MS is 300000 (5 minutes)', () => {
    expect(STALLED_THRESHOLD_MS).toBe(300_000);
  });
});
