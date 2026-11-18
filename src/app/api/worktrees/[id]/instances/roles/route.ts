/**
 * The role of each instance in a worktree (Issue #4114).
 *
 * `GET` — each instance's stored state and application state, plus what a new
 * instance of each tool would get, which an add dialog reads before it creates one.
 * `PUT` — `{ instanceId, role, expectedRosterRevision? }`. Only an instance the roster
 * shows; a derived primary stays derived. A stale revision is a 409 (#4132).
 * `POST` — `{ instance: { id, cliTool, alias? }, role?, expectedRosterRevision? }`.
 * Creates the instance and its role in one transaction and answers both. With an
 * `Idempotency-Key` header, the same key sent again creates nothing and answers 200 with
 * `replayed: true`; `POST ./settle` asks what a key came to (#4132).
 *
 * Issue #4449: `PUT` and `POST` take the `origin` / `originEvidence` / `replyTo` of the
 * send they are written for (`send --contract --role`, `send --register --role`) and
 * refuse with the send's 409 (`TOOL_POLICY_DENIED`, or the relay's
 * `RELAY_TOOL_POLICY_DENIED`) before anything is written. The tool judged is the one
 * written, inside the write's transaction (`send/write-tool-policy`). A body with none
 * of them (the web UI, `instances set-role`) is not affected.
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
  type RoleApplicationDeps,
} from '@/lib/agent-roles/management';
import { respondToRoleError, roleErrorResponse } from '@/lib/agent-roles/route-errors';
import { parseRoleAssignmentInput } from '@/lib/agent-roles/validation';
import { getLaunchRoleEvidence, wasResumedAcrossRole } from '@/lib/session/role-launch';
import { loadPaneComposition } from '@/lib/agent-roles/pane-env';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { readJsonObjectBody } from '@/lib/api/read-json-body';
import {
  findWriteToolPolicyRefusal,
  readWriteToolPolicyRequest,
  WriteToolPolicyRefused,
  type WriteToolPolicyRequest,
} from '../../send/write-tool-policy';
import {
  INSTANCE_CREATION_KEY_HEADER,
  INSTANCE_CREATION_KEY_PATTERN,
  type InstanceRoleCreateResponse,
} from '@/types/agent-roles';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/instances/roles');

type Params = { params: Promise<{ id: string }> };

/** What only this server knows: the user's settings, and the process it started. */
function applicationDeps(worktreeId: string): RoleApplicationDeps {
  return {
    loadComposition: (cliToolId: CLIToolType, instanceId: string, worktreePath: string) =>
      loadPaneComposition(worktreeId, cliToolId, instanceId, worktreePath),
    currentGeneration: (cliToolId: CLIToolType, instanceId: string) =>
      getLaunchRoleEvidence({ worktreeId, cliToolId, instanceId })?.sessionGeneration ?? null,
    resumedAcrossRole: (cliToolId: CLIToolType, instanceId: string) =>
      wasResumedAcrossRole({ worktreeId, cliToolId, instanceId }),
  };
}

/**
 * Issue #4449: what the transaction calls right before it writes — the tool policy for the
 * tool it is about to write, thrown as {@link WriteToolPolicyRefused} so nothing is written.
 */
function toolPolicyGuard(
  db: ReturnType<typeof getDbInstance>,
  worktreeId: string,
  request: WriteToolPolicyRequest,
  instanceId: () => string,
): (cliToolId: CLIToolType) => void {
  return (cliToolId) => {
    const refusal = findWriteToolPolicyRefusal(db, { worktreeId, tool: cliToolId, instanceId: instanceId(), request });
    if (refusal) throw new WriteToolPolicyRefused(refusal);
  };
}

/** The 409 of a refused write, or null for any other error. */
function toolPolicyRefusalResponse(error: unknown): NextResponse | null {
  return error instanceof WriteToolPolicyRefused ? NextResponse.json(error.body, { status: 409 }) : null;
}

