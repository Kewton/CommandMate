/**
 * Issue #4385 (A4 差し戻し): the screen reads a send's role refusal from the body the server's 409
 * already carries (`ApiError.data.roleRefusal`; the response’s shape is unchanged), by shape —
 * the module does not import `@/lib/api-client`, which many suites replace.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api-client';
import { readSendRoleRefusal } from '@/components/worktree/role-refusal-notice';

const body = (roleRefusal: unknown) => ({ error: 'x', code: 'ROLE_LAUNCH_REFUSED', roleRefusal, sendOutcome: 'not_sent' });

describe('[#4385 A4] readSendRoleRefusal', () => {
  it.each(['not-applied', 'not-confirmed', 'artifact-failed'] as const)('reads %s from a 409', (reason) => {
    expect(readSendRoleRefusal(new ApiError('x', 409, body(reason)))).toBe(reason);
  });

  it('names any other role refusal "other"', () => {
    expect(readSendRoleRefusal(new ApiError('x', 409, body('session-stopped')))).toBe('other');
  });

  it('is null for what is not a role refusal (negative controls)', () => {
    expect(readSendRoleRefusal(new ApiError('x', 409, { error: 'boundary_changed' }))).toBeNull();
    expect(readSendRoleRefusal(new ApiError('x', 500, body('not-applied')))).toBeNull();
    expect(readSendRoleRefusal(new ApiError('x', 409, body(3)))).toBeNull();
    expect(readSendRoleRefusal(new ApiError('x', 409))).toBeNull();
    expect(readSendRoleRefusal(new Error('not-applied'))).toBeNull();
    expect(readSendRoleRefusal(null)).toBeNull();
  });
});
