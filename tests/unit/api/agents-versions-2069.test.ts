/**
 * `GET /api/agents/versions` (Issue #2069).
 *
 * The property worth pinning is what this route does NOT do: it renders inside
 * the agent pane, so it must not reach the network and must not re-probe on
 * every poll. Both are structural — the "latest" half comes from a file codex
 * wrote, and the probe fan-out sits behind a TTL — and this suite asserts the
 * route honours the `?refresh=1` escape hatch that the update flow depends on.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getAgentVersions } = vi.hoisted(() => ({ getAgentVersions: vi.fn() }));

vi.mock('@/lib/updates/agent-versions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/updates/agent-versions')>();
  return { ...actual, getAgentVersions };
});

import { NextRequest } from 'next/server';
import { GET, dynamic } from '@/app/api/agents/versions/route';

const ROWS = [
  {
    tool: 'claude',
    installed: '2.1.251',
    latestVersion: null,
    dismissedVersion: null,
    updateAvailable: false,
    dismissedInCodex: false,
    updatable: false,
    source: null,
  },
  {
    tool: 'codex',
    installed: '0.149.1',
    latestVersion: '0.151.0',
    dismissedVersion: null,
    updateAvailable: true,
    dismissedInCodex: false,
    updatable: true,
    source: 'version.json' as const,
  },
];

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/agents/versions${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  getAgentVersions.mockResolvedValue(ROWS);
});

describe('[#2069] GET /api/agents/versions', () => {
  it('is force-dynamic (it probes the machine per request)', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it('returns the rows plus the updatable allow-list', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('success');
    expect(body.tools).toEqual(ROWS);
    // Published so the client never hardcodes which tools have an update flow.
    expect(body.updatable).toEqual(['codex']);
  });

  it('uses the cache by default', async () => {
    await GET(request());
    expect(getAgentVersions).toHaveBeenCalledWith({ force: false });
  });

  it('bypasses the cache for ?refresh=1 — the post-update read', async () => {
    await GET(request('?refresh=1'));
    expect(getAgentVersions).toHaveBeenCalledWith({ force: true });
  });

  it('does not treat any other refresh value as a bypass', async () => {
    await GET(request('?refresh=yes'));
    expect(getAgentVersions).toHaveBeenCalledWith({ force: false });
  });

  it('forbids intermediary caching, so ?refresh=1 cannot be answered stale', async () => {
    const response = await GET(request());
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers 500 rather than throwing when the probe layer fails', async () => {
    getAgentVersions.mockRejectedValue(new Error('probe exploded'));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect((await response.json()).status).toBe('error');
  });
});
