/**
 * GET  /api/worktrees/apply-default-agents — how many branches an apply would change
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
 * ## What "existing branch" means here
 *
 * Only branches the user has never touched — `selected_agents IS NULL` AND no
 * `agent_instances` roster. That is the same pair of facts #2066 checks before
 * it lets a repository declaration reach a worktree, checked by the same helper
 * (`getUnchangedAgentWorktreeIds`), because a second spelling of "unchanged" is
 * how the two features end up disagreeing about the same branch.
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
  getUnchangedAgentWorktreeIds,
} from '@/lib/db/worktree-db';
import { validateSelectedAgentsInput } from '@/lib/selected-agents-validator';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/worktrees/apply-default-agents');

export async function GET(): Promise<NextResponse> {
  try {
    const db = getDbInstance();
    return NextResponse.json(
      { success: true, eligible: getUnchangedAgentWorktreeIds(db).length },
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

    const db = getDbInstance();
    const updatedIds = applySelectedAgentsToUnchanged(db, validation.value!);
    logger.info('applied-default-agents-to-unchanged', {
      agents: validation.value!,
      updated: updatedIds.length,
    });

    return NextResponse.json(
      {
        success: true,
        agents: validation.value!,
        updated: updatedIds.length,
        updatedIds,
        // What a second apply would still find. Zero right after a successful
        // one, and the UI reads it so the panel does not keep offering to
        // change branches it has just finished changing.
        eligible: getUnchangedAgentWorktreeIds(db).length,
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
