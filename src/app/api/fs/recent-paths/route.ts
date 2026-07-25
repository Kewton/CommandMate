/**
 * POST /api/fs/recent-paths — remember a directory the picker just selected
 * (Issue #1517), so the picker reopens where the operator left off.
 *
 * Reads go through `GET /api/fs/browse`, which already returns `recentPaths`
 * alongside the roots.
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { isApiRequestAuthenticated } from '@/lib/api/api-auth';
import { resolveAllowedPath } from '@/lib/fs/browse-roots';
import { getDbInstance } from '@/lib/db/db-instance';
import { addRecentBrowsePath } from '@/lib/db/app-settings-db';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/fs-recent-paths');

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isApiRequestAuthenticated(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body: unknown = await request.json().catch(() => null);
    const candidate =
      body && typeof body === 'object' && 'path' in body
        ? (body as { path: unknown }).path
        : undefined;

    // Storing an unvalidated path would let a caller write arbitrary strings
    // into app_settings and have them echoed back by the browse endpoint.
    const resolved = resolveAllowedPath(candidate);
    if (!resolved.ok) {
      logger.warn('recent-paths:rejected', { reason: resolved.reason });
      return NextResponse.json(
        { error: 'Path is outside the allowed roots' },
        { status: 400 }
      );
    }

    addRecentBrowsePath(getDbInstance(), resolved.resolvedPath);

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('recent-paths:failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to save recent path' }, { status: 500 });
  }
}
