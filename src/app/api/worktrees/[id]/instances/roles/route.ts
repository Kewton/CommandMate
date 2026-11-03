/**
 * The role of each instance in a worktree (Issue #4114).
 *
 * `GET` — each instance's stored state and application state, plus what a new
 * instance of each tool would get, which an add dialog reads before it creates one.
 * `PUT` — `{ instanceId, role }`. Only an instance the roster shows; a derived
 * primary stays derived.
 * `POST` — `{ instance: { id, cliTool, alias? }, role?, expectedRosterRevision? }`.
 * Creates the instance and its role in one transaction and answers both.
 *
 * Not a field on `PATCH /api/worktrees/:id`, for the reason `instances/notes` isn't:
 * that write replaces the whole roster from what its client holds. The rules are in
 * `agent-roles/management.ts`; responses are typed in `@/types/agent-roles`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import {
  buildInstanceRoleSettings,
  createInstanceWithRole,
  setManagedInstanceRole,
} from '@/lib/agent-roles/management';
import { respondToRoleError, roleErrorResponse } from '@/lib/agent-roles/route-errors';
import { parseRoleAssignmentInput } from '@/lib/agent-roles/validation';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { readJsonObjectBody } from '@/lib/api/read-json-body';
import type { InstanceRoleCreateResponse } from '@/types/agent-roles';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/instances/roles');

type Params = { params: Promise<{ id: string }> };

function worktreeNotFound(id: string): NextResponse {
  return roleErrorResponse('not_found', `Worktree not found: ${id}`, 404);
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { id: requested } = await params;
    const id = canonicalWorktreeId(requested);
    return NextResponse.json(await buildInstanceRoleSettings(getDbInstance(), id), { status: 200 });
  } catch (error: unknown) {
    return respondToRoleError(error, logger, 'read-failed');
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { id: requested } = await params;
    const id = canonicalWorktreeId(requested);
    const parsed = await readJsonObjectBody<{ instanceId?: unknown; role?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) return worktreeNotFound(id);
    const { instanceId } = parsed.body;
    if (typeof instanceId !== 'string' || instanceId === '') {
      return roleErrorResponse('invalid_request', 'instanceId is required', 400);
    }
    const role = parseRoleAssignmentInput(parsed.body.role);
    if (!role) return roleErrorResponse('invalid_request', 'role must be inherit, none or a role id', 400);
    setManagedInstanceRole(db, worktree, instanceId, role);
    return NextResponse.json(await buildInstanceRoleSettings(db, id), { status: 200 });
  } catch (error: unknown) {
    return respondToRoleError(error, logger, 'write-failed');
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { id: requested } = await params;
    const id = canonicalWorktreeId(requested);
    const parsed = await readJsonObjectBody<{
      instance?: unknown;
      role?: unknown;
      expectedRosterRevision?: unknown;
    }>(request);
    if (!parsed.ok) return parsed.response;
    const { instance, expectedRosterRevision } = parsed.body;
    if (typeof instance !== 'object' || instance === null) {
      return roleErrorResponse('invalid_request', 'instance is required', 400);
    }
    if (expectedRosterRevision !== undefined && typeof expectedRosterRevision !== 'string') {
      return roleErrorResponse('invalid_request', 'expectedRosterRevision must be a string', 400);
    }
    const role = parsed.body.role === undefined ? { state: 'inherit' as const } : parseRoleAssignmentInput(parsed.body.role);
    if (!role) return roleErrorResponse('invalid_request', 'role must be inherit, none or a role id', 400);

    const db = getDbInstance();
    const created = createInstanceWithRole(db, id, {
      instance: instance as { id: unknown; cliTool: unknown; alias?: unknown },
      role,
      expectedRosterRevision,
    });
    const body: InstanceRoleCreateResponse = { ...(await buildInstanceRoleSettings(db, id)), created };
    return NextResponse.json(body, { status: 201 });
  } catch (error: unknown) {
    return respondToRoleError(error, logger, 'create-failed');
  }
}
