/**
 * POST /api/worktrees/[id]/skills/[skillId]/update-plan — build an Update Plan
 * (Issue #1243)
 *
 * The request names *what* to update and *which version to move to*, never
 * where or from where. The worktree ID is resolved against the database to a
 * trusted path, the installed version is read from the on-disk receipt, and
 * the candidate is resolved against the validated Catalog — then downloaded
 * and put through exactly the same source/checksum/archive verification as an
 * install (#1229/#1230). A body carrying a filesystem path, an artifact URL, a
 * file list or a checksum is rejected outright rather than ignored.
 *
 * A blocked plan is still a plan: local changes, receipt problems and
 * incompatibilities are reported as typed blockers with `updatable: false`,
 * and apply (#1244) declines to spend such a token. This route never writes.
 *
 * @module api/worktrees/[id]/skills/[skillId]/update-plan
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId, resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';
import { SKILL_PRIMARY_INSTALL_ROOT_PREFIX } from '@/lib/skills/constants';
import { getSkillCatalog } from '@/lib/skills/catalog-client';
import { findSkillCatalogEntry, normalizeHostVersion } from '@/lib/skills/compatibility';
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
import { isSkillPlanError, type SkillPlanActor } from '@/lib/skills/install-plan';
import { readSkillGitTargetState } from '@/lib/skills/preview-diff';
import {
  findSkillUpdateCandidate,
  resolveSkillUpdateAvailability,
} from '@/lib/skills/version-resolver';
import {
  createSkillUpdatePlan,
  readInstalledSkillReceipt,
  type SkillUpdatePlanDto,
} from '@/lib/skills/update-plan';
import { ensureSkillPlanSweeper } from '@/lib/skills/plan-sweeper';
import { getServerVersion } from '@/lib/version-checker';
import { SKILL_API_NO_STORE_HEADERS, skillApiError } from '@/lib/api/skills-api';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/worktrees/[id]/skills/[skillId]/update-plan');

export interface SkillUpdatePlanResponse {
  plan: SkillUpdatePlanDto;
}

/**
 * Body fields a client must never be able to supply. Mirrors the install plan
 * route (#1233): silently dropping them would leave the API looking like it
 * accepts a path or an artifact coordinate.
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
  'receipt',
  'receiptDigest',
  /** There is no forced update over local changes; naming it beats ignoring it. */
  'force',
] as const;

const ALLOWED_BODY_KEYS = ['version', 'includePrerelease', 'range'] as const;

interface UpdatePlanRequestBody {
  version: string | null;
  includePrerelease: boolean;
  range: string | undefined;
}

