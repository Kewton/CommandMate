/**
 * GET /api/app/update-check
 * Issue #257: Version update notification feature
 *
 * Checks for newer CommandMate versions via GitHub Releases API.
 * Returns update information including install type and update command.
 *
 * Design decisions:
 * - Always returns HTTP 200 (even on errors) for client simplicity
 * - [SF-004] Uses status: 'success' | 'degraded' for monitoring
 * - [SEC-SF-003] Cache-Control headers prevent HTTP-level caching
 * - [SEC-SF-004] updateCommand is a fixed string only
 * - [CONS-001] isGlobalInstall() is a cross-layer reference from CLI utils
 *
 * @module api/app/update-check
 */

import { NextResponse } from 'next/server';
import { checkForUpdate, getCurrentVersion } from '@/lib/version-checker';
// [CONS-001] CLI layer utility. Cross-layer import precedent: db-path-resolver.ts
import { isGlobalInstall } from '@/cli/utils/install-context';
import type { UpdateCheckResult } from '@/lib/version-checker';

// [FIX-270] Force dynamic route to prevent static prerendering at build time.
// Without this, Next.js caches the GitHub API response during `npm run build`
// and the route handler is never called at runtime.
export const dynamic = 'force-dynamic';

// =============================================================================
// Types
// =============================================================================

/** Install type union used across the API response */
type InstallType = 'global' | 'local' | 'unknown';

/**
 * API Response type.
 * [SF-002] Explicit mapping from UpdateCheckResult with nullable fields.
 * [SF-004] Includes status field for monitoring/debugging.
 */
export interface UpdateCheckResponse {
  status: 'success' | 'degraded';
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  installType: InstallType;
  /** [SEC-SF-004] Fixed string "npm install -g commandmate@latest" only. Never include dynamic path info. */
  updateCommand: string | null;
}

// =============================================================================
// Internal Helpers (DRY)
// =============================================================================

/**
 * Detect install type with error handling.
 * [CONS-001] Cross-layer call to CLI utility; errors fall back to 'unknown'.
 *
 * @returns Detected install type
 */
function detectInstallType(): InstallType {
  try {
    return isGlobalInstall() ? 'global' : 'local';
  } catch {
    return 'unknown';
  }
}

/**
 * [SEC-SF-003] OWASP A05:2021 - Security headers to prevent HTTP-level caching.
 * Extracted as a constant to avoid duplication (DRY).
 */
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
} as const;

/**
 * Build a NextResponse with the standard no-cache headers.
 *
 * @param data - Response payload
 * @returns NextResponse with security headers
 */
function buildResponse(data: UpdateCheckResponse): NextResponse<UpdateCheckResponse> {
  return NextResponse.json(data, { headers: NO_CACHE_HEADERS });
}

// =============================================================================
// Mapping Function
// =============================================================================

/**
 * Map UpdateCheckResult to UpdateCheckResponse.
 * [SF-002] Centralizes null/nullable conversion logic.
 *
 * @param result - Version check result (null on API failure)
 * @param installType - Detected install type
 * @returns Typed API response
 */
function toUpdateCheckResponse(
  result: UpdateCheckResult | null,
  installType: InstallType
): UpdateCheckResponse {
  if (!result) {
    return {
      status: 'degraded',
      hasUpdate: false,
      currentVersion: getCurrentVersion(),
      latestVersion: null,
      releaseUrl: null,
      releaseName: null,
      publishedAt: null,
      installType,
      updateCommand: null,
    };
  }

  return {
    status: 'success',
    hasUpdate: result.hasUpdate,
    currentVersion: result.currentVersion,
    latestVersion: result.latestVersion,
    releaseUrl: result.releaseUrl,
    releaseName: result.releaseName,
    publishedAt: result.publishedAt,
    installType,
    // [SEC-SF-004] Fixed string only. Never include dynamic path information.
    updateCommand: result.hasUpdate && installType === 'global'
      ? 'npm install -g commandmate@latest'
      : null,
  };
}

// =============================================================================
// Route Handler
// =============================================================================

/**
 * GET handler for /api/app/update-check
 * Next.js App Router automatically returns 405 for non-exported methods.
 */
export async function GET(): Promise<NextResponse<UpdateCheckResponse>> {
  try {
    const result = await checkForUpdate();
    const installType = detectInstallType();
    return buildResponse(toUpdateCheckResponse(result, installType));
  } catch {
    // Silent failure: return degraded response
    const installType = detectInstallType();
    return buildResponse(toUpdateCheckResponse(null, installType));
  }
}
