/**
 * `GET /api/roles` — every role, without bodies.
 * `POST /api/roles` — create one.
 *
 * Issue #4114. Responses are typed in `@/types/agent-roles`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { createAgentRole, listAgentRoles } from '@/lib/db/agent-roles-db';
import { respondToRoleError } from '@/lib/agent-roles/route-errors';
import { createLogger } from '@/lib/logger';
import { readJsonObjectBody } from '@/lib/api/read-json-body';
import type { AgentRoleListResponse } from '@/types/agent-roles';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/roles');

export async function GET() {
  try {
    const roles = listAgentRoles(getDbInstance()).map(({ body: _body, ...summary }) => summary);
    const body: AgentRoleListResponse = { success: true, roles };
    return NextResponse.json(body, { status: 200 });
  } catch (error: unknown) {
    return respondToRoleError(error, logger, 'list-failed');
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = await readJsonObjectBody<{ name?: unknown; body?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const role = createAgentRole(getDbInstance(), { name: parsed.body.name, body: parsed.body.body });
    return NextResponse.json({ success: true, role }, { status: 201 });
  } catch (error: unknown) {
    return respondToRoleError(error, logger, 'create-failed');
  }
}
