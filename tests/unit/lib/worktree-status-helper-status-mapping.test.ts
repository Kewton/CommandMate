/**
 * Issue #1550: pin the SessionStatus → boolean-triple conversion performed by
 * detectWorktreeSessionStatus().
 *
 * The pre-existing worktree-status-helper.test.ts always mocks the detector as
 * `status: 'ready'`, so the `running` / `waiting` branches of that conversion
 * were never exercised — exactly the lines this refactor moved into
 * `status-mapping.ts`. These cases drive every SessionStatus through the helper
 * and assert the flags it produces.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CLIToolType, AgentInstance } from '@/lib/cli-tools/types';
import type { SessionStatus } from '@/lib/detection/status-detector';

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
    CLI_TOOL_IDS: ['claude'] as readonly CLIToolType[],
  };
});

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue('$ '),
}));

vi.mock('@/lib/detection/status-detector', () => ({
  detectSessionStatus: vi.fn(),
}));

vi.mock('@/lib/session/claude-session', () => ({
  isSessionHealthy: vi.fn().mockResolvedValue({ healthy: true }),
}));

vi.mock('@/lib/cli-tools/opencode', () => ({ OPENCODE_PANE_HEIGHT: 200 }));
vi.mock('@/lib/cli-tools/gemini', () => ({ GEMINI_PANE_HEIGHT: 200 }));

vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getLastServerResponseTimestamp: vi.fn().mockReturnValue(null),
  buildCompositeKey: vi.fn((worktreeId: string, cliToolId: string) => `${worktreeId}:${cliToolId}`),
}));

import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import { detectSessionStatus } from '@/lib/detection/status-detector';

const mockDb = {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>;
const mockGetMessages = vi.fn().mockReturnValue([]);
const mockMarkPending = vi.fn();
const mockGetAgentInstances = vi.fn(() => [] as AgentInstance[]);

function mockDetectedStatus(status: SessionStatus, hasActivePrompt = false): void {
  vi.mocked(detectSessionStatus).mockReturnValue({
    status,
    confidence: 'high',
    reason: 'input_prompt',
    hasActivePrompt,
    promptDetection: { isPrompt: hasActivePrompt, cleanContent: '' },
  });
}

async function detectWithRunningSession(status: SessionStatus) {
  mockDetectedStatus(status);
  const result = await detectWorktreeSessionStatus(
    'wt-1',
    new Set(['claude-wt-1']),
    mockDb,
    mockGetMessages,
    mockMarkPending,
    mockGetAgentInstances
  );
  return result.sessionStatusByCli.claude;
}

describe('detectWorktreeSessionStatus SessionStatus → flags (Issue #1550)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMessages.mockReturnValue([]);
    mockGetAgentInstances.mockReturnValue([]);
  });

  const TABLE: ReadonlyArray<[SessionStatus, boolean, boolean]> = [
    // status, isWaitingForResponse, isProcessing
    ['idle', false, false],
    ['ready', false, false],
    ['running', false, true],
    ['waiting', true, false],
  ];

  it.each(TABLE)(
    'detector %s → isWaitingForResponse=%s isProcessing=%s',
    async (status, isWaitingForResponse, isProcessing) => {
      const flags = await detectWithRunningSession(status);
      expect(flags).toEqual({ isRunning: true, isWaitingForResponse, isProcessing });
    }
  );

  it('propagates the flags to the worktree-level aggregate', async () => {
    mockDetectedStatus('waiting');
    const result = await detectWorktreeSessionStatus(
      'wt-1',
      new Set(['claude-wt-1']),
      mockDb,
      mockGetMessages,
      mockMarkPending,
      mockGetAgentInstances
    );
    expect(result.isSessionRunning).toBe(true);
    expect(result.isWaitingForResponse).toBe(true);
    expect(result.isProcessing).toBe(false);
  });

  it('leaves both activity flags false when no session is running', async () => {
    mockDetectedStatus('running');
    const result = await detectWorktreeSessionStatus(
      'wt-1',
      new Set(),
      mockDb,
      mockGetMessages,
      mockMarkPending,
      mockGetAgentInstances
    );
    // The detector is never consulted when the tmux session is absent.
    expect(detectSessionStatus).not.toHaveBeenCalled();
    expect(result.sessionStatusByCli.claude).toEqual({
      isRunning: false,
      isWaitingForResponse: false,
      isProcessing: false,
    });
  });

  it('records a wrong expectation as a failure (guards against a vacuous table)', async () => {
    const flags = await detectWithRunningSession('running');
    expect(() => expect(flags?.isProcessing).toBe(false)).toThrow();
  });
});
