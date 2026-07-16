/**
 * Semantic Version Utilities
 * Issue #1194: Shared 3-way version comparison (D-14 / S3-005)
 *
 * Extracted from PreflightChecker so that `commandmate update` and the
 * preflight dependency checker share a single comparison implementation.
 *
 * Note: `src/lib/version-checker.ts` intentionally is NOT reused here.
 * It imports via the `@/` alias which `tsconfig.cli.json` disables
 * (`"paths": {}`), so importing it from src/cli breaks `npm run build:cli`
 * with TS2307 (S1-010).
 *
 * @module semver
 */

/**
 * Matches plain release versions only (no prerelease / build metadata).
 * Mirrors the SEMVER_PATTERN used by src/lib/version-checker.ts.
 */
const RELEASE_VERSION_PATTERN = /^v?\d+\.\d+\.\d+$/;

/**
 * Check whether a version string can be compared numerically.
 *
 * Prerelease versions (e.g. `0.9.0-rc.1`) are NOT comparable: feeding them to
 * {@link compareVersions} would produce `NaN` parts and meaningless results.
 * Callers must treat `false` as "comparison impossible" (D-3).
 *
 * @param version - Version string (optionally `v`-prefixed)
 * @returns true if the version is a plain `X.Y.Z` release version
 */
export function isComparableVersion(version: string): boolean {
  return RELEASE_VERSION_PATTERN.test(version);
}

/**
 * Compare two version strings numerically.
 *
 * Missing parts are treated as 0 (`1.2` === `1.2.0`).
 *
 * @param a - Left version (optionally `v`-prefixed)
 * @param b - Right version (optionally `v`-prefixed)
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const partsA = normalize(a);
  const partsB = normalize(b);
  const len = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }

  return 0;
}

/**
 * Strip an optional leading `v` and split into numeric parts.
 */
function normalize(version: string): number[] {
  return version.replace(/^v/, '').split('.').map(Number);
}
