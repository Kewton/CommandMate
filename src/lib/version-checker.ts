/**
 * Version Checker Module
 * Issue #257: Version update notification feature
 *
 * Checks GitHub Releases API for newer versions of CommandMate.
 * Uses globalThis cache pattern (auto-yes-manager.ts reference) for
 * hot-reload persistence.
 *
 * Security:
 * - [SEC-001] GITHUB_API_URL is hardcoded (SSRF prevention, OWASP A10:2021)
 * - [SEC-SF-001] Response validation (validateReleaseUrl, sanitizeReleaseName)
 * - [SEC-SF-002] User-Agent header for GitHub API compliance (OWASP A07:2021)
 *
 * @module version-checker
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { isVersionMismatch } from '@/lib/realtime/types';

// =============================================================================
// Constants
// =============================================================================

/**
 * [SEC-001] SSRF Prevention: GitHub API URL is a hardcoded constant.
 * This value MUST NOT be derived from environment variables, config files,
 * or user input. Changing this value requires security review.
 * OWASP A10:2021 - Server-Side Request Forgery
 */
export const GITHUB_API_URL = 'https://api.github.com/repos/Kewton/CommandMate/releases/latest' as const;

/**
 * [SEC-SF-001] GitHub Releases URL allowed prefix for validation.
 * Used to verify html_url from API responses.
 * Imported from github-links.ts (Issue #264 DRY) and re-exported for backward compatibility.
 */
import { GITHUB_RELEASE_URL_PREFIX } from '@/config/github-links';
export { GITHUB_RELEASE_URL_PREFIX };

/** Semver pattern: optional v-prefix followed by major.minor.patch */
const SEMVER_PATTERN = /^v?\d+\.\d+\.\d+$/;

/** [SEC-SF-001] Release name allowed characters pattern */
const RELEASE_NAME_PATTERN = /^[a-zA-Z0-9.\-\s_v]+$/;

/** Maximum allowed release name length */
const RELEASE_NAME_MAX_LENGTH = 128;

/** Cache TTL: 1 hour (matches GitHub API unauthenticated rate limit of 60 req/h) */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Fetch timeout: 5 seconds */
const FETCH_TIMEOUT_MS = 5000;

/**
 * npm package name. [Issue #1359] Used to verify that a package.json resolved at
 * runtime is CommandMate's own manifest and not an unrelated project's — a guard
 * against an unexpected process.cwd() (e.g. a dev run started from a user's
 * project directory) leaking a foreign version.
 */
const PACKAGE_NAME = 'commandmate';

/**
 * The manifest `next build` writes beside the client bundle, relative to the
 * package root. [Issue #2271]
 *
 * It snapshots the *resolved* next.config — the `env` block included — so
 * `config.env.NEXT_PUBLIC_APP_VERSION` is literally the string that build
 * inlined into every browser bundle it emitted. That makes it the only file on
 * disk that can answer "which version is the bundle we are serving?" without
 * asking the bundle itself.
 */
const NEXT_BUILD_MANIFEST_PATH = ['.next', 'required-server-files.json'] as const;

// =============================================================================
// Types
// =============================================================================

/** GitHub Releases API response (only required fields) */
interface GitHubRelease {
  tag_name: string;
  html_url: string;
  name: string;
  published_at: string;
}

/** Version check result */
export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string | null;
  releaseName: string;
  publishedAt: string;
}

/** In-memory cache structure */
interface VersionCache {
  result: UpdateCheckResult | null;
  fetchedAt: number;
  rateLimitResetAt: number | null;
}

// =============================================================================
// globalThis Cache (hot-reload resistant)
// [IMP-SF-003] Pattern from auto-yes-manager.ts:99-112
// =============================================================================

declare global {
  // eslint-disable-next-line no-var -- globalThis pattern for hot-reload persistence (auto-yes-manager.ts:99-103 precedent)
  var __versionCheckCache: VersionCache | undefined;
}

const cache: VersionCache = globalThis.__versionCheckCache ??
  (globalThis.__versionCheckCache = {
    result: null,
    fetchedAt: 0,
    rateLimitResetAt: null,
  });

// =============================================================================
// Public Functions
// =============================================================================

