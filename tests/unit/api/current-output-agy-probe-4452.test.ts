/**
 * Issue #4452: the pane poll `GET /api/worktrees/[id]/current-output` starts `agy`
 * 0 times without the usage declaration, however often it is polled.
 *
 * Every worktree pane polls this route every 5 seconds whatever its tool is, and
 * the route attaches the detector snapshot, which on a cold cache probes every tool
 * of `DETECTOR_VERSION_PROBES` in the background. The probe module is REAL here;
 * only the DB, the session target, the pane capture and the ownership check are
 * stubbed. The probes run against the fake agy / claude / codex of
 * tests/helpers/fake-agy-path.ts (private PATH and HOME — the real agy is never run).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn(() => ({ id: 'wt-4452', path: '/nonexistent-4452' })) }));
vi.mock('@/lib/security/path-validator', () => ({ isValidWorktreeId: vi.fn(() => true) }));
vi.mock('@/lib/git/git-route-worktree', () => ({ canonicalWorktreeId: (id: string) => id }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/session/resolve-session-target', () => ({
  resolveSessionTarget: vi.fn(() => ({
    cliToolId: 'claude',
    instanceId: 'claude',
    resolvedBy: 'worktree_default',
    conflict: null,
  })),
}));
vi.mock('@/lib/session/current-output-builder', () => ({
  buildCurrentOutput: vi.fn(async () => ({ content: 'pane', fullOutput: 'pane', sessionStatus: 'ready' })),
}));
vi.mock('@/lib/cli-tools/session-ownership', () => ({
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
  foreignSessionErrorBody: vi.fn(() => ({})),
}));

import { installFakeAgyPath, settleBackgroundProbes, type FakeAgyPath } from '@tests/helpers/fake-agy-path';
import { GET } from '@/app/api/worktrees/[id]/current-output/route';
import { clearDetectorVersionProbeCache, getDetectorFreshness } from '@/lib/detection/version-probes';
import { noteAntigravityUse, resetAntigravityUseForTest } from '@/lib/tool-policy/version-probe-gate';

const params = { params: Promise.resolve({ id: 'wt-4452' }) };
const request = () => new NextRequest('http://localhost:3000/api/worktrees/wt-4452/current-output');

let fake: FakeAgyPath;

beforeEach(() => {
  fake = installFakeAgyPath();
  clearDetectorVersionProbeCache();
  resetAntigravityUseForTest();
});

afterEach(() => {
  clearDetectorVersionProbeCache();
  resetAntigravityUseForTest();
  fake.restore();
});

/** Poll the route `times` times, then let the background probe it started finish. */
async function poll(times: number): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  for (let i = 0; i < times; i += 1) {
    const response = await GET(request(), params);
    expect(response.status).toBe(200);
    body = (await response.json()) as Record<string, unknown>;
  }
  await getDetectorFreshness(); // joins the in-flight background probe
  return body;
}

describe('[#4452] GET /current-output — the pane poll', () => {
  it('4452: without the declaration, polling starts agy 0 times however often it runs', async () => {
    await poll(5);
    await poll(5);

    expect(fake.callsOf('agy')).toEqual([]);
    // I2: claude and codex are still probed, once each per process.
    expect(fake.callsOf('claude')).toEqual(['claude --version']);
    expect(fake.callsOf('codex')).toEqual(['codex --version']);
  });

  it('4452 (I3): with the declaration, the background probe reads agy once', async () => {
    process.env.CM_ANTIGRAVITY_USAGE = 'api-key';
    await poll(5);

    expect(fake.callsOf('agy')).toEqual(['agy --version']);
  });

  it('4452 (I3): after antigravity is used, the next poll probes agy alone, once', async () => {
    await poll(3);
    expect(fake.callsOf('agy')).toEqual([]);

    noteAntigravityUse();
    // Polls only: the awaiting entry point would probe on its own.
    for (let i = 0; i < 5; i += 1) expect((await GET(request(), params)).status).toBe(200);
    await vi.waitFor(() => expect(fake.callsOf('agy')).toEqual(['agy --version']));
    await settleBackgroundProbes();
    for (let i = 0; i < 5; i += 1) await GET(request(), params);
    await settleBackgroundProbes();

    expect(fake.callsOf('agy')).toEqual(['agy --version']);
    expect(fake.callsOf('claude')).toEqual(['claude --version']);
    expect(fake.callsOf('codex')).toEqual(['codex --version']);
    const rows = await getDetectorFreshness();
    expect(rows.find((row) => row.tool === 'antigravity')?.installed).toBe('1.1.18');
  });
});
