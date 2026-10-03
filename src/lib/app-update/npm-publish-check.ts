/**
 * npm Publish Check
 * Issue #3110: GitHub announces a release 34-43 minutes before npm serves it.
 *
 * The update button is driven by GitHub's `releases/latest`, but the update
 * itself reinstalls npm's `latest`. In that window the button promised a
 * version `commandmate update` could not fetch: it exited "Already up to date",
 * the server never restarted, and the page waited out its 5-minute timeout.
 *
 * This module answers "has npm caught up?" for both ends:
 * - {@link resolveNpmPublishGate}: update-check withholds `hasUpdate` and
 *   reports `pendingVersion` until npm serves the GitHub version.
 * - {@link checkNpmHasNewerVersion}: POST /api/app/update refuses to launch a
 *   no-op update (`not_yet_published`).
 *
 * The query is `npm view commandmate version` — the same `.npmrc` / mirror /
 * proxy the update's `npm install -g` uses, so "published" means "installable
 * from here". An npm that cannot be reached yields `null`, and every caller
 * then falls back to the GitHub-only behaviour that predates this check.
 *
 * @module lib/app-update/npm-publish-check
 */

// [CONS-001] CLI layer utility. Cross-layer import precedent: update-check route.
import { viewLatestVersionAsync } from '@/cli/utils/npm-runner';
import { isNewerVersion } from '@/lib/version-checker';

/** npm package name queried with `npm view` */
const PACKAGE_NAME = 'commandmate';

/** Only a plain release version from npm is trusted */
const NPM_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** A running version this check can compare against (same shape isNewerVersion accepts) */
const CURRENT_VERSION_PATTERN = /^v?\d+\.\d+\.\d+$/;

/**
 * While a GitHub release is not yet on npm, ask npm again after this long.
 * Independent of the GitHub cache (1 hour): npm has no rate limit to respect.
 */
export const NPM_PENDING_RECHECK_MS = 5 * 60 * 1000;

/** Resolves npm's latest version, or null when npm could not be asked */
export type NpmLatestFetcher = () => Promise<string | null>;

/** Seams for tests: the npm query and the clock */
export interface NpmPublishCheckDeps {
  fetchNpmLatest?: NpmLatestFetcher;
  now?: () => number;
}

/** What update-check reports after consulting npm */
export interface NpmPublishGateResult {
  hasUpdate: boolean;
  /** The GitHub version npm does not serve yet; null when not pending */
  pendingVersion: string | null;
}

/** Last npm answer, remembered per GitHub version */
interface NpmPublishCache {
  /** GitHub version the answer was obtained for */
  targetVersion: string | null;
  /** npm's latest version, or null when the query failed */
  npmVersion: string | null;
  checkedAt: number;
  /** Shared by concurrent callers so one burst of requests spawns one npm */
  inFlight: Promise<string | null> | null;
}

/** globalThis slot that keeps the cache across hot reloads (typed without `declare global { var }`) */
const globalStore = globalThis as typeof globalThis & {
  __npmPublishCheckCache?: NpmPublishCache;
};

const cache: NpmPublishCache = globalStore.__npmPublishCheckCache ??
  (globalStore.__npmPublishCheckCache = {
    targetVersion: null,
    npmVersion: null,
    checkedAt: 0,
    inFlight: null,
  });

/**
 * Ask npm for the latest published CommandMate version.
 *
 * @returns The version, or null on any failure (npm missing, offline, timeout,
 *   unexpected output)
 */
export async function fetchNpmLatestVersion(): Promise<string | null> {
  const result = await viewLatestVersionAsync(PACKAGE_NAME);
  if (!result.success || !result.version) return null;
  return NPM_VERSION_PATTERN.test(result.version) ? result.version : null;
}

/** Whether npm's version is at or past the GitHub version */
function isPublished(npmVersion: string, targetVersion: string): boolean {
  return !isNewerVersion(npmVersion, targetVersion);
}