/**
 * Compare two semver version strings.
 * [SF-003] Includes built-in validation - returns false for invalid formats.
 *
 * @param current - Current version (e.g., "0.2.3", "v0.2.3")
 * @param latest - Latest version (e.g., "0.3.0", "v0.3.0")
 * @returns true if latest is newer than current, false for invalid formats
 */
export function isNewerVersion(current: string, latest: string): boolean {
  // [SF-003] Defensive validation: reject invalid formats immediately
  if (!SEMVER_PATTERN.test(current) || !SEMVER_PATTERN.test(latest)) {
    return false;
  }

  const parse = (v: string): number[] => v.replace(/^v/, '').split('.').map(Number);
  const [cMajor, cMinor, cPatch] = parse(current);
  const [lMajor, lMinor, lPatch] = parse(latest);

  if (lMajor !== cMajor) return lMajor > cMajor;
  if (lMinor !== cMinor) return lMinor > cMinor;
  return lPatch > cPatch;
}

/**
 * Read CommandMate's version from the installed package.json at runtime.
 *
 * [Issue #1359] `NEXT_PUBLIC_APP_VERSION` is baked into the bundle at
 * `next build` time, so it reflects "the version present when the client bundle
 * was last built", not the version of the server code actually running. Reading
 * package.json on each call reflects the real installed version, which is what
 * the update-check API must report as `currentVersion`.
 *
 * The server is spawned with cwd = package root (start.ts), so
 * `process.cwd()/package.json` is the installed manifest. We verify
 * `name === 'commandmate'` so an unexpected cwd can never leak an unrelated
 * project's version; on any mismatch or read failure the caller falls back to
 * the baked value.
 *
 * @returns Runtime version string, or null when unreadable / not CommandMate's package.json
 */
function readRuntimeServerVersion(): string | null {
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
    if (
      parsed.name === PACKAGE_NAME &&
      typeof parsed.version === 'string' &&
      parsed.version.length > 0
    ) {
      return parsed.version;
    }
    return null;
  } catch {
    // Unreadable / malformed package.json: fall back to the baked value.
    return null;
  }
}

/**
 * Get the client bundle version (baked at build time).
 * [CONS-002] `NEXT_PUBLIC_APP_VERSION` is injected by next.config.js from
 * package.json at `next build` time. This is the correct value to describe
 * "the version of the bundle this page was served from" and is intentionally
 * left build-time baked (Issue #1359).
 *
 * @returns Client bundle version string (e.g., "0.2.3"), or "0.0.0" as fallback
 */
export function getClientVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0';
}

/**
 * Get the server's actually-running version, resolved at runtime.
 * [Issue #1359] Prefers the installed package.json (runtime truth) over the
 * build-time baked `NEXT_PUBLIC_APP_VERSION`, so update-check reports the version
 * of the server code that is really running. Separating this from
 * getClientVersion() is the basis for version-mismatch detection (#1338/#1356).
 *
 * Resolution order:
 *   1. Runtime package.json (name === "commandmate")
 *   2. Baked NEXT_PUBLIC_APP_VERSION
 *   3. "0.0.0"
 *
 * @returns Server runtime version string (e.g., "0.2.3"), or "0.0.0" as fallback
 */
export function getServerVersion(): string {
  return readRuntimeServerVersion() ?? getClientVersion();
}

/**
 * Get the current application version (server runtime version).
 * Retained for backward compatibility; delegates to getServerVersion().
 *
 * @returns Current version string (e.g., "0.2.3"), or "0.0.0" as fallback
 */
export function getCurrentVersion(): string {
  return getServerVersion();
}

// =============================================================================
// Served bundle identity (Issue #2271)
// =============================================================================

/**
 * Memoised answer of {@link getServedBundleVersion}, resolved on first use and
 * then frozen for the life of the process. [Issue #2271]
 *
 * Frozen on purpose. The question is "which build is this process serving?",
 * and a running Next production server answers that once — at startup, from the
 * `.next` it opened. Re-reading the manifest on every call would let a
 * `next build` performed *underneath* the running server rename the served
 * build without the server having reloaded a single byte of it, which is the
 * false positive this Issue exists to remove, in a new disguise.
 */
