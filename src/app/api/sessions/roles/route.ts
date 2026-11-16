/**
 * API Route: GET /api/sessions/roles (Issue #4387)
 *
 * The role of every instance on the server, for `/sessions` to filter by. Its own
 * route rather than a map on `GET /api/worktrees`: resolving a role takes git
 * whenever a root holds a role setting (which roots a worktree belongs to is git's
 * answer), and measured that added about 144 ms to the list's `dbMs` of about 1 ms
 * at 100 worktrees — every client polls the list every few seconds, and only
 * `/sessions` filters by role (docs/design/sessions-role-by-instance-4387.md).
 *
 * Read for the whole server at once (`buildRoleByInstance`); the settings files are
 * not read, since a list shows a role and not what it would inject.
 *
 * When the roles cannot be read, the answer is still 200 with an empty map and
 * `rolesUnavailable: true`, and the failure is logged, as `GET /api/worktrees` does
 * with `lastActivityByWorktree`: a filter that cannot read roles shows the list
 * unfiltered rather than failing it.
 */
import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { buildRoleByInstance } from '@/lib/agent-roles/role-by-instance';
import { getLaunchRoleEvidence } from '@/lib/session/role-launch';
import { createLogger } from '@/lib/logger';
import type { SessionRolesResponse } from '@/types/agent-roles';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/sessions/roles');

/** Milliseconds at 0.1ms resolution; full float precision is noise in a log. */
function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}

export async function GET() {
  const startedAt = performance.now();
  let body: SessionRolesResponse;
  try {
    const roles = await buildRoleByInstance(getDbInstance(), {
      currentGeneration: (worktreeId, cliToolId, instanceId) =>
        getLaunchRoleEvidence({ worktreeId, cliToolId, instanceId })?.sessionGeneration ?? null,
    });
    body = { success: true, roleByWorktree: Object.fromEntries(roles) };
    logger.debug('roles:timing', { totalMs: roundMs(performance.now() - startedAt), worktreeCount: roles.size });
  } catch (error) {
    logger.error('roles:read-failed', { error: error instanceof Error ? error.message : String(error) });
    body = { success: true, roleByWorktree: {}, rolesUnavailable: true };
  }
  return NextResponse.json(body, { status: 200 });
}
