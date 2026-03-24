/**
 * Session cleanup utility tests for Issue #404 changes
 * Issue #404: Verify call order and new function integration
 * Issue #525: Updated for byWorktree helper migration
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock response-poller
vi.mock('@/lib/polling/response-poller', () => ({
  stopPolling: vi.fn(),
}));

// Mock auto-yes-manager (Issue #525: byWorktree helpers)
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  stopAutoYesPollingByWorktree: vi.fn(),
  deleteAutoYesStateByWorktree: vi.fn().mockReturnValue(0),
}));

// Mock schedule-manager
vi.mock('@/lib/schedule-manager', () => ({
  stopScheduleForWorktree: vi.fn(),
  stopAllSchedules: vi.fn(),
}));

// Mock timer-manager (Issue #534)
vi.mock('@/lib/timer-manager', () => ({
  stopTimersForWorktree: vi.fn(),
}));

import { cleanupWorktreeSessions } from '@/lib/session-cleanup';
import { stopAutoYesPollingByWorktree, deleteAutoYesStateByWorktree } from '@/lib/polling/auto-yes-manager';
import { stopScheduleForWorktree, stopAllSchedules } from '@/lib/schedule-manager';

describe('Session Cleanup - Issue #404, #525 Changes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call stopAutoYesPollingByWorktree -> deleteAutoYesStateByWorktree -> stopScheduleForWorktree in order', async () => {
    const callOrder: string[] = [];

    vi.mocked(stopAutoYesPollingByWorktree).mockImplementation(() => {
      callOrder.push('stopAutoYesPollingByWorktree');
    });
    vi.mocked(deleteAutoYesStateByWorktree).mockImplementation(() => {
      callOrder.push('deleteAutoYesStateByWorktree');
      return 0;
    });
    vi.mocked(stopScheduleForWorktree).mockImplementation(() => {
      callOrder.push('stopScheduleForWorktree');
    });

    const killSessionFn = vi.fn().mockResolvedValue(true);
    await cleanupWorktreeSessions('wt-1', killSessionFn);

    // Verify all three functions were called
    expect(stopAutoYesPollingByWorktree).toHaveBeenCalledWith('wt-1');
    expect(deleteAutoYesStateByWorktree).toHaveBeenCalledWith('wt-1');
    expect(stopScheduleForWorktree).toHaveBeenCalledWith('wt-1');

    // Verify order
    const ayPollingIdx = callOrder.indexOf('stopAutoYesPollingByWorktree');
    const ayDeleteIdx = callOrder.indexOf('deleteAutoYesStateByWorktree');
    const schedIdx = callOrder.indexOf('stopScheduleForWorktree');

    expect(ayPollingIdx).toBeLessThan(ayDeleteIdx);
    expect(ayDeleteIdx).toBeLessThan(schedIdx);
  });

  it('should NOT call stopAllSchedules (regression test)', async () => {
    const killSessionFn = vi.fn().mockResolvedValue(true);
    await cleanupWorktreeSessions('wt-1', killSessionFn);

    expect(stopAllSchedules).not.toHaveBeenCalled();
  });

  it('should include deleteAutoYesStateByWorktree in pollersStopped on success', async () => {
    vi.mocked(deleteAutoYesStateByWorktree).mockReturnValue(0);
    const killSessionFn = vi.fn().mockResolvedValue(true);

    const result = await cleanupWorktreeSessions('wt-1', killSessionFn);

    expect(result.pollersStopped).toContain('auto-yes-state');
  });

  it('should include stopScheduleForWorktree in pollersStopped', async () => {
    const killSessionFn = vi.fn().mockResolvedValue(true);

    const result = await cleanupWorktreeSessions('wt-1', killSessionFn);

    expect(result.pollersStopped).toContain('schedule-manager');
  });

  it('should collect errors from deleteAutoYesStateByWorktree', async () => {
    vi.mocked(deleteAutoYesStateByWorktree).mockImplementation(() => {
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