let servedBundleVersion: string | null = null;

/**
 * Read the version `next build` inlined into the client bundle, from the build
 * manifest it left on disk. [Issue #2271]
 *
 * @returns The baked version, or null when the manifest is absent, unreadable,
 *   malformed, or predates the `env` block.
 */
function readServedBundleVersionFromBuild(): string | null {
  try {
    const raw = readFileSync(join(process.cwd(), ...NEXT_BUILD_MANIFEST_PATH), 'utf-8');
    const parsed = JSON.parse(raw) as { config?: { env?: Record<string, unknown> } };
    const baked = parsed.config?.env?.NEXT_PUBLIC_APP_VERSION;
    if (typeof baked === 'string' && baked.length > 0) return baked;
    return null;
  } catch {
    return null;
  }
}

/** First-use resolution behind {@link getServedBundleVersion}'s memo. */
function resolveServedBundleVersion(): string {
  // `next dev` compiles on demand and never writes the build manifest, but a
  // stale one left by an earlier `npm run build` is still sitting in `.next` —
  // and it names a version the dev bundle was never built from. Under dev the
  // live next.config populates `process.env` for the server too, so the baked
  // value already *is* the honest answer and the manifest must not be consulted.
  if (process.env.NODE_ENV === 'production') {
    const built = readServedBundleVersionFromBuild();
    if (built) return built;
  }
  return getClientVersion();
}

/**
 * The version of the **client bundle this server is serving**. [Issue #2271]
 *
 * Deliberately *not* {@link getServerVersion}. That one reads package.json at
 * runtime, which is the right answer for "is there a newer release on GitHub?"
 * and the wrong one for "should this tab reload?": the release procedure bumps
 * package.json on `develop` and never rebuilds the primary checkout (doing so
 * would swap `.next` out from under the running server — see the release
 * skill's Phase 2-3), so `package.json > bundle` is the steady state after
 * every release. Comparing against it therefore told **every** tab, forever,
 * that it was out of date.
 *
 * The honest comparand is the build the bundle came from, so this reads the
 * `next build` manifest and falls back — never to package.json — to the baked
 * `NEXT_PUBLIC_APP_VERSION`, and finally to `'0.0.0'`, which
 * {@link isVersionMismatch} treats as "unknown" and never reports as drift.
 *
 * @returns Served bundle version string (e.g., "0.2.3"), or "0.0.0" as fallback
 */
export function getServedBundleVersion(): string {
  servedBundleVersion ??= resolveServedBundleVersion();
  return servedBundleVersion;
}

/** The two build identities that drifted apart. See {@link resolveBundleDrift}. */
export interface BundleDrift {
  /** The version of the bundle the server now serves. */
  serverVersion: string;
  /** The version of the bundle the reporting tab is running. */
  clientVersion: string;
}

/**
 * Decide whether a tab running `clientBundleVersion` is on a stale build.
 * [Issue #2271]
 *
 * The single seam the WebSocket version handshake calls, so "what counts as
 * drift" has exactly one definition and one place to test it. Both sides are
 * build identities: the client sends the `NEXT_PUBLIC_APP_VERSION` its bundle
 * was compiled with, and this compares it against the version of the bundle
 * being served — so a bare `package.json` bump moves neither side, and only a
 * rebuild does.
 *
 * @param clientBundleVersion - The version the tab's bundle was built from
 * @returns The drifted pair, or null when the two builds agree or either side
 *   is an unknown/fallback version
 */
export function resolveBundleDrift(clientBundleVersion: string): BundleDrift | null {
  const serverVersion = getServedBundleVersion();
  if (!isVersionMismatch(serverVersion, clientBundleVersion)) return null;
  return { serverVersion, clientVersion: clientBundleVersion };
}

/**
 * Validate that a URL is a legitimate GitHub Releases URL.
 * [SEC-SF-001] OWASP A03:2021 - Prevents injection via DNS pollution/MITM.
 *
 * @param url - URL to validate
 * @returns Validated URL, or null if invalid
 */
export function validateReleaseUrl(url: string): string | null {
  if (!url.startsWith(GITHUB_RELEASE_URL_PREFIX)) {
    return null;
  }
  return url;
}

