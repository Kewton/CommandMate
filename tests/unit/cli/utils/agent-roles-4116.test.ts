/**
 * Issue #4116: naming a role and reading a role API refusal. The commands around
 * these run against the real routes in `tests/integration/cli-roles-4116.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/cli/utils/api-client';
import { pickRole, RoleCliError, roleFailureFromApi } from '@/cli/utils/agent-roles';
import { ExitCode, InterruptExitCode, RoleExitCode, StrictRespondExitCode, VerifyExitCode, WaitExitCode } from '@/cli/types';
import type { AgentRoleSummary } from '@/types/agent-roles';

function role(id: string, name: string): AgentRoleSummary {
  return { id, name, bodyVersion: 1, bodyFingerprint: 'f', bodyBytes: 1, createdAt: 0, updatedAt: 0 };
}

function failure(fn: () => unknown): RoleCliError {
  try {
    fn();
  } catch (error) {
    if (error instanceof RoleCliError) return error;
    throw error;
  }
  throw new Error('did not fail');
}

describe('pickRole', () => {
  const roles = [role('aaaa', 'Reviewer'), role('bbbb', 'writer')];

  it('an ID, an exact name, and a name in another case', () => {
    expect(pickRole(roles, 'aaaa').id).toBe('aaaa');
    expect(pickRole(roles, 'writer').id).toBe('bbbb');
    expect(pickRole(roles, 'reviewer').id).toBe('aaaa');
  });

  it('an unknown one', () => {
    expect(failure(() => pickRole(roles, 'nobody'))).toMatchObject({ code: 'unknown_role', exitCode: ExitCode.CONFIG_ERROR });
  });

  it('an ID that is another role\'s name is never picked for you', () => {
    const clash = failure(() => pickRole([...roles, role('cccc', 'aaaa')], 'aaaa'));
    expect(clash).toMatchObject({ code: 'ambiguous_role', exitCode: ExitCode.CONFIG_ERROR });
    expect(clash.details.candidates).toEqual([{ id: 'aaaa', name: 'Reviewer' }, { id: 'cccc', name: 'aaaa' }]);
  });

  it('Unicode forms are one name to a reader, and two to the database', () => {
    const nfc = role('n1', 'café');
    const nfd = role('n2', 'café');
    expect(pickRole([nfc, nfd], 'café').id).toBe('n1');
    expect(failure(() => pickRole([nfc, nfd], 'CAFÉ')).code).toBe('ambiguous_role');
  });

  it('a name that looks like a reserved word is only a name', () => {
    expect(pickRole([role('n3', 'none'), role('n4', 'default')], 'none').id).toBe('n3');
  });
});

describe('roleFailureFromApi', () => {
  const api = (status: number, payload: ConstructorParameters<typeof ApiError>[3]) =>
    new ApiError('generic', ExitCode.UNEXPECTED_ERROR, status, payload);

  it('the management routes: the code in error, the sentence in message', () => {
    const version = roleFailureFromApi(
      api(409, { success: false, error: 'version_conflict', message: 'edited', currentBodyVersion: 3 })
    );
    expect(version).toMatchObject({ code: 'version_conflict', message: 'edited', exitCode: RoleExitCode.CONFLICT });
    expect(version?.details).toEqual({ currentBodyVersion: 3 });
  });

  it('the send route: the code in code, the sentence in error, and whether it stayed saved', () => {
    const unmet = roleFailureFromApi(
      api(409, { code: 'ROLE_CONDITION_UNMET', error: 'another role', roleSettings: { saved: true }, sendOutcome: 'not_sent' })
    );
    expect(unmet).toMatchObject({ code: 'ROLE_CONDITION_UNMET', exitCode: RoleExitCode.NOT_SENT });
    expect(unmet?.message).toContain('stayed saved');
    expect(roleFailureFromApi(api(409, { code: 'ROLE_LAUNCH_REFUSED', error: 'x' }))?.exitCode).toBe(RoleExitCode.NOT_SENT);
    expect(roleFailureFromApi(api(409, { code: 'roster_changed', error: 'x', roleSettings: { saved: false } }))?.exitCode).toBe(RoleExitCode.CONFLICT);
  });

  it('anything else is not a role failure, and keeps its own handling', () => {
    expect(roleFailureFromApi(new Error('x'))).toBeNull();
    expect(roleFailureFromApi(api(404, undefined))).toBeNull();
    expect(roleFailureFromApi(api(409, { code: 'PROMPT_WAITING', error: 'x' }))).toBeNull();
    // A `not_found` from another route's `{ error, code }` is not the role's to claim.
    expect(roleFailureFromApi(api(404, { code: 'not_found', error: 'x' }))).toBeNull();
    expect(roleFailureFromApi(api(500, { success: false, error: 'internal_error', message: 'x' }))).toBeNull();
  });

  it('is an ApiError, so handleCommandError exits with its code', () => {
    expect(new RoleCliError('x', 'y', RoleExitCode.NOT_SENT)).toBeInstanceOf(ApiError);
  });
});

describe('RoleExitCode', () => {
  it('shares no value with what an orchestration loop reads out of the same $?', () => {
    const others = [
      ...Object.values(WaitExitCode),
      ...Object.values(VerifyExitCode),
      ...Object.values(StrictRespondExitCode),
      ...Object.values(InterruptExitCode),
    ].filter((code) => code !== 0);
    expect(others).not.toContain(RoleExitCode.CONFLICT);
    expect(others).not.toContain(RoleExitCode.NOT_SENT);
  });
});
