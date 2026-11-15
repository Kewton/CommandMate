/**
 * GET /api/settings/sessions-filter — the saved /sessions default filter
 * PUT /api/settings/sessions-filter — save it
 *
 * Issue #4388. Modeled on `../default-surface-mode/route.ts`. GET returns the
 * stored value as is (roles deleted since are NOT removed here; the apply
 * function in `@/lib/sessions-default-filter` does that and reports it).
 */
export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getSessionsDefaultFilter, setSessionsDefaultFilter } from '@/lib/db/app-settings-db';
import { validateSessionsFilter } from '@/lib/sessions-default-filter';
import { EMPTY_SESSIONS_FILTER } from '@/types/sessions-default-filter';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/settings/sessions-filter');

function buildBody() {
  const stored = getSessionsDefaultFilter(getDbInstance());
  return {
    success: true as const,
    filter: stored ?? { ...EMPTY_SESSIONS_FILTER, roleIds: [] },
    /** false means nothing is saved. */
    configured: stored !== null,
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(buildBody(), { status: 200 });
  } catch (error) {
    logger.error('get-sessions-filter-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const body: unknown = await request.json().catch(() => null);
    const result = validateSessionsFilter(body);
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }
    setSessionsDefaultFilter(getDbInstance(), result.value);
    logger.info('sessions-filter-updated', { roleCount: result.value.roleIds.length });
    return NextResponse.json(buildBody(), { status: 200 });
  } catch (error) {
    logger.error('put-sessions-filter-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
