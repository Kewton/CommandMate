import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (id: string) => ({
        id,
        name: id === 'claude' ? 'Claude CLI' : id,
        getSessionName: (worktreeId: string) => `mcbd-${id}-${worktreeId}`,
      }),
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    withContext: () => ({
      debug: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  getOrFetchCapture: vi.fn(),
  setCachedCapture: vi.fn(),
  invalidateCache: vi.fn(),
  sliceOutput: vi.fn((output: string) => output),
  CACHE_MAX_CAPTURE_LINES: 10000,
}));

vi.mock('@/lib/tmux/polling-tmux-transport', () => ({
  getPollingTmuxTransport: vi.fn(),
}));

import {
  captureSessionOutput,
  captureSessionOutputFresh,
  getSessionName,
  isSessionRunning,
} from '@/lib/session/cli-session';
import { getOrFetchCapture, invalidateCache, setCachedCapture } from '@/lib/tmux/tmux-capture-cache';
import { getPollingTmuxTransport } from '@/lib/tmux/polling-tmux-transport';

describe('cli-session transport integration', () => {
  const mockTransport = {
    ensureSession: vi.fn(),
    sessionExists: vi.fn(),
    sendInput: vi.fn(),
    sendSpecialKey: vi.fn(),
    resize: vi.fn(),
    captureSnapshot: vi.fn(),
    subscribe: vi.fn(),
    getCapabilities: vi.fn(),
    killSession: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPollingTmuxTransport).mockReturnValue(
      mockTransport as unknown as ReturnType<typeof getPollingTmuxTransport>
    );
  });

  it('should use the polling transport to check session existence', async () => {
    mockTransport.sessionExists.mockResolvedValueOnce(true);

    await expect(isSessionRunning('wt-1', 'claude')).resolves.toBe(true);
    expect(mockTransport.sessionExists).toHaveBeenCalledWith('mcbd-claude-wt-1');
  });

  it('should use the polling transport to capture session output', async () => {
    mockTransport.sessionExists.mockResolvedValueOnce(true);
    mockTransport.captureSnapshot.mockResolvedValueOnce('captured output');
    vi.mocked(getOrFetchCapture).mockImplementationOnce(async (_sessionName, _lines, fetchFn) => fetchFn());

    await expect(captureSessionOutput('wt-1', 'claude', 200)).resolves.toBe('captured output');
    expect(mockTransport.captureSnapshot).toHaveBeenCalledWith('mcbd-claude-wt-1', { startLine: -10000 });
  });

  it('should preserve the missing session error path', async () => {
    mockTransport.sessionExists.mockResolvedValueOnce(false);
    vi.mocked(getOrFetchCapture).mockImplementationOnce(async (_sessionName, _lines, fetchFn) => fetchFn());

    await expect(captureSessionOutput('wt-1', 'claude', 200)).rejects.toThrow(
      'Claude CLI session mcbd-claude-wt-1 does not exist'
    );
  });

  it('should use the polling transport for fresh captures', async () => {
    mockTransport.captureSnapshot.mockResolvedValueOnce('fresh output');

    await expect(captureSessionOutputFresh('wt-1', 'claude', 500)).resolves.toBe('fresh output');
    expect(mockTransport.captureSnapshot).toHaveBeenCalledWith('mcbd-claude-wt-1', { startLine: -500 });
    expect(setCachedCapture).toHaveBeenCalledWith('mcbd-claude-wt-1', 'fresh output', 500);
  });

  it('should invalidate cache when fresh capture fails', async () => {
    mockTransport.captureSnapshot.mockRejectedValueOnce(new Error('tmux failed'));

    await expect(captureSessionOutputFresh('wt-1', 'claude', 500)).rejects.toThrow(
      'Failed to capture Claude CLI output: tmux failed'
    );
    expect(invalidateCache).toHaveBeenCalledWith('mcbd-claude-wt-1');
  });

  it('should keep getSessionName behavior unchanged', () => {
    expect(getSessionName('wt-1', 'claude')).toBe('mcbd-claude-wt-1');
  });
});
