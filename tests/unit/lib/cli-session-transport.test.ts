import { AsyncLocalStorage } from 'async_hooks';
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
  getCaptureGeneration: vi.fn(() => ({ global: 0, session: 0 })),
  isCaptureGenerationCurrent: vi.fn(() => true),
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
    // Issue #4304 F1-a (design §4.5 / §6.4 (iv)): no longer written back to the display cache.
    expect(setCachedCapture).not.toHaveBeenCalled();
  });

  it('[#3798] a fresh capture reports the time it started, not the time it came back — and writes nothing back (#4304)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const startedAt = 1_800_000_000_000;
      vi.setSystemTime(startedAt);
      let finish: (output: string) => void = () => {};
      mockTransport.captureSnapshot.mockReturnValueOnce(new Promise<string>((resolve) => (finish = resolve)));

      // What the observer's capture context (waiting-episode-binding) is told.
      const reported: unknown[] = [];
      globalThis.__captureFrameMetaSink ??= new AsyncLocalStorage();
      const pending = globalThis.__captureFrameMetaSink.run(
        (meta) => reported.push(meta),
        () => captureSessionOutputFresh('wt-1', 'claude', 500),
      );
      vi.setSystemTime(startedAt + 2_000);
      finish('slow output');
      await expect(pending).resolves.toBe('slow output');

      // Issue #4304 F1-a (design §4.5): the frame is not written back to the display cache.
      expect(setCachedCapture).not.toHaveBeenCalled();
      expect(reported).toEqual([{ fetchStartedAt: startedAt, source: 'fetched' }]);
    } finally {
      vi.useRealTimers();
    }
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
