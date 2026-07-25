/**
 * POST /api/repositories/validate-path — pre-flight check for the Local Path
 * form (Issue #1517).
 *
 * Before this endpoint, a path outside `CM_ROOT_DIR` produced an unexplained
 * 400 only after the user pressed "Scan & Add", which reads as "my path is
 * wrong" rather than "this location is out of scope". It answers the same
 * question `scan` will answer, through the same `resolveAllowedPath()`, so the
 * two can never disagree.
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { existsSync, statSync } from 'fs';
import { isApiRequestAuthenticated } from '@/lib/api/api-auth';
import { createRequestRateLimiter } from '@/lib/security/request-rate-limiter';
import { getClientIp } from '@/lib/security/ip-restriction';
import { resolveAllowedPath, formatAllowedRoots } from '@/lib/fs/browse-roots';
import { countWorktrees, isGitRepositoryPath } from '@/lib/fs/browse-directory';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/repositories-validate-path');

/** Typing-driven, so the budget is higher than browse's click-driven one. */
const rateLimiter = createRequestRateLimiter({ limit: 180, windowMs: 60_000 });

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
    });
  } catch (error) {
    logger.error('validate-path:failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to validate path' }, { status: 500 });
  }
}
