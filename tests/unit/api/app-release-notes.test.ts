/**
 * Unit tests for GET /api/app/release-notes (Issue #2646).
 *
 * The route's whole job is the boundary: only `X.Y.Z` reaches the reader, a
 * non-advancing range never touches the filesystem, a read failure is a 500
 * rather than an empty list, and no response may be cached. The reader itself
 * is mocked — it has its own tests against a real directory.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/app-update/release-notes', () => ({
  readReleaseNotesBetween: vi.fn(),
}));

import { NextRequest } from 'next/server';
import { GET, dynamic } from '@/app/api/app/release-notes/route';
import { readReleaseNotesBetween } from '@/lib/app-update/release-notes';
import { AUTH_EXCLUDED_PATHS } from '@/config/auth-config';

/** A request for the route with the given raw query string. */
function request(query: string): NextRequest {
  return new NextRequest(new URL(`/api/app/release-notes?${query}`, 'http://localhost:3000'));
}

const SAMPLE_NOTES = [
  {
    version: '0.39.0',
    date: '2026-09-20',
    highlight: { ja: '更新の目玉', en: 'The highlight of this release' },
    added: [{ ja: '追加された機能', en: 'A new feature' }],
    improved: [],
    fixed: [],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readReleaseNotesBetween).mockResolvedValue([]);
});

describe('Issue #2646: GET /api/app/release-notes', () => {
  it('is a dynamic route', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it('exports only GET and dynamic', async () => {
    // scripts/check-route-exports.mjs rejects anything else, and `next build`
    // fails on it — neither is visible to `tsc --noEmit` on a fresh worktree.
    const route = await import('@/app/api/app/release-notes/route');

    expect(Object.keys(route).sort()).toEqual(['GET', 'dynamic']);
  });

  it('is not excluded from authentication', () => {
    expect(AUTH_EXCLUDED_PATHS).not.toContain('/api/app/release-notes');
  });

  it.each([
    ['from is missing', 'to=0.39.0'],
    ['to is missing', 'from=0.38.0'],
    ['from is a channel name', 'from=latest&to=0.39.0'],
    ['from has two parts', 'from=0.39&to=0.40.0'],
    ['to is a prerelease', 'from=0.38.0&to=0.39.0-rc.1'],
    ['from is a traversal', 'from=../0.39.0&to=0.39.0'],
    ['from carries a shell fragment', 'from=1.2.3;rm&to=1.2.4'],
    ['from is 33 characters', `from=1.2.${'3'.repeat(29)}&to=2.0.0`],
  ])('answers 400 when %s', async (_label, query) => {
    const response = await GET(request(query));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'from and to must be X.Y.Z versions',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(readReleaseNotesBetween).not.toHaveBeenCalled();
  });

  it.each([
    ['the same version', 'from=0.39.0&to=0.39.0'],
    ['a reversed range', 'from=0.40.0&to=0.39.0'],
  ])('answers an empty list without reading anything for %s', async (_label, query) => {
    const response = await GET(request(query));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ notes: [] });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(readReleaseNotesBetween).not.toHaveBeenCalled();
  });

  it('returns the notes from the reader for an advancing range', async () => {
    vi.mocked(readReleaseNotesBetween).mockResolvedValue(SAMPLE_NOTES);

    const response = await GET(request('from=0.38.0&to=0.39.0'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ notes: SAMPLE_NOTES });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(readReleaseNotesBetween).toHaveBeenCalledTimes(1);
    expect(readReleaseNotesBetween).toHaveBeenCalledWith('0.38.0', '0.39.0');
  });

  it('answers 500 when the reader rejects', async () => {
    vi.mocked(readReleaseNotesBetween).mockRejectedValue(
      Object.assign(new Error('EACCES'), { code: 'EACCES' })
    );

    const response = await GET(request('from=0.38.0&to=0.39.0'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to read release notes' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
