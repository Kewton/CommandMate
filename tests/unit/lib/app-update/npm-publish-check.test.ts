/**
 * Unit tests for npm-publish-check (Issue #3110).
 *
 * GitHub announces a release 34-43 minutes before npm serves it. These pin the
 * gate update-check applies (hold hasUpdate back, report pendingVersion, recheck
 * npm every 5 minutes) and the fresh check POST /api/app/update runs. npm is
 * never spawned: the query is injected, or npm-runner is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/cli/utils/npm-runner', () => ({
  viewLatestVersionAsync: vi.fn(),
}));

import {
  NPM_PENDING_RECHECK_MS,
  checkNpmHasNewerVersion,
  fetchNpmLatestVersion,
  resetNpmPublishCheckCacheForTesting,
  resolveNpmPublishGate,
} from '@/lib/app-update/npm-publish-check';
import { viewLatestVersionAsync } from '@/cli/utils/npm-runner';

const GITHUB_NEW = { hasUpdate: true, latestVersion: '0.44.0' };

/** A controllable clock */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetNpmPublishCheckCacheForTesting();
});

describe('resolveNpmPublishGate', () => {
  it('holds the update back and reports pendingVersion while npm serves an older version', async () => {
    const fetchNpmLatest = vi.fn().mockResolvedValue('0.43.0');

    await expect(resolveNpmPublishGate(GITHUB_NEW, { fetchNpmLatest })).resolves.toEqual({
      hasUpdate: false,
      pendingVersion: '0.44.0',
    });
  });

  it.each(['0.44.0', '0.44.1'])('reports the update when npm serves %s', async (npmVersion) => {
    const fetchNpmLatest = vi.fn().mockResolvedValue(npmVersion);

    await expect(resolveNpmPublishGate(GITHUB_NEW, { fetchNpmLatest })).resolves.toEqual({
      hasUpdate: true,
      pendingVersion: null,
    });
  });

  it('falls back to the GitHub answer when npm cannot be asked', async () => {
    const fetchNpmLatest = vi.fn().mockResolvedValue(null);

    await expect(resolveNpmPublishGate(GITHUB_NEW, { fetchNpmLatest })).resolves.toEqual({
      hasUpdate: true,
      pendingVersion: null,
    });
  });

  it('falls back to the GitHub answer when the npm query throws', async () => {
    const fetchNpmLatest = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(resolveNpmPublishGate(GITHUB_NEW, { fetchNpmLatest })).resolves.toEqual({
      hasUpdate: true,
      pendingVersion: null,
    });
  });

  it('never asks npm when GitHub reports no update', async () => {
    const fetchNpmLatest = vi.fn();

    await expect(
      resolveNpmPublishGate({ hasUpdate: false, latestVersion: '0.43.0' }, { fetchNpmLatest })
    ).resolves.toEqual({ hasUpdate: false, pendingVersion: null });
    expect(fetchNpmLatest).not.toHaveBeenCalled();
  });

  it('asks npm again only every NPM_PENDING_RECHECK_MS while pending', async () => {
    const c = clock();
    const fetchNpmLatest = vi.fn().mockResolvedValue('0.43.0');
    const deps = { fetchNpmLatest, now: c.now };

    await resolveNpmPublishGate(GITHUB_NEW, deps);
    c.advance(NPM_PENDING_RECHECK_MS - 1);
    const stillPending = await resolveNpmPublishGate(GITHUB_NEW, deps);
    expect(stillPending.pendingVersion).toBe('0.44.0');
    expect(fetchNpmLatest).toHaveBeenCalledTimes(1);

    fetchNpmLatest.mockResolvedValue('0.44.0');
    c.advance(1);
    await expect(resolveNpmPublishGate(GITHUB_NEW, deps)).resolves.toEqual({
      hasUpdate: true,
      pendingVersion: null,
    });
    expect(fetchNpmLatest).toHaveBeenCalledTimes(2);
  });

  it('keeps a "published" answer without asking npm again', async () => {
    const c = clock();
    const fetchNpmLatest = vi.fn().mockResolvedValue('0.44.0');
    const deps = { fetchNpmLatest, now: c.now };

    await resolveNpmPublishGate(GITHUB_NEW, deps);
    c.advance(NPM_PENDING_RECHECK_MS * 10);
    await expect(resolveNpmPublishGate(GITHUB_NEW, deps)).resolves.toEqual({
      hasUpdate: true,
      pendingVersion: null,
    });
    expect(fetchNpmLatest).toHaveBeenCalledTimes(1);
  });

  it('retries a failed npm query after NPM_PENDING_RECHECK_MS, not on every request', async () => {
    const c = clock();
    const fetchNpmLatest = vi.fn().mockResolvedValue(null);
    const deps = { fetchNpmLatest, now: c.now };

    await resolveNpmPublishGate(GITHUB_NEW, deps);
    await resolveNpmPublishGate(GITHUB_NEW, deps);
    expect(fetchNpmLatest).toHaveBeenCalledTimes(1);

    c.advance(NPM_PENDING_RECHECK_MS);
    await resolveNpmPublishGate(GITHUB_NEW, deps);
    expect(fetchNpmLatest).toHaveBeenCalledTimes(2);
  });

  it('asks npm afresh when GitHub names a different version', async () => {
    const fetchNpmLatest = vi.fn().mockResolvedValue('0.44.0');

    await resolveNpmPublishGate(GITHUB_NEW, { fetchNpmLatest });
    const next = await resolveNpmPublishGate(
      { hasUpdate: true, latestVersion: '0.45.0' },
      { fetchNpmLatest }
    );

    expect(fetchNpmLatest).toHaveBeenCalledTimes(2);
    expect(next).toEqual({ hasUpdate: false, pendingVersion: '0.45.0' });
  });

  it('shares one npm query between concurrent requests', async () => {
    let resolveNpm: (v: string) => void = () => {};
    const fetchNpmLatest = vi.fn(
      () => new Promise<string>((resolve) => {
        resolveNpm = resolve;
      })
    );

    const a = resolveNpmPublishGate(GITHUB_NEW, { fetchNpmLatest });
    const b = resolveNpmPublishGate(GITHUB_NEW, { fetchNpmLatest });
    resolveNpm('0.43.0');

    await expect(Promise.all([a, b])).resolves.toEqual([
      { hasUpdate: false, pendingVersion: '0.44.0' },
      { hasUpdate: false, pendingVersion: '0.44.0' },
    ]);
    expect(fetchNpmLatest).toHaveBeenCalledTimes(1);
  });
});

