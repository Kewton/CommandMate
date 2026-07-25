/**
 * GET /api/fs/browse — list directories the operator may register (Issue #1517).
 *
 * This is the only endpoint that exposes the server's filesystem layout, so it
 * is deliberately restrictive: authenticated, rate limited, confined to the
 * allowed roots, and directories only — never file names.
 *
 * Without `path` it returns the allowed roots themselves, so the picker has a
 * top level to start from and cannot navigate above a root.
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import path from 'path';
import { existsSync, statSync } from 'fs';
import { isApiRequestAuthenticated } from '@/lib/api/api-auth';
import { createRequestRateLimiter } from '@/lib/security/request-rate-limiter';
import { getClientIp } from '@/lib/security/ip-restriction';
import {
  resolveAllowedPath,
  getAllowedBrowseRoots,
  formatAllowedRoots,
  BROWSE_ENTRY_LIMIT,
} from '@/lib/fs/browse-roots';
import {
  listDirectories,
  isGitRepositoryPath,
  type BrowseEntry,
} from '@/lib/fs/browse-directory';
import { getDbInstance } from '@/lib/db/db-instance';
import { getRecentBrowsePaths } from '@/lib/db/app-settings-db';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/fs-browse');

/** Per-IP budget: generous enough for click-through navigation, not for a sweep. */
const rateLimiter = createRequestRateLimiter({ limit: 120, windowMs: 60_000 });

function describeRoot(root: string): BrowseEntry {
  const isGitRepo = isGitRepositoryPath(root);
  return {
    // Roots are shown by full path: their base names ("repos", "work") are not
    // distinguishable enough when several roots are configured.
    name: root,
    path: root,
    isGitRepo,
    worktreeCount: null,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isApiRequestAuthenticated(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const clientIp = getClientIp(request.headers) ?? 'unknown';
  const limit = rateLimiter.check(clientIp);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter ?? 60) } }
    );
  }

  try {
    const recentPaths = readRecentPaths();
    const requestedPath = request.nextUrl.searchParams.get('path');

    if (requestedPath === null || requestedPath.trim() === '') {
      const roots = getAllowedBrowseRoots();
      return NextResponse.json({
        path: null,
        parent: null,
        roots,
        recentPaths,
        entries: roots.filter((root) => existsSync(root)).map(describeRoot),
        truncated: false,
        entryLimit: BROWSE_ENTRY_LIMIT,
      });
    }

    const resolved = resolveAllowedPath(requestedPath);
    if (!resolved.ok) {
      // The reason is logged, the path is not: an absolute path in the log is a
      // durable record of the operator's directory layout.
      logger.warn('fs-browse:rejected', { reason: resolved.reason });
      return NextResponse.json(
        {
          error: `Path is outside the allowed roots. Allowed roots: ${formatAllowedRoots(resolved.roots)}`,
          reason: resolved.reason,
          roots: resolved.roots,
        },
        { status: 400 }
      );
    }

    if (!existsSync(resolved.resolvedPath) || !statSync(resolved.resolvedPath).isDirectory()) {
      return NextResponse.json({ error: 'Directory not found' }, { status: 404 });
    }

    const { entries, truncated } = listDirectories(resolved.resolvedPath, resolved.root);

    return NextResponse.json({
      path: resolved.resolvedPath,
      // null at a root, so the picker cannot walk above it.
      parent:
        resolved.resolvedPath === resolved.root
          ? null
          : path.dirname(resolved.resolvedPath),
      roots: resolved.roots,
      recentPaths,
      entries,
      truncated,
      entryLimit: BROWSE_ENTRY_LIMIT,
    });
  } catch (error) {
    logger.error('fs-browse:failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to list directory' }, { status: 500 });
  }
}

/**
 * Recently used directories, dropped when they no longer resolve — the allowed
 * roots can shrink after a path was stored.
 */
function readRecentPaths(): string[] {
  try {
    return getRecentBrowsePaths(getDbInstance()).filter(
      (candidate) => resolveAllowedPath(candidate).ok
    );
  } catch {
    return [];
  }
}
