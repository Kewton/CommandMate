/**
 * Unit tests for CLIToolManager.stopPollers()
 * Issue #4: T2.4 - Stop pollers method (MF1-001)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CLIToolManager } from '@/lib/cli-tools/manager';

// Mock response-poller
vi.mock('@/lib/response-poller', () => ({
  stopPolling: vi.fn(),
}));

describe('CLIToolManager.stopPollers (T2.4 - MF1-001)', () => {
  let manager: CLIToolManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = CLIToolManager.getInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should have stopPollers method', () => {
    expect(typeof manager.stopPollers).toBe('function');
  });

  it('should stop response-poller for any CLI tool', async () => {
    const { stopPolling } = await import('@/lib/response-poller');

    manager.stopPollers('test-worktree', 'codex');

    expect(stopPolling).toHaveBeenCalledWith('test-worktree', 'codex');
  });

});
