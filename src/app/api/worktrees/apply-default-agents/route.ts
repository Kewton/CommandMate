/**
 * GET  /api/worktrees/apply-default-agents?worktreeId=… — how many branches an apply would change
 * POST /api/worktrees/apply-default-agents — write one agent order onto exactly those
 *
 * Issue #2067. #2065 made the agent order for NEW branches configurable and
 * said so on the settings screen ("Existing branches are left alone"); #2066
 * added the repository layer with the same restraint. Neither gave the user a
 * way to say "and the branches I already have" — so an install that has been
 * running for a month keeps the old tab order on every branch in the sidebar,
 * forever, and the only fix was to open each one and re-order it by hand.
 *
 * This route is that missing action, and it is deliberately NOT part of
 * `PUT /api/settings/default-agents`: saving a preference and rewriting existing
 * rows are different decisions with different blast radii, and the second one is
 * behind a confirmation in the UI. Saving the preference still touches nothing.
 *
 * ## Both verbs take a `worktreeId`, and it is what bounds the blast radius
 *
 * The action lives in the agent pane of ONE worktree, so it may only reach that
 * worktree's REPOSITORY. The client names the worktree it is acting from and the
 * server derives `repository_path` from the row — rather than accepting a path,
 * which would let any caller aim the write at any repository on the machine.
 *
 * ## What "existing branch" means here
 *
 * Inside that repository: only branches the user has never touched —
 * `selected_agents IS NULL` AND no `agent_instances` roster. That is the same
 * pair of facts #2066 checks before it lets a repository declaration reach a
 * worktree, checked by the same helper (`findUnchangedAgentWorktrees`), because
 * a second spelling of "unchanged" is how the two features end up disagreeing
 * about the same branch.
 *
 * A repository that ships `.commandmate/agents.yaml` is excluded outright and
 * says so (`repoDeclaresAgents`): the column outranks the file permanently, so
 * an apply there would retire a committed declaration with no way back and no
 * explanation on screen. See `findUnchangedAgentWorktrees`.
 *
 * ## Why GET returns a count
 *
 * The UI shows the number before it asks. `POST` recomputes the set inside its
 * own transaction rather than trusting a list from the client, so the number
 * the user confirmed and the number of rows written can only differ if a branch
 * appeared in between — and the response reports what was actually written.
 */

// Reads and writes the database; a prerendered count would be a build-time
// snapshot of a number that changes every time a worktree is discovered.
export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  applySelectedAgentsToUnchanged,
  findUnchangedAgentWorktrees,
  getWorktreeById,
} from '@/lib/db/worktree-db';
import { validateSelectedAgentsInput } from '@/lib/selected-agents-validator';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/worktrees/apply-default-agents');

/** The scope both verbs answer for, resolved from the calling worktree. */
interface ApplyScope {
  worktreeId: string;
  repositoryPath: string | null;
  repositoryName: string | null;
}

/**
 * Resolve `worktreeId` to its repository, or to the response that explains why
 * it could not be.
 *
 * A worktree with no `repository_path` is answered rather than rejected: it is
 * a legal row, there is simply no repository to scope an apply to, so the honest
 * answer is a scope with zero eligible branches and the UI disables the action.
 */
function resolveScope(
  worktreeId: string | null
): { error: NextResponse } | { scope: ApplyScope } {
  if (!worktreeId) {
    return {
      error: NextResponse.json(
        { success: false, error: 'Invalid request: "worktreeId" is required' },
        { status: 400 }
      ),
    };
  }
  const worktree = getWorktreeById(getDbInstance(), worktreeId);
  if (!worktree) {
    return {
      error: NextResponse.json({ success: false, error: 'Worktree not found' }, { status: 404 }),
    };
  }
  return {
    scope: {
      worktreeId,
      repositoryPath: worktree.repositoryPath || null,
      repositoryName: worktree.repositoryName || null,
    },
  };
}

/** The shape both verbs share, so the client reads one contract. */
function scopeBody(scope: ApplyScope, eligible: number, repoDeclaresAgents: boolean) {
  return {
    success: true as const,
    worktreeId: scope.worktreeId,
    repositoryPath: scope.repositoryPath,
    repositoryName: scope.repositoryName,
    /** Branches inside this repository a bulk apply would change. */
    eligible,
    /** True when `.commandmate/agents.yaml` governs this repository (#2066). */
    repoDeclaresAgents,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const resolved = resolveScope(request.nextUrl?.searchParams?.get('worktreeId') ?? null);
    if ('error' in resolved) return resolved.error;
    const { scope } = resolved;

    if (!scope.repositoryPath) {
      return NextResponse.json(scopeBody(scope, 0, false), { status: 200 });
    }

    const found = findUnchangedAgentWorktrees(getDbInstance(), scope.repositoryPath);
    return NextResponse.json(
      scopeBody(scope, found.ids.length, found.repoDeclares),
      { status: 200 }
    );
  } catch (error) {
    logger.error('count-unchanged-worktrees-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || !('agents' in body)) {
      return NextResponse.json(
        { success: false, error: 'Invalid request body: "agents" is required' },
        { status: 400 }
      );
    }

    const rawWorktreeId = (body as { worktreeId?: unknown }).worktreeId;
    const resolved = resolveScope(
      typeof rawWorktreeId === 'string' && rawWorktreeId.length > 0 ? rawWorktreeId : null
    );
    if ('error' in resolved) return resolved.error;
    const { scope } = resolved;

    // The same validator the settings PUT uses: an apply must not be able to
    // write a roster into `worktrees.selected_agents` that the settings route
    // would have rejected.
    const validation = validateSelectedAgentsInput((body as { agents: unknown }).agents);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 }
      );
    }

    if (!scope.repositoryPath) {
      return NextResponse.json(
        { ...scopeBody(scope, 0, false), agents: validation.value!, updated: 0, updatedIds: [] },
        { status: 200 }
      );
    }

    const db = getDbInstance();
    const updatedIds = applySelectedAgentsToUnchanged(
      db,
      scope.repositoryPath,
      validation.value!
    );
    // What a second apply would still find. Zero right after a successful one,
    // and the UI reads it so the panel does not keep offering to change branches
    // it has just finished changing.
    const remaining = findUnchangedAgentWorktrees(db, scope.repositoryPath);

    logger.info('applied-default-agents-to-unchanged', {
      worktreeId: scope.worktreeId,
      repositoryPath: scope.repositoryPath,
      agents: validation.value!,
      updated: updatedIds.length,
    });

    return NextResponse.json(
      {
        ...scopeBody(scope, remaining.ids.length, remaining.repoDeclares),
        agents: validation.value!,
        updated: updatedIds.length,
        updatedIds,
      },
      { status: 200 }
    );
  } catch (error) {
    logger.error('apply-default-agents-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
