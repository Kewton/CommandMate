/**
 * POST /api/skills/reindex — rebuild the installed-Skill index from receipts (Issue #1248)
 *
 * The recovery path for a database that was deleted, restored from an older
 * backup, or otherwise fell behind the filesystem. It reads only receipts inside
 * registered worktrees and writes only the index; the payload is never touched
 * and the append-only operation log is never appended to, because re-indexing
 * restores a record — it does not perform an operation.
 *
 * POST rather than GET because it writes, even though what it writes is derived.
 * The request body carries nothing: there is no client-supplied path to honour,
 * and the set of worktrees to visit is the registry's answer, not the caller's.
 *
 * @module api/skills/reindex
 */

import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { getDbInstance } from '@/lib/db/db-instance';
import { SKILL_API_NO_STORE_HEADERS, skillApiError } from '@/lib/api/skills-api';
import { reindexSkillInstallations } from '@/lib/skills/reindex';
import type { SkillReindexResult } from '@/lib/skills/reindex';
import { invalidateSkillStatusScanCache } from '@/lib/skills/status-scanner';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/skills/reindex');

export type SkillReindexResponse = SkillReindexResult;

export async function POST(): Promise<NextResponse> {
  try {
    const result = reindexSkillInstallations(getDbInstance());

    // The dashboard reads a cached scan; serving the pre-rebuild one back would
    // make a successful re-index look like it did nothing.
    invalidateSkillStatusScanCache();

    logger.info('skill-reindex-completed', {
      scannedWorktrees: result.scannedWorktrees,
      indexed: result.indexed,
      removed: result.removed,
      skipped: result.skipped.length,
    });
    return NextResponse.json(result, { headers: SKILL_API_NO_STORE_HEADERS });
  } catch (error) {
    logger.error('skill-reindex-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return skillApiError(
      'SKILL_REINDEX_INTERNAL_ERROR',
      'Failed to rebuild the installed Skill index.',
      500
    );
  }
}
