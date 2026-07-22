/**
 * GET /api/skills/[id] - one official Skill (Issue #1231)
 *
 * The path segment is validated against the Skill ID grammar before it is used
 * to look anything up, so a malformed or reserved ID is rejected as 400 rather
 * than silently becoming a miss. This route never touches the filesystem: the
 * ID only ever indexes the in-memory Catalog.
 *
 * @module api/skills/[id]
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { getSkillCatalog } from '@/lib/skills/catalog-client';
import { findSkillCatalogEntry, normalizeHostVersion } from '@/lib/skills/compatibility';
import { validateSkillId } from '@/lib/skills/schema';
import { getServerVersion } from '@/lib/version-checker';
import {
  SKILL_API_NO_STORE_HEADERS,
  readPrereleaseFlag,
  skillApiError,
  toCatalogMetaDto,
  toSkillDto,
  type SkillApiErrorResponse,
  type SkillDetailResponse,
} from '@/lib/api/skills-api';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/skills/[id]');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<SkillDetailResponse | SkillApiErrorResponse>> {
  try {
    const { id } = await params;

    const idResult = validateSkillId(id);
    if (!idResult.ok) {
      return skillApiError(idResult.errors[0].code, 'Invalid Skill ID.', 400);
    }

    const hostVersion = getServerVersion();
    const includePrerelease = readPrereleaseFlag(new URL(request.url));

    const result = await getSkillCatalog({ hostVersion });
    if (!result.ok) {
      return skillApiError(result.failure.code, result.failure.message, 503);
    }

    const snapshot = result.snapshot;
    const entry = findSkillCatalogEntry(snapshot.catalog, idResult.value);
    if (!entry) {
      return skillApiError('SKILL_NOT_FOUND', 'Skill not found in the official Catalog.', 404);
    }

    const body: SkillDetailResponse = {
      catalog: toCatalogMetaDto(snapshot),
      skill: toSkillDto(entry, {
        currentVersion: normalizeHostVersion(hostVersion),
        includePrerelease,
      }),
    };

    return NextResponse.json(body, { headers: SKILL_API_NO_STORE_HEADERS });
  } catch (error) {
    logger.error('skill-catalog-detail-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return skillApiError('SKILL_CATALOG_INTERNAL_ERROR', 'Failed to load the Skill Catalog.', 500);
  }
}
