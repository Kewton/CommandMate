/**
 * `GET /api/roles/:id` — one role with its body and what points at it.
 * `PUT /api/roles/:id` — edit. `expectedBodyVersion` and the `X-Expected-Role-Name`
 * header (#4132) make a stale edit a 409.
 * `DELETE /api/roles/:id` — refused with 409 and the references while in use;
 * `?force=true` removes those settings in the same transaction. Launch records
 * stay. Antigravity definitions generated for the role are removed afterwards
 * when they are provably ours and no live session runs on them (Issue #4419);
 * what is left is a server warning, never a failed delete.
 *
 * Issue #4114. Responses are typed in `@/types/agent-roles`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  deleteAgentRole,
  getAgentRole,
  getAgentRoleReferences,
  updateAgentRole,
} from '@/lib/db/agent-roles-db';
import { respondToRoleError, roleErrorResponse } from '@/lib/agent-roles/route-errors';
import {
  cleanUpDeletedRoleArtifacts,
  type RoleArtifactCleanupTarget,
} from '@/lib/agent-roles/artifact-cleanup';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { isCliToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import { readJsonObjectBody } from '@/lib/api/read-json-body';
import {
  EXPECTED_ROLE_NAME_HEADER,
  type AgentRoleDeleteResponse,
  type AgentRoleDetailResponse,
  type AgentRoleEditResponse,
} from '@/types/agent-roles';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/roles');

type Params = { params: Promise<{ id: string }> };

/** The name a rename replaces: undefined when none is named, null when it cannot be read. */
function expectedNameOf(request: NextRequest): string | undefined | null {
  const raw = request.headers.get(EXPECTED_ROLE_NAME_HEADER);
  if (raw === null) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const db = getDbInstance();
    const role = getAgentRole(db, id);
    if (!role) return roleErrorResponse('not_found', `Role not found: ${id}`, 404);
    const body: AgentRoleDetailResponse = { success: true, role, references: getAgentRoleReferences(db, id) };
    return NextResponse.json(body, { status: 200 });
  } catch (error: unknown) {
    return respondToRoleError(error, logger, 'read-failed');
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const parsed = await readJsonObjectBody<{ name?: unknown; body?: unknown; expectedBodyVersion?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const { name, body, expectedBodyVersion } = parsed.body;
    if (name === undefined && body === undefined) {
      return roleErrorResponse('invalid_request', 'Provide name or body', 400);
    }
    if (expectedBodyVersion !== undefined && !Number.isInteger(expectedBodyVersion)) {
      return roleErrorResponse('invalid_request', 'expectedBodyVersion must be an integer', 400);
    }
    const expectedName = expectedNameOf(request);
    if (expectedName === null) {
      return roleErrorResponse('invalid_request', `${EXPECTED_ROLE_NAME_HEADER} must be URI-encoded`, 400);
    }
    const result = updateAgentRole(getDbInstance(), id, {
      name,
      body,
      expectedBodyVersion: expectedBodyVersion as number | undefined,
      expectedName,
    });
    const response: AgentRoleEditResponse = {
      success: true,
      before: result.before,
      after: result.after,
      bodyVersion: result.after.bodyVersion,
      affected: result.affected,
    };
    return NextResponse.json(response, { status: 200 });
  } catch (error: unknown) {
    return respondToRoleError(error, logger, 'edit-failed');
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const force = request.nextUrl.searchParams.get('force') === 'true';
    const db = getDbInstance();
    const { role, affected } = deleteAgentRole(db, id, { force });
    await cleanUpArtifacts(db, role.id);
    const body: AgentRoleDeleteResponse = {
      success: true,
      deleted: { id: role.id, name: role.name },
      affected,
    };
    return NextResponse.json(body, { status: 200 });
  } catch (error: unknown) {
    return respondToRoleError(error, logger, 'delete-failed');
  }
}

/** A tool this build does not know is treated as alive: its definition is left. */
async function isSessionAlive(target: RoleArtifactCleanupTarget): Promise<boolean> {
  if (!isCliToolType(target.cliToolId)) return true;
  return CLIToolManager.getInstance().getTool(target.cliToolId).isRunning(target.worktreeId, target.instanceId);
}

/** Issue #4419. The role is already deleted, so nothing here fails the request. */
async function cleanUpArtifacts(db: ReturnType<typeof getDbInstance>, roleId: string): Promise<void> {
  try {
    const { entries } = await cleanUpDeletedRoleArtifacts(db, roleId, { isSessionAlive });
    for (const entry of entries) {
      if (entry.kind === 'removed') {
        logger.info('role-artifact-removed', { roleId, path: entry.path });
      } else if (!(entry.kind === 'kept' && entry.reason === 'missing')) {
        logger.warn('role-artifact-left', { roleId, path: entry.path, outcome: entry.kind, reason: entry.reason });
      }
    }
  } catch (error) {
    logger.warn('role-artifact-cleanup-failed', { roleId, error: error instanceof Error ? error.message : String(error) });
  }
}
