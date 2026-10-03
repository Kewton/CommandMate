/**
 * GET /api/app/update-check with the npm publish gate (Issue #3110).
 *
 * Runs the real version-checker (GitHub, cached 1 hour) and the real
 * npm-publish-check (npm, rechecked every 5 minutes while pending) under one
 * injected clock, so the two cadences are pinned against each other. GitHub is
 * a stubbed fetch and npm a mocked npm-runner: nothing leaves the process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/cli/utils/install-context', () => ({
  isGlobalInstall: vi.fn().mockReturnValue(true),
  isNpxExecution: vi.fn().mockReturnValue(false),
}));

vi.mock('@/cli/utils/npm-runner', () => ({
  viewLatestVersionAsync: vi.fn(),
}));

import { GET } from '@/app/api/app/update-check/route';
import { resetCacheForTesting } from '@/lib/version-checker';
import {
  NPM_PENDING_RECHECK_MS,
  resetNpmPublishCheckCacheForTesting,
} from '@/lib/app-update/npm-publish-check';
import { viewLatestVersionAsync } from '@/cli/utils/npm-runner';
import { isGlobalInstall, isNpxExecution } from '@/cli/utils/install-context';

/** Far above any real version, so the running package.json is always older */
const GITHUB_VERSION = '999.0.0';
const GITHUB_TTL_MS = 60 * 60 * 1000;

const githubFetch = vi.fn();

function npmServes(version: string | null): void {
  vi.mocked(viewLatestVersionAsync).mockResolvedValue(
    version === null ? { success: false, error: 'offline' } : { success: true, version }
  );
}

async function check(): Promise<Record<string, unknown>> {
  return (await (await GET()).json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T14:00:00Z'));
  resetCacheForTesting();
  resetNpmPublishCheckCacheForTesting();
  vi.mocked(isGlobalInstall).mockReturnValue(true);
  vi.mocked(isNpxExecution).mockReturnValue(false);
  githubFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        tag_name: `v${GITHUB_VERSION}`,
        html_url: `https://github.com/Kewton/CommandMate/releases/tag/v${GITHUB_VERSION}`,
        name: `v${GITHUB_VERSION}`,
        published_at: '2026-10-01T13:58:00Z',
      }),
    headers: new Headers(),
  });
  vi.stubGlobal('fetch', githubFetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GET /api/app/update-check - npm publish gate (Issue #3110)', () => {
  it('reports pendingVersion and no update while npm serves an older version', async () => {
    npmServes('0.0.1');

    const data = await check();

    expect(data.hasUpdate).toBe(false);
    expect(data.pendingVersion).toBe(GITHUB_VERSION);
    expect(data.latestVersion).toBe(GITHUB_VERSION);
    expect(data.updateCommand).toBeNull();
  });

  it('reports the update when npm serves the GitHub version', async () => {
    npmServes(GITHUB_VERSION);

    const data = await check();

    expect(data.hasUpdate).toBe(true);
    expect(data.pendingVersion).toBeNull();
    expect(data.updateCommand).toBe('npm install -g commandmate@latest');
  });

  it('falls back to the GitHub-only answer when npm cannot be asked', async () => {
    npmServes(null);

    const data = await check();

    expect(data.hasUpdate).toBe(true);
    expect(data.pendingVersion).toBeNull();
  });

  it.each([
    ['npx', () => vi.mocked(isNpxExecution).mockReturnValue(true)],
    ['local', () => vi.mocked(isGlobalInstall).mockReturnValue(false)],
  ])('leaves a %s install on the GitHub-only answer and never asks npm', async (_name, arrange) => {
    arrange();
    npmServes('0.0.1');

    const data = await check();

    expect(data.hasUpdate).toBe(true);
    expect(data.pendingVersion).toBeNull();
    expect(viewLatestVersionAsync).not.toHaveBeenCalled();
  });

  it('rechecks npm every 5 minutes while pending and keeps GitHub cached for 1 hour', async () => {
    npmServes('0.0.1');

    await check();
    expect(githubFetch).toHaveBeenCalledTimes(1);
    expect(viewLatestVersionAsync).toHaveBeenCalledTimes(1);

    // Inside the 5-minute window: neither source is asked again.
    vi.advanceTimersByTime(NPM_PENDING_RECHECK_MS - 1);
    expect((await check()).pendingVersion).toBe(GITHUB_VERSION);
    expect(githubFetch).toHaveBeenCalledTimes(1);
    expect(viewLatestVersionAsync).toHaveBeenCalledTimes(1);

    // 5 minutes on: npm is asked again (still behind), GitHub is not.
    vi.advanceTimersByTime(1);
    expect((await check()).pendingVersion).toBe(GITHUB_VERSION);
    expect(githubFetch).toHaveBeenCalledTimes(1);
    expect(viewLatestVersionAsync).toHaveBeenCalledTimes(2);

    // npm catches up: the next 5-minute recheck turns the update on.
    npmServes(GITHUB_VERSION);
    vi.advanceTimersByTime(NPM_PENDING_RECHECK_MS);
    const published = await check();
    expect(published.hasUpdate).toBe(true);
    expect(published.pendingVersion).toBeNull();
    expect(githubFetch).toHaveBeenCalledTimes(1);
    expect(viewLatestVersionAsync).toHaveBeenCalledTimes(3);

    // GitHub is asked again only once its 1-hour cache expires.
    vi.setSystemTime(new Date('2026-10-01T14:00:00Z').getTime() + GITHUB_TTL_MS);
    await check();
    expect(githubFetch).toHaveBeenCalledTimes(2);
  });
});
