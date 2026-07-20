/**
 * POST /api/worktrees/[id]/skills/[skillId]/uninstall-plan — preview a removal (Issue #1236)
 *
 * The request names *what* to uninstall and nothing else. The worktree ID is
 * resolved against the database to a trusted path and the install root is
 * derived from it, so — exactly as in #1233 — a body carrying a filesystem path
 * or a file list is rejected outright rather than ignored.
 *
 * A blocked plan is still a plan. The user asked to remove a Skill and is
 * entitled to see *which* file stops that from being safe: a locally edited
 * SKILL.md, a note they left in the directory, a symlink that appeared. Apply
 * (see the sibling `uninstall` route) refuses to spend such a token, so the
 * preview can never turn into a delete by accident.
 *
 * @module api/worktrees/[id]/skills/[skillId]/uninstall-plan
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';
import { validateSkillId } from '@/lib/skills/schema';
import { isSkillPlanError, type SkillPlanActor } from '@/lib/skills/install-plan';
import { readSkillGitTargetState } from '@/lib/skills/preview-diff';
import {
  createSkillUninstallPlan,
  type SkillUninstallPlanDto,
} from '@/lib/skills/uninstall-plan';
import {
  isSkillUninstallError,
  resolveSkillUninstallTarget,
} from '@/lib/skills/uninstall-apply';
import { ensureSkillPlanSweeper } from '@/lib/skills/plan-sweeper';
import { SKILL_API_NO_STORE_HEADERS, skillApiError } from '@/lib/api/skills-api';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/worktrees/[id]/skills/[skillId]/uninstall-plan');

export interface SkillUninstallPlanResponse {
  plan: SkillUninstallPlanDto;
}

/** Fields a client must never be able to supply. Mirrors the install plan route. */
const REJECTED_BODY_KEYS = [
  'path',
  'paths',
  'worktreePath',
  'repositoryPath',
  'installRoot',
  'targetPath',
  'files',
  'checksum',
  'sha256',
  'receipt',
  'receiptDigest',
  /** There is no force in the MVP; naming it explicitly beats ignoring it. */
  'force',
] as const;

/**
 * Actor identity available to a single-token deployment.
 *
 * CommandMate authenticates one shared token, so there is no per-user id to
 * bind. The channel is still distinguished, because a plan issued to the browser
 * must not be spendable by a CLI run and vice versa.
 */
function resolveActor(request: NextRequest): SkillPlanActor {
  return { type: request.headers.get('authorization') ? 'cli' : 'user', id: null };
}

async function rejectUnsupportedBody(request: NextRequest): Promise<NextResponse | null> {
  let raw: unknown = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) raw = JSON.parse(text);
  } catch {
    return skillApiError('SKILL_UNINSTALL_INVALID_BODY', 'Malformed JSON body.', 400);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return skillApiError('SKILL_UNINSTALL_INVALID_BODY', 'Body must be a JSON object.', 400);
  }
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.some((key) => (REJECTED_BODY_KEYS as readonly string[]).includes(key))) {
    return skillApiError(
      'SKILL_PLAN_INPUT_REJECTED',
      'The uninstall target is resolved by the server and cannot be supplied by the client.',
      400
    );
  }
  // The plan takes no parameters at all: what to remove is fully determined by
  // the route, so any other field is a misunderstanding worth reporting.
  if (keys.length > 0) {
    return skillApiError('SKILL_UNINSTALL_INVALID_BODY', 'Unknown field in body.', 400);
  }
  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; skillId: string }> }
): Promise<NextResponse> {
  ensureSkillPlanSweeper();

  try {
    const { id, skillId } = await params;

    const worktree = resolveWorktreeOr404(id);
    if (worktree instanceof NextResponse) return worktree;

    const idResult = validateSkillId(skillId);
    if (!idResult.ok) return skillApiError(idResult.errors[0].code, 'Invalid Skill ID.', 400);

    const rejected = await rejectUnsupportedBody(request);
    if (rejected) return rejected;

    const installRootAbs = resolveSkillUninstallTarget(worktree.path, idResult.value);
    const git = await readSkillGitTargetState(worktree.path);

    const record = createSkillUninstallPlan({
      actor: resolveActor(request),
      worktree: {
        id: worktree.id,
        name: worktree.name,
        path: worktree.path,
        repositoryName: worktree.repositoryDisplayName ?? worktree.repositoryName,
      },
      skillId: idResult.value,
      installRootAbs,
      git,
    });

    return NextResponse.json({ plan: record.dto }, { headers: SKILL_API_NO_STORE_HEADERS });
  } catch (error) {
    if (isSkillUninstallError(error)) {
      return skillApiError(error.code, 'The uninstall target was rejected.', error.status);
    }
    if (isSkillPlanError(error)) {
      return skillApiError(
        error.code === 'SKILL_PLAN_NOT_FOUND' ? 'SKILL_UNINSTALL_NOT_INSTALLED' : error.code,
        'No installed Skill was found to uninstall.',
        error.code === 'SKILL_PLAN_NOT_FOUND' ? 404 : error.status
      );
    }
    logger.error('skill-uninstall-plan-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return skillApiError(
      'SKILL_UNINSTALL_PLAN_INTERNAL_ERROR',
      'Failed to build the uninstall plan.',
      500
    );
  }
}
