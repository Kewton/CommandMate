/**
 * POST /api/repositories/validate-path — pre-flight check for the Local Path
 * form (Issue #1517).
 *
 * Before this endpoint, a path outside `CM_ROOT_DIR` produced an unexplained
 * 400 only after the user pressed "Scan & Add", which reads as "my path is
 * wrong" rather than "this location is out of scope". It answers the same
 * question `scan` will answer, through the same `resolveAllowedPath()`, so the
 * two can never disagree.
 *
 * Issue #1662: it also answers "is this the same git repository as something I
 * already scan?". That is a WARNING, never a rejection — `valid` stays true and
 * the response shape is unchanged for the non-duplicate case, so nothing here
 * can stop a registration. Deliberately independent of the scan route: a user
 * who wants two worktrees of one repository managed as separate scan roots is
 * doing something legitimate, and the app's job is to make sure they know.
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { existsSync, statSync } from 'fs';
import { isApiRequestAuthenticated } from '@/lib/api/api-auth';
import { createRequestRateLimiter } from '@/lib/security/request-rate-limiter';
import { getClientIp } from '@/lib/security/ip-restriction';
import { resolveAllowedPath, formatAllowedRoots } from '@/lib/fs/browse-roots';
import { countWorktrees, isGitRepositoryPath } from '@/lib/fs/browse-directory';
import { getDbInstance } from '@/lib/db/db-instance';
import { getAllRepositories } from '@/lib/db/db-repository';
import { findScanRootsSharingGitRepository } from '@/lib/git/git-common-dir';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/repositories-validate-path');

/** Typing-driven, so the budget is higher than browse's click-driven one. */
const rateLimiter = createRequestRateLimiter({ limit: 180, windowMs: 60_000 });

/**
 * Already-registered scan roots that are the SAME git repository as
 * `candidatePath` (Issue #1662).
 *
 * Only ENABLED rows are compared, matching `GET /api/repositories`: a root the
 * user has already excluded from scans is not being scanned, so adding a
 * sibling worktree of it does not create a double-scan. Warning about it would
 * be exactly the false positive the acceptance criteria forbid.
 *
 * Never throws. Duplicate detection is advisory; if the DB or git is
 * unavailable the caller must still be able to register the path, so a failure
 * degrades to "no duplicates known" rather than to a 500.
 */
async function listDuplicateScanRoots(candidatePath: string): Promise<string[]> {
  try {
    const enabledPaths = getAllRepositories(getDbInstance())
      .filter((repo) => repo.enabled)
      .map((repo) => repo.path);

    return await findScanRootsSharingGitRepository(candidatePath, enabledPaths);
  } catch (error) {
    logger.debug('validate-path:duplicate-check-skipped', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
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
    const body: unknown = await request.json().catch(() => null);
    const repositoryPath =
      body && typeof body === 'object' && 'repositoryPath' in body
        ? (body as { repositoryPath: unknown }).repositoryPath
        : undefined;

    const resolved = resolveAllowedPath(repositoryPath);

    if (!resolved.ok) {
      logger.debug('validate-path:rejected', { reason: resolved.reason });
      return NextResponse.json({
        valid: false,
        reason: resolved.reason,
        roots: resolved.roots,
        allowedRootsLabel: formatAllowedRoots(resolved.roots),
        isGitRepo: false,
        worktreeCount: null,
      });
    }

    if (!existsSync(resolved.resolvedPath) || !statSync(resolved.resolvedPath).isDirectory()) {
      return NextResponse.json({
        valid: false,
        reason: 'not-found',
        roots: resolved.roots,
        allowedRootsLabel: formatAllowedRoots(resolved.roots),
        isGitRepo: false,
        worktreeCount: null,
      });
    }

    const isGitRepo = isGitRepositoryPath(resolved.resolvedPath);

    return NextResponse.json({
      valid: true,
      resolvedPath: resolved.resolvedPath,
      roots: resolved.roots,
      allowedRootsLabel: formatAllowedRoots(resolved.roots),
      isGitRepo,
      worktreeCount: isGitRepo ? countWorktrees(resolved.resolvedPath) : null,
      duplicateScanRoots: isGitRepo
        ? await listDuplicateScanRoots(resolved.resolvedPath)
        : [],
    });
  } catch (error) {
    logger.error('validate-path:failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to validate path' }, { status: 500 });
  }
}
