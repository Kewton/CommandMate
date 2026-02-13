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
 */
export const GITHUB_RELEASE_URL_PREFIX = 'https://github.com/Kewton/CommandMate/releases/' as const;

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
 * Get the current application version.
 * [CONS-002] Uses process.env.NEXT_PUBLIC_APP_VERSION (same as client-side).
 *
 * @returns Current version string (e.g., "0.2.3"), or "0.0.0" as fallback
 */
export function getCurrentVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0';
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
 * Uses in-memory cache (globalThis) with 1-hour TTL.
 * Silently fails on network errors, timeouts, or API issues.
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
