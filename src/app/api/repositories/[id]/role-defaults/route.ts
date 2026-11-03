/**
 * `GET /api/repositories/:id/role-defaults` — per supported tool, what this root
 * holds (`stored`) and what a worktree of it would get (`effective`).
 * `PUT` — `{ cliToolId, role: { state: 'inherit' | 'none' | 'role', roleId? } }`.
 *
 * Settings are stored per registered root. Roots of one git repository answer as
 * one, and answer "ambiguous" when they differ; see `agent-roles/resolve.ts`.
 *
 * Issue #4114. Responses are typed in `@/types/agent-roles`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { setRepositoryRoleState } from '@/lib/db/agent-roles-db';
import { getRepositoryById, type Repository } from '@/lib/db/db-repository';
import { buildRepositoryRoleDefaults } from '@/lib/agent-roles/management';
import { respondToRoleError, roleErrorResponse } from '@/lib/agent-roles/route-errors';
import { parseRoleAssignmentInput } from '@/lib/agent-roles/validation';
import { createLogger } from '@/lib/logger';
import { readJsonObjectBody } from '@/lib/api/read-json-body';
import { isAgentRoleCliTool, type RepositoryRoleDefaultsResponse } from '@/types/agent-roles';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/repositories/role-defaults');

type Params = { params: Promise<{ id: string }> };

async function respond(repository: Repository): Promise<NextResponse> {
  const body: RepositoryRoleDefaultsResponse = {
    success: true,
    repository: {
      id: repository.id,
      name: repository.name,
      path: repository.path,
      enabled: repository.enabled,
    },
    defaults: await buildRepositoryRoleDefaults(getDbInstance(), repository),
  };
  return NextResponse.json(body, { status: 200 });
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const repository = getRepositoryById(getDbInstance(), id);
    if (!repository) return roleErrorResponse('not_found', `Repository not found: ${id}`, 404);
    return await respond(repository);
  } catch (error: unknown) {
    return respondToRoleError(error, logger, 'read-failed');
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const parsed = await readJsonObjectBody<{ cliToolId?: unknown; role?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const db = getDbInstance();
    const repository = getRepositoryById(db, id);
    if (!repository) return roleErrorResponse('not_found', `Repository not found: ${id}`, 404);
    if (!isAgentRoleCliTool(parsed.body.cliToolId)) {
      return roleErrorResponse('tool_not_supported', 'Roles do not apply to this tool', 400);
    }
    const role = parseRoleAssignmentInput(parsed.body.role);
    if (!role) return roleErrorResponse('invalid_request', 'role must be inherit, none or a role id', 400);
    setRepositoryRoleState(db, id, parsed.body.cliToolId, role);
    return await respond(repository);
  } catch (error: unknown) {
    return respondToRoleError(error, logger, 'write-failed');
  }
}