/**
 * npm's latest version for deciding about `targetVersion`, cached.
 *
 * - Once npm serves `targetVersion`, the answer stands until GitHub names a
 *   different version (npm `latest` does not move backwards).
 * - While pending, or after a failed query, npm is asked again only after
 *   {@link NPM_PENDING_RECHECK_MS}.
 */
async function getNpmLatestFor(
  targetVersion: string,
  fetchNpmLatest: NpmLatestFetcher,
  now: () => number
): Promise<string | null> {
  if (cache.targetVersion === targetVersion) {
    if (cache.npmVersion !== null && isPublished(cache.npmVersion, targetVersion)) {
      return cache.npmVersion;
    }
    if (now() - cache.checkedAt < NPM_PENDING_RECHECK_MS) {
      return cache.npmVersion;
    }
  }

  if (!cache.inFlight) {
    cache.inFlight = (async () => {
      try {
        return await fetchNpmLatest();
      } catch {
        return null;
      }
    })();
  }
  const pending = cache.inFlight;
  const npmVersion = await pending;
  if (cache.inFlight === pending) {
    cache.inFlight = null;
    recordNpmLatest(targetVersion, npmVersion, now());
  }
  return npmVersion;
}

/** Remember an npm answer for `targetVersion` */
function recordNpmLatest(targetVersion: string, npmVersion: string | null, at: number): void {
  cache.targetVersion = targetVersion;
  cache.npmVersion = npmVersion;
  cache.checkedAt = at;
}

/**
 * Hold back a GitHub-reported update until npm serves it.
 *
 * @param github - hasUpdate / latestVersion as GitHub reported them
 * @param deps - Test seams
 * @returns `hasUpdate: true` only when npm serves at least the GitHub version;
 *   `pendingVersion` while it does not. When npm cannot be asked, GitHub's
 *   answer is returned unchanged.
 */
export async function resolveNpmPublishGate(
  github: { hasUpdate: boolean; latestVersion: string },
  deps: NpmPublishCheckDeps = {}
): Promise<NpmPublishGateResult> {
  if (!github.hasUpdate) {
    return { hasUpdate: false, pendingVersion: null };
  }

  const npmVersion = await getNpmLatestFor(
    github.latestVersion,
    deps.fetchNpmLatest ?? fetchNpmLatestVersion,
    deps.now ?? Date.now
  );

  if (npmVersion === null || isPublished(npmVersion, github.latestVersion)) {
    return { hasUpdate: true, pendingVersion: null };
  }
  return { hasUpdate: false, pendingVersion: github.latestVersion };
}

/**
 * Whether npm serves a version newer than `currentVersion`, asked fresh.
 *
 * Used right before launching `commandmate update`, which would otherwise
 * report "Already up to date" and leave the page waiting for a restart that
 * never comes.
 *
 * @param currentVersion - The running server's version
 * @param deps - Test seams
 * @returns true / false, or null when npm could not be asked (callers proceed
 *   as before this check existed)
 */
export async function checkNpmHasNewerVersion(
  currentVersion: string,
  deps: Pick<NpmPublishCheckDeps, 'fetchNpmLatest'> = {}
): Promise<boolean | null> {
  // An unparseable running version cannot be compared: never refuse on it.
  if (!CURRENT_VERSION_PATTERN.test(currentVersion)) return null;
  let npmVersion: string | null;
  try {
    npmVersion = await (deps.fetchNpmLatest ?? fetchNpmLatestVersion)();
  } catch {
    return null;
  }
  if (npmVersion === null) return null;
  return isNewerVersion(currentVersion, npmVersion);
}

/**
 * Reset the npm answer cache for testing purposes only.
 * @internal
 */
export function resetNpmPublishCheckCacheForTesting(): void {
  cache.targetVersion = null;
  cache.npmVersion = null;
  cache.checkedAt = 0;
  cache.inFlight = null;
}