/**
 * Sanitize a release name to safe character set.
 * [SEC-SF-001] Restricts to alphanumeric, dots, hyphens, spaces, underscores, v-prefix.
 *
 * @param name - Release name to sanitize
 * @param tagName - Fallback value (semver-validated tag_name)
 * @returns Sanitized name, or tagName if the name is invalid
 */
export function sanitizeReleaseName(name: string, tagName: string): string {
  if (RELEASE_NAME_PATTERN.test(name) && name.length <= RELEASE_NAME_MAX_LENGTH) {
    return name;
  }
  // Fallback to tag_name (already validated by SEMVER_PATTERN)
  return tagName;
}

/**
 * Check GitHub Releases for newer versions.
 * Uses in-memory cache (globalThis.__versionCheckCache) with 1-hour TTL.
 * Silently fails on network errors, timeouts, or API issues.
 *
 * [SF-002] Multiple calls within the same process are safe: the globalThis cache
 * (1-hour TTL) ensures that only the first call triggers a network request.
 * Subsequent calls within the TTL window return the cached result without
 * network overhead. The cache is stored in globalThis.__versionCheckCache
 * and automatically invalidated after CACHE_TTL_MS (1 hour).
 *
 * @returns Update check result, or null on failure
 */
export async function checkForUpdate(): Promise<UpdateCheckResult | null> {
  try {
    // Check cache validity
    if (isCacheValid()) {
      return cache.result;
    }

    // Check rate limit
    if (isRateLimited()) {
      return cache.result;
    }

    const response = await fetch(GITHUB_API_URL, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': `CommandMate/${getCurrentVersion()}`, // [SEC-SF-002]
      },
      cache: 'no-store', // Issue #278: Prevent Next.js Data Cache from caching GitHub API responses
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    // Handle rate limit (403)
    if (response.status === 403) {
      handleRateLimit(response);
      return cache.result;
    }

    if (!response.ok) {
      return cache.result;
    }

    const data = (await response.json()) as GitHubRelease;

    const currentVersion = getCurrentVersion();
    const latestVersion = data.tag_name.replace(/^v/, '');
    const hasUpdate = isNewerVersion(currentVersion, data.tag_name);

    const result: UpdateCheckResult = {
      hasUpdate,
      currentVersion,
      latestVersion,
      releaseUrl: validateReleaseUrl(data.html_url),
      releaseName: sanitizeReleaseName(data.name, data.tag_name),
      publishedAt: data.published_at,
    };

    // Update cache
    cache.result = result;
    cache.fetchedAt = Date.now();

    return result;
  } catch {
    // Silent failure: network errors, timeouts, parse errors
    return cache.result;
  }
}

/**
 * Reset cache for testing purposes only.
 * @internal
 */
export function resetCacheForTesting(): void {
  cache.result = null;
  cache.fetchedAt = 0;
  cache.rateLimitResetAt = null;
  // Issue #2271: the served-bundle memo is frozen for the life of a process, so
  // a suite that moves process.cwd() between cases must be able to thaw it.
  servedBundleVersion = null;
}

// =============================================================================
// Internal Functions
// =============================================================================

/** Check if cache is valid (within TTL) */
function isCacheValid(): boolean {
  return cache.result !== null && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS;
}

/**
 * Check if currently rate-limited.
 * [C-001] Simplified rate limit handling: uses rateLimitResetAt from 403 response.
 */
function isRateLimited(): boolean {
  if (!cache.rateLimitResetAt) return false;
  if (Date.now() >= cache.rateLimitResetAt) {
    cache.rateLimitResetAt = null;
    return false;
  }
  return true;
}

/**
 * Handle 403 rate limit response.
 * Extracts X-RateLimit-Reset header for precise retry timing,
 * or falls back to CACHE_TTL_MS extension.
 */
function handleRateLimit(response: Response): void {
  const resetTimestamp = response.headers.get('X-RateLimit-Reset');
  if (resetTimestamp) {
    cache.rateLimitResetAt = parseInt(resetTimestamp, 10) * 1000;
  } else {
    // Reset time unknown: retry after 1 hour
    cache.rateLimitResetAt = Date.now() + CACHE_TTL_MS;
  }
}
