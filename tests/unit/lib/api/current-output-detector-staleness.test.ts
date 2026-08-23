/**
 * `detector.staleness` on GET /api/worktrees/[id]/current-output (Issue #1929).
 *
 * This is the surface `capture --json` reads, and it is a 5-second polling path.
 * Two things are pinned here that the module test cannot pin on its own:
 *
 *  1. the route asks for the SNAPSHOT, never the awaiting entry point — a probe
 *     awaited here would hold a poll open for as long as a CLI takes to start;
 *  2. a cold cache publishes **no `detector` key at all**, rather than an empty
 *     one. "Not known yet" and "nothing is stale" are different answers, and
 *     collapsing them would make the banner permanently invisible on a server
 *     that never warms.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn(() => ({ id: 'wt-1' })) }));
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
  buildCurrentOutput: vi.fn(async () => ({ content: 'pane', sessionStatus: 'ready' })),
}));

const getDetectorStalenessSnapshot = vi.fn();
const getDetectorFreshness = vi.fn();
vi.mock('@/lib/detection/version-probes', () => ({
  getDetectorStalenessSnapshot: () => getDetectorStalenessSnapshot(),
  getDetectorFreshness: () => getDetectorFreshness(),
}));

import { GET } from '@/app/api/worktrees/[id]/current-output/route';

const params = { params: Promise.resolve({ id: 'wt-1' }) };
const request = () =>
  new NextRequest('http://localhost:3000/api/worktrees/wt-1/current-output');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('[#1929] GET /current-output → detector.staleness', () => {
  it('omits the detector key entirely while the probe cache is cold', async () => {
    getDetectorStalenessSnapshot.mockReturnValue(undefined);

    const body = await (await GET(request(), params)).json();

    expect('detector' in body, 'a cold cache must publish nothing at all').toBe(false);
    expect(body.content).toBe('pane');
  });

  it('publishes an empty staleness once the probe has answered and found nothing', async () => {
    getDetectorStalenessSnapshot.mockReturnValue({});

    const body = await (await GET(request(), params)).json();

    // Distinguishable from the cold case above, which is the whole point.
    expect(body.detector).toEqual({ staleness: {} });
  });

  it('publishes the skew for a tool whose installed build is newer', async () => {
    getDetectorStalenessSnapshot.mockReturnValue({
      antigravity: { installed: '1.1.18', verifiedAgainst: '0.4.x' },
    });

    const body = await (await GET(request(), params)).json();

    expect(body.detector.staleness.antigravity).toEqual({
      installed: '1.1.18',
      verifiedAgainst: '0.4.x',
    });
    // Everything the builder produced still travels untouched.
    expect(body.sessionStatus).toBe('ready');
  });

  it('never awaits the probing entry point on this path (DR3-013)', async () => {
    getDetectorStalenessSnapshot.mockReturnValue({});

    await GET(request(), params);

    expect(getDetectorStalenessSnapshot).toHaveBeenCalledTimes(1);
    expect(
      getDetectorFreshness,
      'the 5-second poll path must never await a child process'
    ).not.toHaveBeenCalled();
  });
});
