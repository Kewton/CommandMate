/**
 * POST /api/worktrees/[id]/skills/[skillId]/plan — build an Install Plan (Issue #1233)
 *
 * The request names *what* to install, never *where* or *from where*. The only
 * location input is the worktree ID, which is resolved against the database to
 * a trusted path; the only artifact input is the Skill ID and version, which are
 * resolved against the validated Catalog. A body carrying a filesystem path, an
 * artifact URL, a file list or a checksum is rejected outright rather than
 * ignored, so a client cannot discover that such a field is merely unused and
 * try a different spelling.
 *
 * An incompatible Skill or a conflicting destination still produces a plan: the
 * user is entitled to see why installing is refused. Such a plan simply reports
 * `installable: false` with typed blockers, and apply (#1235) declines to spend
 * its token.
 *
 * @module api/worktrees/[id]/skills/[skillId]/plan
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';
import { getSkillCatalog } from '@/lib/skills/catalog-client';
import {
  findSkillCatalogEntry,
  normalizeHostVersion,
  resolveSkillVersions,
} from '@/lib/skills/compatibility';
import { validateSkillId } from '@/lib/skills/schema';
import { downloadSkillArtifact } from '@/lib/skills/artifact-downloader';
import { isSkillFetchError } from '@/lib/skills/integrity';
import { inspectSkillPackage } from '@/lib/skills/package-validator';
import { isSkillPackageError } from '@/lib/skills/package-reader';
import {
  createSkillSnapshot,
  initSkillSnapshotStore,
  releaseSkillSnapshot,
} from '@/lib/skills/snapshot-store';
import {
  createSkillInstallPlan,
  isSkillPlanError,
  type SkillInstallPlanDto,
  type SkillPlanActor,
} from '@/lib/skills/install-plan';
import { ensureSkillPlanSweeper } from '@/lib/skills/plan-sweeper';
import { getServerVersion } from '@/lib/version-checker';
import { SKILL_API_NO_STORE_HEADERS, skillApiError } from '@/lib/api/skills-api';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/worktrees/[id]/skills/[skillId]/plan');

export interface SkillInstallPlanResponse {
  plan: SkillInstallPlanDto;
}

/**
 * Body fields a client must never be able to supply.
 *
 * Silently dropping them would leave the API looking like it accepts a path,
 * which is exactly the misunderstanding that leads to a write outside the
 * registered worktree.
 */
const REJECTED_BODY_KEYS = [
  'path',
  'paths',
  'worktreePath',
  'repositoryPath',
  'installRoot',
  'targetPath',
  'url',
  'artifactUrl',
  'artifact',
  'files',
  'checksum',
  'sha256',
  'snapshotId',
  'commit',
] as const;

const ALLOWED_BODY_KEYS = ['version', 'includePrerelease', 'acknowledgeRisk'] as const;

interface PlanRequestBody {
  version: string | null;
  includePrerelease: boolean;
  acknowledgeRisk: boolean;
}

type BodyResult = { ok: true; body: PlanRequestBody } | { ok: false; response: NextResponse };

async function readBody(request: NextRequest): Promise<BodyResult> {
  let raw: unknown = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) raw = JSON.parse(text);
  } catch {
    return { ok: false, response: skillApiError('SKILL_PLAN_INVALID_BODY', 'Malformed JSON body.', 400) };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      response: skillApiError('SKILL_PLAN_INVALID_BODY', 'Body must be a JSON object.', 400),
    };
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if ((REJECTED_BODY_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        response: skillApiError(
          'SKILL_PLAN_INPUT_REJECTED',
          'The install target is resolved by the server and cannot be supplied by the client.',
          400
        ),
      };
    }
    if (!(ALLOWED_BODY_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        response: skillApiError('SKILL_PLAN_INVALID_BODY', 'Unknown field in body.', 400),
      };
    }
  }

  const version = record.version;
  if (version !== undefined && typeof version !== 'string') {
    return {
      ok: false,
      response: skillApiError('SKILL_PLAN_INVALID_BODY', 'Field `version` must be a string.', 400),
    };
  }

  return {
    ok: true,
    body: {
      version: typeof version === 'string' ? version : null,
      includePrerelease: record.includePrerelease === true,
      acknowledgeRisk: record.acknowledgeRisk === true,
    },
  };
}

