/**
 * Issue #3956: `buildCurrentOutput(..., { freshCapture: true })` drops the
 * session's capture-cache entry before it captures, so `/current-output?fresh=1`
 * reads the pane rather than a capture up to 5 s old (the WS streamer's
 * `captureFreshPayload` does the same). Without the option the cache is left
 * alone: that is every pane's 5-second poll.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

const order: string[] = [];
const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>(async () => {
  order.push('capture');
  return '› \n';
});
const invalidateCache = vi.fn((name: string) => {
  order.push(`invalidate:${name}`);
});

vi.mock('@/lib/db', () => ({
  getSessionState: vi.fn(() => ({ lastCapturedLine: 0 })),
  createMessage: vi.fn(() => ({ id: 'msg-1' })),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({
        getSessionName: (worktreeId: string, instanceId?: string) =>
          `mcbd-codex-${worktreeId}${instanceId ? `-${instanceId}` : ''}`,
        isRunning: vi.fn().mockResolvedValue(true),
      }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/tmux/tmux-capture-cache')>();
  return { ...original, invalidateCache: (name: string) => invalidateCache(name) };
});
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: (worktreeId: string, cliToolId: string, instanceId?: string) =>
    !instanceId || instanceId === cliToolId
      ? `${worktreeId}:${cliToolId}`
      : `${worktreeId}:${cliToolId}:${instanceId}`,
}));

import { buildCurrentOutput } from '@/lib/session/current-output-builder';

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
});

describe('buildCurrentOutput freshCapture (Issue #3956)', () => {
  it('drops the cache entry of this session before it captures', async () => {
    await buildCurrentOutput({} as Database.Database, 'wt-3956', 'codex', 'codex-2', undefined, {
      freshCapture: true,
    });
    expect(invalidateCache).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('invalidate:mcbd-codex-wt-3956-codex-2');
    expect(order.indexOf('capture')).toBeGreaterThan(0);
  });

  it('negative: without the option the cache is left alone', async () => {
    await buildCurrentOutput({} as Database.Database, 'wt-3956', 'codex', 'codex-2');
    expect(invalidateCache).not.toHaveBeenCalled();
    expect(order).toContain('capture');
  });
});
