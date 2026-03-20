/**
 * Tests for worktree-status-helper.ts
 *
 * Issue #501: Verify that detectSessionStatus() receives lastOutputTimestamp
 * from getLastServerResponseTimestamp() when auto-yes is active.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CLIToolType } from '@/lib/cli-tools/types';

// Mock all dependencies
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        getSessionName: (worktreeId: string) => `${cliToolId}-${worktreeId}`,
        name: cliToolId,
      }),
    }),
  },
}));

vi.mock('@/lib/cli-tools/types', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/cli-tools/types')>();
  return {
    ...original,
    CLI_TOOL_IDS: ['claude'] as readonly CLIToolType[],
  };
});

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue('$ '),
}));

vi.mock('@/lib/detection/status-detector', () => ({
  detectSessionStatus: vi.fn().mockReturnValue({
    status: 'ready',
    confidence: 'high',
    reason: 'input_prompt',
    hasActivePrompt: false,
    promptDetection: { isPrompt: false, cleanContent: '' },
  }),
}));

vi.mock('@/lib/session/claude-session', () => ({
  isSessionHealthy: vi.fn().mockResolvedValue({ healthy: true }),
}));

vi.mock('@/lib/cli-tools/opencode', () => ({
  OPENCODE_PANE_HEIGHT: 200,
}));

vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getLastServerResponseTimestamp: vi.fn().mockReturnValue(null),
  buildCompositeKey: vi.fn().mockImplementation((worktreeId: string, cliToolId: string) => `${worktreeId}:${cliToolId}`),
}));

import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { getLastServerResponseTimestamp } from '@/lib/polling/auto-yes-manager';

describe('worktree-status-helper (Issue #501)', () => {
  const mockDb = {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>;
  const mockGetMessages = vi.fn().mockReturnValue([]);
  const mockMarkPending = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should pass lastOutputTimestamp as Date to detectSessionStatus when timestamp exists', async () => {
    const timestamp = 1700000000000;
    vi.mocked(getLastServerResponseTimestamp).mockReturnValue(timestamp);

    const sessionNameSet = new Set(['claude-wt-1']);
    await detectWorktreeSessionStatus('wt-1', sessionNameSet, mockDb, mockGetMessages, mockMarkPending);

    expect(detectSessionStatus).toHaveBeenCalledWith(
      expect.any(String),
      'claude',
      expect.any(Date)
    );

    // Verify the Date object has the correct timestamp
    const callArgs = vi.mocked(detectSessionStatus).mock.calls[0];
    const passedDate = callArgs[2] as Date;
    expect(passedDate.getTime()).toBe(timestamp);
  });

  it('should pass undefined as lastOutputTimestamp when getLastServerResponseTimestamp returns null', async () => {
    vi.mocked(getLastServerResponseTimestamp).mockReturnValue(null);

    const sessionNameSet = new Set(['claude-wt-2']);
    await detectWorktreeSessionStatus('wt-2', sessionNameSet, mockDb, mockGetMessages, mockMarkPending);

    expect(detectSessionStatus).toHaveBeenCalledWith(
      expect.any(String),
      'claude',
      undefined
    );
  });

  it('should not change behavior for worktrees without running sessions', async () => {
    vi.mocked(getLastServerResponseTimestamp).mockReturnValue(null);

    // No session running (empty set)
    const sessionNameSet = new Set<string>();
    const result = await detectWorktreeSessionStatus('wt-3', sessionNameSet, mockDb, mockGetMessages, mockMarkPending);

    // detectSessionStatus should not be called when session is not running
    expect(detectSessionStatus).not.toHaveBeenCalled();
    expect(result.isSessionRunning).toBe(false);
  });
});