function worktreeNotFound(id: string): NextResponse {
  return roleErrorResponse('not_found', `Worktree not found: ${id}`, 404);
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { id: requested } = await params;
    const id = canonicalWorktreeId(requested);
    return NextResponse.json(await buildInstanceRoleSettings(getDbInstance(), id, applicationDeps(id)), { status: 200 });
  } catch (error: unknown) {
    return respondToRoleError(error, logger, 'read-failed');
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { id: requested } = await params;
    const id = canonicalWorktreeId(requested);
    const parsed = await readJsonObjectBody<{ instanceId?: unknown; role?: unknown; expectedRosterRevision?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const policyRequest = readWriteToolPolicyRequest(parsed.body);
    if (!policyRequest.ok) return roleErrorResponse('invalid_request', policyRequest.error, 400);
    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) return worktreeNotFound(id);
    const { instanceId, expectedRosterRevision } = parsed.body;
    if (typeof instanceId !== 'string' || instanceId === '') {
      return roleErrorResponse('invalid_request', 'instanceId is required', 400);
    }
    const role = parseRoleAssignmentInput(parsed.body.role);
    if (!role) return roleErrorResponse('invalid_request', 'role must be inherit, none or a role id', 400);
    if (expectedRosterRevision !== undefined && typeof expectedRosterRevision !== 'string') {
      return roleErrorResponse('invalid_request', 'expectedRosterRevision must be a string', 400);
    }
    setManagedInstanceRole(
      db,
      worktree,
      instanceId,
      role,
      expectedRosterRevision,
      toolPolicyGuard(db, id, policyRequest.value, () => instanceId),
    );
    return NextResponse.json(await buildInstanceRoleSettings(db, id, applicationDeps(id)), { status: 200 });
  } catch (error: unknown) {
    return toolPolicyRefusalResponse(error) ?? respondToRoleError(error, logger, 'write-failed');
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
    const policyRequest = readWriteToolPolicyRequest(parsed.body);
    if (!policyRequest.ok) return roleErrorResponse('invalid_request', policyRequest.error, 400);
    const { instance, expectedRosterRevision } = parsed.body;
    if (typeof instance !== 'object' || instance === null) {
      return roleErrorResponse('invalid_request', 'instance is required', 400);
    }
    if (expectedRosterRevision !== undefined && typeof expectedRosterRevision !== 'string') {
      return roleErrorResponse('invalid_request', 'expectedRosterRevision must be a string', 400);
    }
    const idempotencyKey = request.headers.get(INSTANCE_CREATION_KEY_HEADER) ?? undefined;
    if (idempotencyKey !== undefined && !INSTANCE_CREATION_KEY_PATTERN.test(idempotencyKey)) {
      return roleErrorResponse('invalid_request', `${INSTANCE_CREATION_KEY_HEADER} must be 16-128 letters, digits, _ or -`, 400);
    }
    const role = parsed.body.role === undefined ? { state: 'inherit' as const } : parseRoleAssignmentInput(parsed.body.role);
    if (!role) return roleErrorResponse('invalid_request', 'role must be inherit, none or a role id', 400);

    const db = getDbInstance();
    const { instanceId, replayed } = createInstanceWithRole(db, id, {
      instance: instance as { id: unknown; cliTool: unknown; alias?: unknown },
      role,
      expectedRosterRevision,
      idempotencyKey,
      beforeWrite: toolPolicyGuard(db, id, policyRequest.value, () => String((instance as { id: unknown }).id)),
    });
    const body: InstanceRoleCreateResponse = {
      ...(await buildInstanceRoleSettings(db, id, applicationDeps(id))),
      created: { instanceId },
      ...(replayed ? { replayed } : {}),
    };
    return NextResponse.json(body, { status: replayed ? 200 : 201 });
  } catch (error: unknown) {
    return toolPolicyRefusalResponse(error) ?? respondToRoleError(error, logger, 'create-failed');
  }
}
