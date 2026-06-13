/**
 * Tests for worktree-status-helper.ts
 *
 * Issue #501: Verify that detectSessionStatus() receives lastOutputTimestamp
 * from getLastServerResponseTimestamp() when auto-yes is active.
 *
 * Issue #875: Verify per-instance status detection (sessionStatusByInstance),
 * alias-instance detection, and the per-CLI aggregate folding alias activity in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CLIToolType, AgentInstance } from '@/lib/cli-tools/types';

// Mock all dependencies. getSessionName honors instanceId so alias instances
// (instanceId !== cliToolId) map to a distinct session name (Issue #875).
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        getSessionName: (worktreeId: string, instanceId?: string) =>
          instanceId && instanceId !== cliToolId
            ? `${cliToolId}-${worktreeId}-${instanceId}`
            : `${cliToolId}-${worktreeId}`,
        name: cliToolId,
      }),
    }),
  },
}));

vi.mock('@/lib/cli-tools/types', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/cli-tools/types')>();
  return {
    ...original,
    CLI_TOOL_IDS: ['claude', 'gemini'] as readonly CLIToolType[],
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

vi.mock('@/lib/cli-tools/gemini', () => ({
  GEMINI_PANE_HEIGHT: 200,
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
  const mockGetAgentInstances = vi.fn(() => [] as AgentInstance[]);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMessages.mockReturnValue([]);
    mockGetAgentInstances.mockReturnValue([]);
  });

  it('should pass lastOutputTimestamp as Date to detectSessionStatus when timestamp exists', async () => {
    const timestamp = 1700000000000;
    vi.mocked(getLastServerResponseTimestamp).mockReturnValue(timestamp);

    const sessionNameSet = new Set(['claude-wt-1']);
    await detectWorktreeSessionStatus('wt-1', sessionNameSet, mockDb, mockGetMessages, mockMarkPending, mockGetAgentInstances);

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
    await detectWorktreeSessionStatus('wt-2', sessionNameSet, mockDb, mockGetMessages, mockMarkPending, mockGetAgentInstances);

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
    const result = await detectWorktreeSessionStatus('wt-3', sessionNameSet, mockDb, mockGetMessages, mockMarkPending, mockGetAgentInstances);

    // detectSessionStatus should not be called when session is not running
    expect(detectSessionStatus).not.toHaveBeenCalled();
    expect(result.isSessionRunning).toBe(false);
  });

  it('should capture the full Gemini pane height for status detection', async () => {
    vi.mocked(getLastServerResponseTimestamp).mockReturnValue(null);

    const sessionNameSet = new Set(['gemini-wt-4']);
    await detectWorktreeSessionStatus('wt-4', sessionNameSet, mockDb, mockGetMessages, mockMarkPending, mockGetAgentInstances);

    const { captureSessionOutput } = await import('@/lib/session/cli-session');
    // Issue #875: primary instances pass instanceId === cliToolId.
    expect(captureSessionOutput).toHaveBeenCalledWith('wt-4', 'gemini', 200, 'gemini');
  });
});

describe('worktree-status-helper per-instance detection (Issue #875)', () => {
  const mockDb = {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>;
  const mockGetMessages = vi.fn().mockReturnValue([]);
  const mockMarkPending = vi.fn();
  const mockGetAgentInstances = vi.fn(() => [] as AgentInstance[]);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMessages.mockReturnValue([]);
    mockGetAgentInstances.mockReturnValue([]);
    vi.mocked(getLastServerResponseTimestamp).mockReturnValue(null);
  });

  it('keys primary instances in sessionStatusByInstance by their cliToolId', async () => {
    const sessionNameSet = new Set(['claude-wt-p']);
    const result = await detectWorktreeSessionStatus(
      'wt-p', sessionNameSet, mockDb, mockGetMessages, mockMarkPending, mockGetAgentInstances
    );

    expect(result.sessionStatusByInstance.claude?.isRunning).toBe(true);
    expect(result.sessionStatusByInstance.gemini?.isRunning).toBe(false);
    // Primary status mirrors the per-CLI map for backward compat.
    expect(result.sessionStatusByCli.claude?.isRunning).toBe(true);
  });

  it('detects an alias instance session and keys it by instanceId', async () => {
    mockGetAgentInstances.mockReturnValue([
      { id: 'claude-2', cliTool: 'claude', alias: 'photon', order: 1 },
    ]);
    // Only the alias session is running; the primary claude session is NOT.
    const sessionNameSet = new Set(['claude-wt-a-claude-2']);

    const result = await detectWorktreeSessionStatus(
      'wt-a', sessionNameSet, mockDb, mockGetMessages, mockMarkPending, mockGetAgentInstances
    );

    // Alias instance is detected independently of the primary.
    expect(result.sessionStatusByInstance['claude-2']?.isRunning).toBe(true);
    expect(result.sessionStatusByInstance.claude?.isRunning).toBe(false);
    // Per-CLI aggregate folds the alias activity in (sidebar #867 correctness).
    expect(result.sessionStatusByCli.claude?.isRunning).toBe(true);
    // Worktree-level flag reflects an alias-only running session.
    expect(result.isSessionRunning).toBe(true);
  });

  it('reports independent statuses for two instances of the same CLI tool', async () => {
    mockGetAgentInstances.mockReturnValue([
      { id: 'claude-2', cliTool: 'claude', alias: 'photon', order: 1 },
    ]);
    // Primary running, alias not running.
    const sessionNameSet = new Set(['claude-wt-b']);

    const result = await detectWorktreeSessionStatus(
      'wt-b', sessionNameSet, mockDb, mockGetMessages, mockMarkPending, mockGetAgentInstances
    );

    expect(result.sessionStatusByInstance.claude?.isRunning).toBe(true);
    expect(result.sessionStatusByInstance['claude-2']?.isRunning).toBe(false);
  });

  it('captures alias output scoped to the alias instanceId', async () => {
    mockGetAgentInstances.mockReturnValue([
      { id: 'claude-2', cliTool: 'claude', alias: 'photon', order: 1 },
    ]);
    const sessionNameSet = new Set(['claude-wt-c-claude-2']);

    await detectWorktreeSessionStatus(
      'wt-c', sessionNameSet, mockDb, mockGetMessages, mockMarkPending, mockGetAgentInstances
    );

    const { captureSessionOutput } = await import('@/lib/session/cli-session');
    expect(captureSessionOutput).toHaveBeenCalledWith('wt-c', 'claude', expect.any(Number), 'claude-2');
  });
});
