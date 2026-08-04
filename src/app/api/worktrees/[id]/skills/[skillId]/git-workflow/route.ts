/**
 * POST /api/worktrees/[id]/skills/[skillId]/git-workflow — Skill install Git flow (Issue #1247)
 *
 * Two phases behind one endpoint, because they are two halves of one decision
 * the user makes once:
 *
 * - `prepare` runs BEFORE the Install Plan. It validates the preconditions and,
 *   for `dedicated_branch`, creates and checks out the branch. Doing it here is
 *   what keeps `SKILL_PLAN_STALE` an exception: a plan is bound to the branch and
 *   HEAD it was built against, so any checkout must happen before it exists.
 * - `apply` runs AFTER the install landed. It commits the receipt-owned paths,
 *   then optionally pushes and opens a draft PR.
 *
 * The apply request names a token, never a branch, a path or a remote URL. The
 * branch was fixed server-side at prepare and the pathspec is derived from the
 * receipt on disk, so nothing a client sends can widen what gets committed.
 *
 * @module api/worktrees/[id]/skills/[skillId]/git-workflow
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { getDbInstance } from '@/lib/db/db-instance';
import { canonicalWorktreeId, resolveWorktreeOr404 } from '@/lib/git/git-route-worktree';
import { handleGitApiError } from '@/lib/git/git-errors';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import { isSessionRunning } from '@/lib/session/cli-session';
import { validateSkillId } from '@/lib/skills/schema';
import { SKILL_API_NO_STORE_HEADERS, skillApiError } from '@/lib/api/skills-api';
import {
  SKILL_GIT_WORKFLOW_TOKEN_PATTERN,
  applySkillGitWorkflow,
  consumeSkillGitWorkflowTarget,
  isSkillGitWorkflowError,
  issueSkillGitWorkflowToken,
  prepareSkillGitWorkflow,
  readInstalledSkillArtifacts,
  type SkillGitWorkflowMode,
  type SkillGitWorkflowOutcome,
  type SkillGitWorkflowTarget,
} from '@/lib/skills/git-workflow';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/worktrees/[id]/skills/[skillId]/git-workflow');

// =============================================================================
// Wire shape
// =============================================================================

/** The fixed target, plus the token that spends it at apply time. */
export interface SkillGitWorkflowPrepareResponse {
  workflowToken: string;
  target: {
    mode: SkillGitWorkflowMode;
    branch: string;
    baseBranch: string | null;
    headCommit: string;
    branchCreated: boolean;
    remote: string;
  };
}

export interface SkillGitWorkflowApplyResponse {
  result: SkillGitWorkflowOutcome;
}

// =============================================================================
// Body
// =============================================================================

/**
 * Fields a client must never supply.
 *
 * Mirrors the plan and install routes: naming the rejection explicitly stops a
 * caller concluding that a different spelling of "just commit this path" works.
 */
const REJECTED_BODY_KEYS = [
  'path',
  'paths',
  'pathspec',
  'files',
  'worktreePath',
  'repositoryPath',
  'installRoot',
  'branch',
  'baseBranch',
  'remoteUrl',
  'commitMessage',
  'force',
] as const;

const ALLOWED_BODY_KEYS = [
  'phase',
  'mode',
  'version',
  'push',
  'createPullRequest',
  'remote',
  'workflowToken',
] as const;

const MODES: readonly SkillGitWorkflowMode[] = ['current_branch', 'dedicated_branch'];

/** Remote names this route will accept. Server-side git resolves the URL. */
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface PrepareBody {
  phase: 'prepare';
  mode: SkillGitWorkflowMode;
  version: string;
  push: boolean;
  remote: string | undefined;
}

interface ApplyBody {
  phase: 'apply';
  workflowToken: string;
  push: boolean;
  createPullRequest: boolean;
}

type RequestBody = PrepareBody | ApplyBody;
type BodyResult = { ok: true; body: RequestBody } | { ok: false; response: NextResponse };

function invalidBody(message: string): { ok: false; response: NextResponse } {
  return { ok: false, response: skillApiError('SKILL_GIT_INVALID_BODY', message, 400) };
}

