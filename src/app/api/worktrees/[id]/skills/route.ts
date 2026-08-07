/**
 * GET /api/worktrees/[id]/skills — list installed Skills in one worktree (Issue #1440)
 *
 * Read-only projection of the installed-Skill index (#1235). The worktree ID is
 * the only input; it is resolved against the database to a trusted worktree, and
 * the response carries only receipt/index-derived facts — never a machine-absolute
 * path or an artifact URL, matching the Catalog and install DTO policy (#1231).
 *
 * The index is a forward-converging cache of what the receipts say (#1234), and
 * since #1709 this route reads *through* it rather than treating it as the
 * truth: it lists the Skill directories of the one worktree it was asked about
 * and converges the index onto their receipts before answering. That is what
 * makes a Skill installed by another instance — another database — visible here
 * instead of silently absent.
 *
 * Since #1753 that convergence covers a row that is *wrong*, not just one that
 * is missing. A row left stale made this route and the update route disagree
 * inside one server: the list served the indexed version, the client offered an
 * update to a version the receipt already had, and the update route — which
 * reads the receipt — rejected it as not newer. The read costs one receipt read
 * and one digest per installed Skill; a receipt that hashes to what the row
 * recorded is neither parsed nor written, so this stays the cheap read the
 * #1441/#1442 UIs consume to show "what is installed here".
 *
 * @module api/worktrees/[id]/skills
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId, resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';
import { listSkillInstallations } from '@/lib/skills/installed-state';
import type { SkillInstallationRecord } from '@/lib/skills/installed-state';
import { restoreSkillInstallationIndex } from '@/lib/skills/reindex';
import { invalidateSkillStatusScanCache } from '@/lib/skills/status-scanner';
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
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);

    const worktree = resolveWorktreeOr404(id);
    if (worktree instanceof NextResponse) return worktree;

    const db = getDbInstance();

    // Read-through, because the index is a cache and the receipt is the truth
    // (#1235). The cache lives in one database; the receipt lives inside the
    // worktree and is repository-relative, so a Skill installed by another
    // instance — or by this one before its database was replaced — is on disk
    // with no row behind it, and a Skill written on disk out of band leaves a
    // row that names a version nobody has. Answering from the cache alone
    // reported the first as "nothing is installed" (#1709) and the second as an
    // update that can never apply (#1753). Converging first is what makes this
    // route and the update route give the same answer.
    try {
      const restored = restoreSkillInstallationIndex(db, worktree);
      if (restored.indexed > 0) {
        // The dashboard reads a cached cross-worktree scan; serving the
        // pre-restore one back would keep calling these installs `unmanaged`
        // — or keep showing the version the stale row named.
        invalidateSkillStatusScanCache();
        logger.info('skill-installed-index-restored', {
          worktreeId: worktree.id,
          indexed: restored.indexed,
          // Non-zero means disk was written without going through this server.
          converged: restored.converged,
          skipped: restored.skipped.length,
        });
      }
    } catch (error) {
      // A repair that fails must not take the read down with it: the index is
      // still an answer, just possibly a short one.
      logger.warn('skill-installed-index-restore-failed', {
        worktreeId: worktree.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

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
