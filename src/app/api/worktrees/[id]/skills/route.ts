/**
 * GET /api/worktrees/[id]/skills — list installed Skills in one worktree (Issue #1440)
 *
 * Read-only projection of the installed-Skill index (#1235). The worktree ID is
 * the only input; it is resolved against the database to a trusted worktree, and
 * the response carries only receipt/index-derived facts — never a machine-absolute
 * path or an artifact URL, matching the Catalog and install DTO policy (#1231).
 *
 * The index is a forward-converging cache of what the receipts say (#1234); this
 * route reports the index as-is and does not walk the filesystem, so it is the
 * cheap read the #1441/#1442 UIs consume to show "what is installed here".
 *
 * @module api/worktrees/[id]/skills
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { getDbInstance } from '@/lib/db/db-instance';
import { resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';
import { listSkillInstallations } from '@/lib/skills/installed-state';
import type { SkillInstallationRecord } from '@/lib/skills/installed-state';
import { SKILL_API_NO_STORE_HEADERS, skillApiError } from '@/lib/api/skills-api';
import type { SkillRiskLevel } from '@/types/skills';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/worktrees/[id]/skills');

/**
 * One installed Skill as served to clients.
 *
 * Provenance and receipt facts only. `installRoot` is repository-relative
 * (`.agents/skills/<id>`); no machine-absolute path and no artifact URL is ever
 * included, so the shape a client sees can never name where on disk the server
 * lives or where the bytes came from.
 */
export interface InstalledSkillDto {
  skillId: string;
  version: string;
  /** Repository-relative install root, always `.agents/skills/<skill-id>`. */
  installRoot: string;
  /** Digest of the exact receipt bytes on disk. */
  receiptSha256: string;
  /** Digest of the verified artifact the receipt was written from. */
  artifactSha256: string;
  source: {
    repository: string;
    ref: string;
    /** Resolved 40-hex commit SHA — the trusted per-release coordinate. */
    commit: string;
  };
  /** The higher of declared and computed risk, as recorded at install time. */
  effectiveRisk: SkillRiskLevel;
  /** Epoch millis the install first committed. */
  installedAt: number;
  /** Epoch millis the index row last converged. */
  updatedAt: number;
}

export interface InstalledSkillListResponse {
  worktreeId: string;
  skills: InstalledSkillDto[];
}

function toInstalledSkillDto(record: SkillInstallationRecord): InstalledSkillDto {
  return {
    skillId: record.skillId,
    version: record.version,
    installRoot: record.installRoot,
    receiptSha256: record.receiptSha256,
    artifactSha256: record.artifactSha256,
    source: {
      repository: record.sourceRepository,
      ref: record.sourceRef,
      commit: record.sourceCommit,
    },
    effectiveRisk: record.effectiveRisk,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;

    const worktree = resolveWorktreeOr404(id);
    if (worktree instanceof NextResponse) return worktree;

    const db = getDbInstance();
    const records = listSkillInstallations(db, worktree.id);

    const response: InstalledSkillListResponse = {
      worktreeId: worktree.id,
      skills: records.map(toInstalledSkillDto),
    };
    return NextResponse.json(response, { headers: SKILL_API_NO_STORE_HEADERS });
  } catch (error) {
    logger.error('skill-installed-list-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return skillApiError(
      'SKILL_INSTALLED_LIST_INTERNAL_ERROR',
      'Failed to list installed Skills.',
      500
    );
  }
}
