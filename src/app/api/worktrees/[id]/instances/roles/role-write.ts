/**
 * The judged writes of `PUT` / `POST /instances/roles`, cut out of the route
 * (Issue #4466 PR1a).
 *
 * Both are synchronous: the tool policy for the tool about to be written is asked inside
 * the write's own transaction, and a refusal is thrown as {@link WriteToolPolicyRefused}
 * so the transaction rolls back with nothing written. The route calls them where it
 * always wrote; its answers and codes are unchanged.
 *
 * @module app/api/worktrees/[id]/instances/roles/role-write
 */
import { NextResponse } from 'next/server';
import type Database from 'better-sqlite3';
import { createInstanceWithRole, setManagedInstanceRole } from '@/lib/agent-roles/management';
import type { RoleAssignmentInput } from '@/types/agent-roles';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';
import {
  findWriteToolPolicyRefusal,
  WriteToolPolicyRefused,
  type WriteToolPolicyRequest,
} from '../../send/write-tool-policy';

/**
 * Issue #4449: what the transaction calls right before it writes — the tool policy for the
 * tool it is about to write, thrown as {@link WriteToolPolicyRefused} so nothing is written.
 */
export function toolPolicyGuard(
  db: Database.Database,
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
export function toolPolicyRefusalResponse(error: unknown): NextResponse | null {
  return error instanceof WriteToolPolicyRefused ? NextResponse.json(error.body, { status: 409 }) : null;
}

/**
 * `PUT`'s write: the role of `instanceId`, judged for the tool the roster gives it.
 * Synchronous; throws {@link WriteToolPolicyRefused} (nothing written) or the role errors.
 */
export function writeInstanceRole(
  db: Database.Database,
  worktreeId: string,
  worktree: Worktree,
  input: {
    instanceId: string;
    role: RoleAssignmentInput;
    expectedRosterRevision?: string;
    request: WriteToolPolicyRequest;
  },
): void {
  setManagedInstanceRole(
    db,
    worktree,
    input.instanceId,
    input.role,
    input.expectedRosterRevision,
    toolPolicyGuard(db, worktreeId, input.request, () => input.instanceId),
  );
}

/**
 * `POST`'s write: the instance and its role, judged for the tool it is created as.
 * Synchronous; throws {@link WriteToolPolicyRefused} (nothing written) or the role errors.
 */
export function createInstanceRole(
  db: Database.Database,
  worktreeId: string,
  input: {
    instance: { id: unknown; cliTool: unknown; alias?: unknown };
    role: RoleAssignmentInput;
    expectedRosterRevision?: string;
    idempotencyKey?: string;
    request: WriteToolPolicyRequest;
  },
): { instanceId: string; replayed?: true } {
  return createInstanceWithRole(db, worktreeId, {
    instance: input.instance,
    role: input.role,
    expectedRosterRevision: input.expectedRosterRevision,
    idempotencyKey: input.idempotencyKey,
    beforeWrite: toolPolicyGuard(db, worktreeId, input.request, () => String(input.instance.id)),
  });
}