describe('checkNpmHasNewerVersion', () => {
  it('is false when npm serves the running version', async () => {
    await expect(
      checkNpmHasNewerVersion('0.43.0', { fetchNpmLatest: async () => '0.43.0' })
    ).resolves.toBe(false);
  });

  it('is false when npm serves an older version', async () => {
    await expect(
      checkNpmHasNewerVersion('0.43.0', { fetchNpmLatest: async () => '0.42.2' })
    ).resolves.toBe(false);
  });

  it('is true when npm serves a newer version', async () => {
    await expect(
      checkNpmHasNewerVersion('0.43.0', { fetchNpmLatest: async () => '0.44.0' })
    ).resolves.toBe(true);
  });

  it('is null (unknown) when npm cannot be asked or throws', async () => {
    await expect(
      checkNpmHasNewerVersion('0.43.0', { fetchNpmLatest: async () => null })
    ).resolves.toBeNull();
    await expect(
      checkNpmHasNewerVersion('0.43.0', {
        fetchNpmLatest: async () => {
          throw new Error('boom');
        },
      })
    ).resolves.toBeNull();
  });

  it('is null and asks nothing when the running version cannot be compared', async () => {
    const fetchNpmLatest = vi.fn();
    await expect(
      checkNpmHasNewerVersion('0.44.0-rc.1', { fetchNpmLatest })
    ).resolves.toBeNull();
    expect(fetchNpmLatest).not.toHaveBeenCalled();
  });
});

describe('fetchNpmLatestVersion', () => {
  it('asks npm for the commandmate package and returns its version', async () => {
    vi.mocked(viewLatestVersionAsync).mockResolvedValue({ success: true, version: '0.44.0' });

    await expect(fetchNpmLatestVersion()).resolves.toBe('0.44.0');
    expect(viewLatestVersionAsync).toHaveBeenCalledWith('commandmate');
  });

  it('returns null when npm fails', async () => {
    vi.mocked(viewLatestVersionAsync).mockResolvedValue({ success: false, error: 'offline' });

    await expect(fetchNpmLatestVersion()).resolves.toBeNull();
  });

  it('returns null for output that is not a plain version', async () => {
    vi.mocked(viewLatestVersionAsync).mockResolvedValue({
      success: true,
      version: 'npm WARN something',
    });

    await expect(fetchNpmLatestVersion()).resolves.toBeNull();
  });
});
