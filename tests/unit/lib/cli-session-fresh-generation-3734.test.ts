/**
 * Issue #3734: captureSessionOutputFresh() must not write its result back to
 * the capture cache when the session was invalidated while it was waiting.
 * Uses the real capture cache module (only tmux transport is mocked).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: () => ({
      debug: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('@/lib/tmux/polling-tmux-transport', () => ({
  getPollingTmuxTransport: vi.fn(),
}));

import { captureSessionOutputFresh } from '@/lib/session/cli-session';
import {
  getCachedCapture,
  invalidateCache,
  clearAllCache,
  resetCacheForTesting,
} from '@/lib/tmux/tmux-capture-cache';
import { getPollingTmuxTransport } from '@/lib/tmux/polling-tmux-transport';

const SESSION = 'mcbd-claude-wt-3734';

describe('captureSessionOutputFresh generation check (Issue #3734)', () => {
  const captureSnapshot = vi.fn<(name: string, opts: { startLine: number }) => Promise<string>>();

  beforeEach(() => {
    resetCacheForTesting();
    captureSnapshot.mockReset();
    vi.mocked(getPollingTmuxTransport).mockReturnValue(
      { captureSnapshot } as unknown as ReturnType<typeof getPollingTmuxTransport>
    );
  });

  afterEach(() => {
    resetCacheForTesting();
  });

  it('does not write back when the session is invalidated while waiting', async () => {
    let resolve!: (v: string) => void;
    captureSnapshot.mockImplementationOnce(() => new Promise<string>((r) => (resolve = r)));

    const p = captureSessionOutputFresh('wt-3734', 'claude', 500);
    invalidateCache(SESSION);
    resolve('screen before send');

    await expect(p).resolves.toBe('screen before send');
    expect(getCachedCapture(SESSION, 500)).toBeNull();
  });

  it('does not write back when clearAllCache runs while waiting', async () => {
    let resolve!: (v: string) => void;
    captureSnapshot.mockImplementationOnce(() => new Promise<string>((r) => (resolve = r)));

    const p = captureSessionOutputFresh('wt-3734', 'claude', 500);
    clearAllCache();
    resolve('screen before cleanup');

    await p;
    expect(getCachedCapture(SESSION, 500)).toBeNull();
  });

  it('negative control: without invalidation the fresh result is cached', async () => {
    captureSnapshot.mockResolvedValueOnce('fresh screen');

    await expect(captureSessionOutputFresh('wt-3734', 'claude', 500)).resolves.toBe('fresh screen');
    expect(getCachedCapture(SESSION, 500)).toBe('fresh screen');
  });
});
