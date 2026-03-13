/**
 * Session cleanup utility tests for Issue #404 changes
 * Issue #404: Verify call order and new function integration
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock response-poller
vi.mock('@/lib/polling/response-poller', () => ({
  stopPolling: vi.fn(),
}));

// Mock auto-yes-manager
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  stopAutoYesPolling: vi.fn(),
  deleteAutoYesState: vi.fn().mockReturnValue(true),
}));

// Mock schedule-manager
vi.mock('@/lib/schedule-manager', () => ({
  stopScheduleForWorktree: vi.fn(),
  stopAllSchedules: vi.fn(),
}));

import { cleanupWorktreeSessions } from '@/lib/session-cleanup';
import { stopAutoYesPolling, deleteAutoYesState } from '@/lib/polling/auto-yes-manager';
import { stopScheduleForWorktree, stopAllSchedules } from '@/lib/schedule-manager';

describe('Session Cleanup - Issue #404 Changes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call stopAutoYesPolling -> deleteAutoYesState -> stopScheduleForWorktree in order', async () => {
    const callOrder: string[] = [];

    vi.mocked(stopAutoYesPolling).mockImplementation(() => {
      callOrder.push('stopAutoYesPolling');
    });
    vi.mocked(deleteAutoYesState).mockImplementation(() => {
      callOrder.push('deleteAutoYesState');
      return true;
    });
    vi.mocked(stopScheduleForWorktree).mockImplementation(() => {
      callOrder.push('stopScheduleForWorktree');
    });

    const killSessionFn = vi.fn().mockResolvedValue(true);
    await cleanupWorktreeSessions('wt-1', killSessionFn);

    // Verify all three functions were called
    expect(stopAutoYesPolling).toHaveBeenCalledWith('wt-1');
    expect(deleteAutoYesState).toHaveBeenCalledWith('wt-1');
    expect(stopScheduleForWorktree).toHaveBeenCalledWith('wt-1');

    // Verify order: stopAutoYesPolling first, then deleteAutoYesState, then stopScheduleForWorktree
    const ayPollingIdx = callOrder.indexOf('stopAutoYesPolling');
    const ayDeleteIdx = callOrder.indexOf('deleteAutoYesState');
    const schedIdx = callOrder.indexOf('stopScheduleForWorktree');

    expect(ayPollingIdx).toBeLessThan(ayDeleteIdx);
    expect(ayDeleteIdx).toBeLessThan(schedIdx);
  });

  it('should NOT call stopAllSchedules (regression test)', async () => {
    const killSessionFn = vi.fn().mockResolvedValue(true);
    await cleanupWorktreeSessions('wt-1', killSessionFn);

    expect(stopAllSchedules).not.toHaveBeenCalled();
  });

  it('should include deleteAutoYesState in pollersStopped on success', async () => {
    vi.mocked(deleteAutoYesState).mockReturnValue(true);
    const killSessionFn = vi.fn().mockResolvedValue(true);

    const result = await cleanupWorktreeSessions('wt-1', killSessionFn);

    expect(result.pollersStopped).toContain('auto-yes-state');
  });

  it('should include stopScheduleForWorktree in pollersStopped', async () => {
    const killSessionFn = vi.fn().mockResolvedValue(true);

    const result = await cleanupWorktreeSessions('wt-1', killSessionFn);

    expect(result.pollersStopped).toContain('schedule-manager');
  });

  it('should collect errors from deleteAutoYesState', async () => {
    vi.mocked(deleteAutoYesState).mockImplementation(() => {
      throw new Error('Delete state failed');
    });
    const killSessionFn = vi.fn().mockResolvedValue(true);

    const result = await cleanupWorktreeSessions('wt-1', killSessionFn);

    expect(result.pollerErrors.some(e => e.includes('auto-yes-state'))).toBe(true);
  });

  it('should collect errors from stopScheduleForWorktree', async () => {
    vi.mocked(stopScheduleForWorktree).mockImplementation(() => {
      throw new Error('Schedule stop failed');
    });
    const killSessionFn = vi.fn().mockResolvedValue(true);

    const result = await cleanupWorktreeSessions('wt-1', killSessionFn);

    expect(result.pollerErrors.some(e => e.includes('schedule-manager'))).toBe(true);
  });
});