/**
 * Actor identity available to a single-token deployment.
 *
 * CommandMate authenticates one shared token, so there is no per-user id to
 * bind. The channel is still distinguished, because a plan issued to the
 * browser must not be spendable by a CLI run and vice versa.
 */
function resolveActor(request: NextRequest): SkillPlanActor {
  return { type: request.headers.get('authorization') ? 'cli' : 'user', id: null };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; skillId: string }> }
): Promise<NextResponse> {
  ensureSkillPlanSweeper();

  let snapshotId: string | null = null;
  try {
    const { id, skillId } = await params;

    const worktree = resolveWorktreeOr404(id);
    if (worktree instanceof NextResponse) return worktree;

    const idResult = validateSkillId(skillId);
    if (!idResult.ok) {
      return skillApiError(idResult.errors[0].code, 'Invalid Skill ID.', 400);
    }

    const parsed = await readBody(request);
    if (!parsed.ok) return parsed.response;

    const hostVersion = getServerVersion();
    const catalogResult = await getSkillCatalog({ hostVersion });
    if (!catalogResult.ok) {
      return skillApiError(catalogResult.failure.code, catalogResult.failure.message, 503);
    }

    const entry = findSkillCatalogEntry(catalogResult.snapshot.catalog, idResult.value);
    if (!entry) {
      return skillApiError('SKILL_NOT_FOUND', 'Skill not found in the official Catalog.', 404);
    }

    const resolution = resolveSkillVersions(entry, {
      currentVersion: normalizeHostVersion(hostVersion),
      includePrerelease: parsed.body.includePrerelease,
    });
    const selected = parsed.body.version
      ? resolution.versions.find((candidate) => candidate.version.version === parsed.body.version)
      : resolution.recommended;
    if (!selected) {
      return skillApiError(
        'SKILL_VERSION_NOT_FOUND',
        'No published version matches the request.',
        404
      );
    }

    // Bytes come from the Catalog-declared URL, verified against the declared
    // digest, and are then read only through the snapshot store.
    const download = await downloadSkillArtifact(idResult.value, selected.version);
    initSkillSnapshotStore();
    const handle = createSkillSnapshot({
      skillId: idResult.value,
      version: selected.version.version,
      commit: selected.version.source.commit,
      sha256: selected.version.artifact.sha256,
      bytes: download.bytes,
    });
    snapshotId = handle.snapshotId;

    const snapshot = inspectSkillPackage(download.bytes, {
      skillId: idResult.value,
      version: selected.version.version,
    });

    const record = await createSkillInstallPlan({
      actor: resolveActor(request),
      worktree: {
        id: worktree.id,
        name: worktree.name,
        path: worktree.path,
        repositoryName: worktree.repositoryDisplayName ?? worktree.repositoryName,
        syncedBranch: worktree.branch ?? null,
      },
      snapshot,
      version: selected.version,
      snapshotId: handle.snapshotId,
      compatibility: selected.compatibility,
      riskAcknowledged: parsed.body.acknowledgeRisk,
    });

    // Ownership of the snapshot reference has passed to the plan record.
    snapshotId = null;

    return NextResponse.json({ plan: record.dto }, { headers: SKILL_API_NO_STORE_HEADERS });
  } catch (error) {
    if (snapshotId) releaseSkillSnapshot(snapshotId);

    if (isSkillPlanError(error)) {
      return skillApiError(error.code, 'The install plan was rejected.', error.status);
    }
    if (isSkillPackageError(error)) {
      return skillApiError(error.code, 'The Skill package failed verification.', 422);
    }
    if (isSkillFetchError(error)) {
      return skillApiError(error.code, 'The Skill artifact could not be retrieved.', 502);
    }
    logger.error('skill-install-plan-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return skillApiError('SKILL_PLAN_INTERNAL_ERROR', 'Failed to build the install plan.', 500);
  }
}
