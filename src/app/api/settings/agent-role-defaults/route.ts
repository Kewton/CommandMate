/**
 * `GET /api/settings/agent-role-defaults` — the system level, per supported tool.
 * `PUT` — `{ cliToolId, roleId }`; a null `roleId` unsets it.
 *
 * The system level has no "explicit none": it is the end of the chain.
 *
 * Issue #4114. Responses are typed in `@/types/agent-roles`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { setSystemRoleDefault } from '@/lib/db/agent-roles-db';
import { buildSystemRoleDefaults } from '@/lib/agent-roles/management';
import { respondToRoleError, roleErrorResponse } from '@/lib/agent-roles/route-errors';
import { createLogger } from '@/lib/logger';
import { readJsonObjectBody } from '@/lib/api/read-json-body';
import { isAgentRoleCliTool, type SystemRoleDefaultsResponse } from '@/types/agent-roles';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/settings/agent-role-defaults');

function respond(): NextResponse {
  const body: SystemRoleDefaultsResponse = { success: true, defaults: buildSystemRoleDefaults(getDbInstance()) };
  return NextResponse.json(body, { status: 200 });
}

export async function GET() {
  try {
    return respond();
  } catch (error: unknown) {
    return respondToRoleError(error, logger, 'read-failed');
  }
}

export async function PUT(request: NextRequest) {
  try {
    const parsed = await readJsonObjectBody<{ cliToolId?: unknown; roleId?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const { cliToolId, roleId } = parsed.body;
    if (!isAgentRoleCliTool(cliToolId)) {
      return roleErrorResponse('tool_not_supported', 'Roles do not apply to this tool', 400);
    }
    if (roleId !== null && (typeof roleId !== 'string' || roleId === '')) {
      return roleErrorResponse('invalid_request', 'roleId must be a role id or null', 400);
    }
    setSystemRoleDefault(getDbInstance(), cliToolId, roleId);
    return respond();
  } catch (error: unknown) {
    return respondToRoleError(error, logger, 'write-failed');
  }
}
