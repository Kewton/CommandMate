/**
 * Turning the role layer's errors into responses. One mapping for every role
 * route, so the codes in `AgentRoleErrorResponse` mean the same thing throughout.
 *
 * Logs an unexpected error's message only. These routes handle role bodies and a
 * request body is never passed to a logger.
 *
 * @module lib/agent-roles/route-errors
 */
import { NextResponse } from 'next/server';
import {
  AgentRoleInUseError,
  AgentRoleNameConflictError,
  AgentRoleNotFoundError,
  AgentRoleValidationError,
  AgentRoleVersionConflictError,
} from '@/lib/db/agent-roles-db';
import type { createLogger } from '@/lib/logger';
import type { AgentRoleDeleteConflictResponse, AgentRoleErrorResponse } from '@/types/agent-roles';
import { InstanceRoleRequestError } from './management';
import { AgentRoleTargetNotFoundError } from './resolve';

export function roleErrorResponse(
  error: AgentRoleErrorResponse['error'],
  message: string,
  status: number
): NextResponse {
  const body: AgentRoleErrorResponse = { success: false, error, message };
  return NextResponse.json(body, { status });
}

const INSTANCE_REQUEST_STATUS: Record<InstanceRoleRequestError['code'], number> = {
  not_found: 404,
  tool_not_supported: 400,
  invalid_request: 400,
  instance_exists: 409,
  roster_changed: 409,
};

/** The response for an error thrown by the role layer. */
export function respondToRoleError(
  error: unknown,
  logger: ReturnType<typeof createLogger>,
  event: string
): NextResponse {
  if (error instanceof AgentRoleValidationError) return roleErrorResponse('invalid_request', error.message, 400);
  if (error instanceof AgentRoleNotFoundError || error instanceof AgentRoleTargetNotFoundError) {
    return roleErrorResponse('not_found', error.message, 404);
  }
  if (error instanceof AgentRoleNameConflictError) return roleErrorResponse('name_conflict', error.message, 409);
  if (error instanceof AgentRoleVersionConflictError) {
    const body: AgentRoleErrorResponse = {
      success: false,
      error: 'version_conflict',
      message: error.message,
      currentBodyVersion: error.currentBodyVersion,
    };
    return NextResponse.json(body, { status: 409 });
  }
  if (error instanceof AgentRoleInUseError) {
    const body: AgentRoleDeleteConflictResponse = {
      success: false,
      error: 'role_in_use',
      message: error.message,
      references: error.references,
    };
    return NextResponse.json(body, { status: 409 });
  }
  if (error instanceof InstanceRoleRequestError) {
    return roleErrorResponse(error.code, error.message, INSTANCE_REQUEST_STATUS[error.code]);
  }
  logger.error(event, { error: error instanceof Error ? error.message : String(error) });
  return roleErrorResponse('internal_error', 'Internal error', 500);
}
