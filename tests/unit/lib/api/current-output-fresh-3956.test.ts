/**
 * `?fresh=1` on GET /api/worktrees/[id]/current-output (Issue #3956).
 *
 * `commandmate wait --fail-on-upstream-fault` re-reads the pane every 500 ms
 * after a `Stop`; the capture cache (TTL 5 s) would answer those reads with one
 * capture. With the parameter the route asks `buildCurrentOutput` for a fresh
 * capture (it drops the cache entry first; see
 * tests/unit/session/current-output-fresh-capture-3956.test.ts); without it
 * (every pane's 5-second poll) the call is the one it always was.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn(() => ({ id: 'wt-1', path: '/work/wt-1' })) }));
vi.mock('@/lib/security/path-validator', () => ({ isValidWorktreeId: vi.fn(() => true) }));
vi.mock('@/lib/git/git-route-worktree', () => ({ canonicalWorktreeId: (id: string) => id }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/cli-tools/session-ownership', () => ({
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'own' })),
  foreignSessionErrorBody: vi.fn(),
}));
vi.mock('@/lib/session/resolve-session-target', () => ({
  resolveSessionTarget: vi.fn(() => ({
    cliToolId: 'codex',
    instanceId: undefined,
    resolvedBy: 'worktree-default',
    conflict: null,
  })),
}));
vi.mock('@/lib/detection/version-probes', () => ({
  getDetectorStalenessSnapshot: () => undefined,
}));

vi.mock('@/lib/session/current-output-builder', () => ({
  buildCurrentOutput: vi.fn(async () => {
    return {
      isRunning: true,
      cliToolId: 'codex',
      sessionStatus: 'ready',
      content: 'frame',
      fullOutput: 'frame',
      isPromptWaiting: false,
      promptData: null,
    };
  }),
}));

import { GET } from '@/app/api/worktrees/[id]/current-output/route';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';

const params = { params: Promise.resolve({ id: 'wt-1' }) };
const request = (query = '') =>
  new NextRequest(`http://localhost:3000/api/worktrees/wt-1/current-output${query}`);

beforeEach(() => {
  vi.clearAllMocks();
});

const resolution = { resolvedBy: 'worktree-default', conflict: null };

describe('[#3956] GET /current-output?fresh=1', () => {
  it('asks the builder for a fresh capture', async () => {
    const res = await GET(request('?observe=1&fresh=1'), params);
    expect(res.status).toBe(200);
    expect(buildCurrentOutput).toHaveBeenCalledWith({}, 'wt-1', 'codex', undefined, resolution, {
      freshCapture: true,
    });
  });

  it('negative: without the parameter the call is unchanged (cache allowed)', async () => {
    const res = await GET(request('?observe=1'), params);
    expect(res.status).toBe(200);
    expect(buildCurrentOutput).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildCurrentOutput).mock.calls[0]).toHaveLength(5);
  });

  it('negative: a value other than 1 is not the parameter', async () => {
    await GET(request('?fresh=0'), params);
    expect(vi.mocked(buildCurrentOutput).mock.calls[0]).toHaveLength(5);
  });
});