type BodyResult = { ok: true; body: UpdatePlanRequestBody } | { ok: false; response: NextResponse };

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
          'The update target is resolved by the server and cannot be supplied by the client.',
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
  const range = record.range;
  if (range !== undefined && typeof range !== 'string') {
    return {
      ok: false,
      response: skillApiError('SKILL_PLAN_INVALID_BODY', 'Field `range` must be a string.', 400),
    };
  }

  return {
    ok: true,
    body: {
      version: typeof version === 'string' ? version : null,
      includePrerelease: record.includePrerelease === true,
      range: typeof range === 'string' ? range : undefined,
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

/** HTTP answer for a receipt that cannot anchor an update. */
const RECEIPT_READ_FAILURES: Record<string, { code: string; message: string; status: number }> = {
  not_installed: {
    code: 'SKILL_UPDATE_NOT_INSTALLED',
    message: 'No installed Skill was found to update.',
    status: 404,
  },
  receipt_missing: {
    code: 'SKILL_UPDATE_RECEIPT_MISSING',
    message: 'The install carries no CommandMate receipt, so its version is unknowable.',
    status: 409,
  },
  receipt_unreadable: {
    code: 'SKILL_UPDATE_RECEIPT_UNREADABLE',
    message: 'The install receipt could not be read, so its version is unknowable.',
    status: 409,
  },
  receipt_foreign: {
    code: 'SKILL_UPDATE_RECEIPT_FOREIGN',
    message: 'The install receipt describes a different Skill.',
    status: 409,
  },
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; skillId: string }> }
): Promise<NextResponse> {
  ensureSkillPlanSweeper();

  let snapshotId: string | null = null;
  try {
    const { id: requestedWorktreeId, skillId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);

    const worktree = resolveWorktreeOr404(id);
    if (worktree instanceof NextResponse) return worktree;

    const idResult = validateSkillId(skillId);
    if (!idResult.ok) {
      return skillApiError(idResult.errors[0].code, 'Invalid Skill ID.', 400);
    }

    const parsed = await readBody(request);
    if (!parsed.ok) return parsed.response;

    // The installed exact version comes from the on-disk receipt, never from
    // the client and never from the index: evidence, not a claim.
    const installed = readInstalledSkillReceipt(
      worktree.path,
      idResult.value,
      SKILL_PRIMARY_INSTALL_ROOT_PREFIX
    );
    if (installed.state !== 'ok') {
      const failure = RECEIPT_READ_FAILURES[installed.state];
      return skillApiError(failure.code, failure.message, failure.status);
    }

    const hostVersion = getServerVersion();
    const catalogResult = await getSkillCatalog({ hostVersion });
    if (!catalogResult.ok) {
      return skillApiError(catalogResult.failure.code, catalogResult.failure.message, 503);
    }

    const entry = findSkillCatalogEntry(catalogResult.snapshot.catalog, idResult.value);
    if (!entry) {
      return skillApiError('SKILL_NOT_FOUND', 'Skill not found in the official Catalog.', 404);
    }

    const availability = resolveSkillUpdateAvailability(entry, installed.receipt.version, {
      currentVersion: normalizeHostVersion(hostVersion),
      includePrerelease: parsed.body.includePrerelease,
      range: parsed.body.range,
    });
    const selected = parsed.body.version
      ? findSkillUpdateCandidate(availability, parsed.body.version)
      : availability.recommended;
    if (!selected) {
      // The reason code names why nothing is offerable: up to date, none
      // compatible, unparsable installed version or unsupported range — or an
      // explicit version that is not a strictly newer published one.
      //
      // The rejected request names both versions (#1753). A client that offered
      // this update was reading an installed version from somewhere, and when
      // that somewhere disagreed with the receipt the bare "not strictly newer"
      // read as "you are already up to date" while the screen still showed an
      // update button. Naming the receipt's version makes the disagreement
      // legible in the response and in the logs of whoever hits it next.
      return skillApiError(
        parsed.body.version ? 'SKILL_UPDATE_VERSION_NOT_ELIGIBLE' : availability.reasonCode,
        parsed.body.version
          ? `The requested version ${parsed.body.version} is not a strictly newer published ` +
            `version of this Skill: the install receipt on disk records ${installed.receipt.version}.`
          : 'No update candidate can be offered for this install.',
        404
      );
    }

    // The candidate bytes come from the Catalog-declared URL, verified against
    // the declared digest, then read only through the snapshot store — the
    // same #1229 gate an install passes.
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

    const git = await readSkillGitTargetState(worktree.path);
    const record = createSkillUpdatePlan({
      actor: resolveActor(request),
      worktree: {
        id: worktree.id,
        name: worktree.name,
        path: worktree.path,
        repositoryName: worktree.repositoryDisplayName ?? worktree.repositoryName,
      },
      skillId: idResult.value,
      fromVersion: installed.receipt.version,
      snapshot,
      version: selected.version,
      snapshotId: handle.snapshotId,
      compatibility: selected.compatibility,
      catalogEntry: entry,
      latestVersion: availability.latestVersion,
      reasonCode: availability.reasonCode,
      prerelease: selected.prerelease,
      git,
    });

    // Ownership of the snapshot reference has passed to the plan record.
    snapshotId = null;

    return NextResponse.json({ plan: record.dto }, { headers: SKILL_API_NO_STORE_HEADERS });
  } catch (error) {
    if (snapshotId) releaseSkillSnapshot(snapshotId);

    if (isSkillPlanError(error)) {
      return skillApiError(
        error.code === 'SKILL_PLAN_NOT_FOUND' ? 'SKILL_UPDATE_NOT_INSTALLED' : error.code,
        'The update plan was rejected.',
        error.code === 'SKILL_PLAN_NOT_FOUND' ? 404 : error.status
      );
    }
    if (isSkillPackageError(error)) {
      return skillApiError(error.code, 'The Skill package failed verification.', 422);
    }
    if (isSkillFetchError(error)) {
      return skillApiError(error.code, 'The Skill artifact could not be retrieved.', 502);
    }
    logger.error('skill-update-plan-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return skillApiError('SKILL_UPDATE_PLAN_INTERNAL_ERROR', 'Failed to build the update plan.', 500);
  }
}
