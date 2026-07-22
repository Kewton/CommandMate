/**
 * GET /api/skills - official Skill Catalog listing (Issue #1231)
 *
 * Read-only. The Catalog endpoint is a server-side constant, so no request
 * input selects what is fetched; `?prerelease=true` only widens which already
 * fetched versions are listed.
 *
 * Status contract:
 * - 200 with `catalog.stale = false` — the Catalog was confirmed current.
 * - 200 with `catalog.stale = true`  — last known good, explicitly marked
 *   stale/offline with a reason (UX-07). Never presented as fresh.
 * - 503 — retrieval failed and there is no validated Catalog to fall back on.
 *   An empty list is deliberately not returned here: "no Skills exist" and
 *   "the Catalog is unreachable" must not look alike.
 *
 * @module api/skills
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { getSkillCatalog } from '@/lib/skills/catalog-client';
import { normalizeHostVersion } from '@/lib/skills/compatibility';
import { getServerVersion } from '@/lib/version-checker';
import {
  SKILL_API_NO_STORE_HEADERS,
  readPrereleaseFlag,
  skillApiError,
  toCatalogMetaDto,
  toSkillDto,
  type SkillApiErrorResponse,
  type SkillListResponse,
} from '@/lib/api/skills-api';

// Without this the route is prerendered at build time and the Catalog fetch
// would be frozen into the build output (same reason as api/app/update-check).
export const dynamic = 'force-dynamic';

const logger = createLogger('api/skills');

export async function GET(
  request: NextRequest
): Promise<NextResponse<SkillListResponse | SkillApiErrorResponse>> {
  try {
    const hostVersion = getServerVersion();
    const includePrerelease = readPrereleaseFlag(new URL(request.url));

    const result = await getSkillCatalog({ hostVersion });
    if (!result.ok) {
      return skillApiError(result.failure.code, result.failure.message, 503);
    }

    const currentVersion = normalizeHostVersion(hostVersion);
    const snapshot = result.snapshot;

    const body: SkillListResponse = {
      catalog: toCatalogMetaDto(snapshot),
      skills: snapshot.catalog.entries.map((entry) =>
        toSkillDto(entry, { currentVersion, includePrerelease })
      ),
    };

    return NextResponse.json(body, { headers: SKILL_API_NO_STORE_HEADERS });
  } catch (error) {
    logger.error('skill-catalog-list-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return skillApiError('SKILL_CATALOG_INTERNAL_ERROR', 'Failed to load the Skill Catalog.', 500);
  }
}