async function readBody(request: NextRequest): Promise<BodyResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(await request.text());
  } catch {
    return invalidBody('Malformed JSON body.');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalidBody('Body must be a JSON object.');
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if ((REJECTED_BODY_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        response: skillApiError(
          'SKILL_GIT_INPUT_REJECTED',
          'The commit target is resolved by the server and cannot be supplied by the client.',
          400
        ),
      };
    }
    if (!(ALLOWED_BODY_KEYS as readonly string[]).includes(key)) {
      return invalidBody('Unknown field in body.');
    }
  }

  if (record.phase === 'prepare') {
    const { mode, version, remote } = record;
    if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) {
      return invalidBody('Field `mode` must be `current_branch` or `dedicated_branch`.');
    }
    if (typeof version !== 'string' || version.length === 0 || version.length > 64) {
      return invalidBody('Field `version` must name the version being installed.');
    }
    if (remote !== undefined && (typeof remote !== 'string' || !REMOTE_NAME_PATTERN.test(remote))) {
      return invalidBody('Field `remote` has an unsupported format.');
    }
    return {
      ok: true,
      body: {
        phase: 'prepare',
        mode: mode as SkillGitWorkflowMode,
        version,
        push: record.push === true,
        remote: typeof remote === 'string' ? remote : undefined,
      },
    };
  }

  if (record.phase === 'apply') {
    const { workflowToken } = record;
    if (typeof workflowToken !== 'string' || !SKILL_GIT_WORKFLOW_TOKEN_PATTERN.test(workflowToken)) {
      return invalidBody('Field `workflowToken` must be a token issued by the prepare phase.');
    }
    const push = record.push === true;
    const createPullRequest = record.createPullRequest === true;
    if (createPullRequest && !push) {
      return invalidBody('A pull request requires `push` to be true.');
    }
    return { ok: true, body: { phase: 'apply', workflowToken, push, createPullRequest } };
  }

  return invalidBody('Field `phase` must be `prepare` or `apply`.');
}

// =============================================================================
// Route
// =============================================================================

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; skillId: string }> }
): Promise<NextResponse> {
  try {
    const { id: requestedWorktreeId, skillId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);

    const worktree = resolveWorktreeOr404(id);
    if (worktree instanceof NextResponse) return worktree;

    const idResult = validateSkillId(skillId);
    if (!idResult.ok) return skillApiError(idResult.errors[0].code, 'Invalid Skill ID.', 400);

    const parsed = await readBody(request);
    if (!parsed.ok) return parsed.response;

    if (parsed.body.phase === 'prepare') {
      const target = await prepareSkillGitWorkflow({
        worktreePath: worktree.path,
        skillId: idResult.value,
        version: parsed.body.version,
        mode: parsed.body.mode,
        activeSessions: await listActiveSessions(worktree.id, worktree.selectedAgents),
        push: parsed.body.push,
        remote: parsed.body.remote,
      });
      const response: SkillGitWorkflowPrepareResponse = {
        workflowToken: issueSkillGitWorkflowToken(worktree.id, idResult.value, target),
        target: describeTarget(target),
      };
      return NextResponse.json(response, { headers: SKILL_API_NO_STORE_HEADERS });
    }

    const target = consumeSkillGitWorkflowTarget(parsed.body.workflowToken, {
      worktreeId: worktree.id,
      skillId: idResult.value,
    });
    const artifacts = readInstalledSkillArtifacts(worktree.path, idResult.value);
    const result = await applySkillGitWorkflow({
      worktreePath: worktree.path,
      target,
      receipt: artifacts.receipt,
      manifest: artifacts.manifest,
      push: parsed.body.push,
      createPullRequest: parsed.body.createPullRequest,
    });
    const response: SkillGitWorkflowApplyResponse = { result };
    return NextResponse.json(response, { headers: SKILL_API_NO_STORE_HEADERS });
  } catch (error) {
    if (isSkillGitWorkflowError(error)) {
      return skillApiError(error.code, 'The Skill git workflow was rejected.', error.status);
    }
    return handleGitApiError(error, 'skill-git-workflow');
  }
}

function describeTarget(
  target: SkillGitWorkflowTarget
): SkillGitWorkflowPrepareResponse['target'] {
  return {
    mode: target.mode,
    branch: target.branch,
    baseBranch: target.baseBranch,
    headCommit: target.headCommit,
    branchCreated: target.branchCreated,
    remote: target.remote,
  };
}

/**
 * Agent instances with a live tmux session in this worktree.
 *
 * A probe failure counts as "no session": tmux being unreachable is not evidence
 * that an Agent is running, and treating it as such would make the dedicated
 * branch permanently unreachable whenever the transport is down.
 */
async function listActiveSessions(
  worktreeId: string,
  selectedAgents: Parameters<typeof resolveAgentInstances>[2]
): Promise<string[]> {
  const instances = resolveAgentInstances(getDbInstance(), worktreeId, selectedAgents);
  const running = await Promise.all(
    instances.map(async (instance) => {
      try {
        return (await isSessionRunning(worktreeId, instance.cliTool, instance.id))
          ? instance.id
          : null;
      } catch (error) {
        logger.debug('skill-git-session-probe-failed', {
          worktreeId,
          error: error instanceof Error ? error.name : 'unknown',
        });
        return null;
      }
    })
  );
  return running.filter((value): value is string => value !== null);
}
