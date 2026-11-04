/**
 * `POST /api/worktrees/:id/instances/roles/settle` — `{ idempotencyKey }` (Issue #4132).
 *
 * What a create or a roster PATCH whose answer was lost came to. A read cannot say: its
 * "not there" stops being true when the request commits a moment later, and adding again
 * then makes two. So a key that made nothing is marked here, and that request makes nothing.
 * Design: `docs/design/agent-roles-adapters.md` §15.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { getInstanceCreationKey, settleInstanceCreationKey } from '@/lib/db/agent-roles-db';
import { respondToRoleError, roleErrorResponse } from '@/lib/agent-roles/route-errors';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { readJsonObjectBody } from '@/lib/api/read-json-body';
import { createLogger } from '@/lib/logger';
import { INSTANCE_CREATION_KEY_PATTERN, type InstanceCreationSettleResponse } from '@/types/agent-roles';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/instances/roles/settle');

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: requested } = await params;
    const id = canonicalWorktreeId(requested);
    const parsed = await readJsonObjectBody<{ idempotencyKey?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const { idempotencyKey } = parsed.body;
    if (typeof idempotencyKey !== 'string' || !INSTANCE_CREATION_KEY_PATTERN.test(idempotencyKey)) {
      return roleErrorResponse('invalid_request', 'idempotencyKey must be 16-128 letters, digits, _ or -', 400);
    }
    const db = getDbInstance();
    if (!getWorktreeById(db, id)) return roleErrorResponse('not_found', `Worktree not found: ${id}`, 404);
    settleInstanceCreationKey(db, id, idempotencyKey);
    // Read back with no await between: a commit that names no row reads like nothing above.
    const record = getInstanceCreationKey(db, id, idempotencyKey);
    const body: InstanceCreationSettleResponse =
      !record || record.requestFingerprint === null
        ? { success: true, outcome: 'cancelled' }
        : { success: true, outcome: 'committed', ...(record.instanceId === null ? {} : { instanceId: record.instanceId }) };
    return NextResponse.json(body, { status: 200 });
  } catch (error: unknown) {
    return respondToRoleError(error, logger, 'settle-failed');
  }
}
