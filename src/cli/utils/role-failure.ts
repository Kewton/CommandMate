/**
 * The role API's refusals as an exit code (Issue #4116). On its own, free of the file
 * system and of catches, because `message-dispatch.ts` reads it and that is on the
 * paths `wait` / `ask` / `verify` hold to their deadline.
 */

import { ExitCode, RoleExitCode } from '../types';
import { ApiError, type ApiErrorPayload } from './api-client';

/**
 * A role command's failure, with the code `--json` reports. An {@link ApiError}, so
 * `handleCommandError` prints it and exits with its code in a command that has no
 * `--json` of its own.
 */
export class RoleCliError extends ApiError {
  constructor(
    public readonly code: string,
    message: string,
    exitCode: number,
    /** Extra keys of the `--json` failure, such as `candidates` or `references`. */
    public readonly details: Record<string, unknown> = {},
    statusCode?: number,
    payload?: ApiErrorPayload
  ) {
    super(message, exitCode, statusCode, payload);
    this.name = 'RoleCliError';
  }
}

const ROLE_ROUTE_EXITS: Record<string, number> = {
  invalid_request: ExitCode.CONFIG_ERROR,
  not_found: ExitCode.CONFIG_ERROR,
  tool_not_supported: ExitCode.CONFIG_ERROR,
  name_conflict: RoleExitCode.CONFLICT,
  version_conflict: RoleExitCode.CONFLICT,
  role_in_use: RoleExitCode.CONFLICT,
  instance_exists: RoleExitCode.CONFLICT,
  roster_changed: RoleExitCode.CONFLICT,
  // Mirror ROLE_CONDITION_UNMET_CODE and its neighbours in `lib/agent-roles/launch-errors`.
  ROLE_CONDITION_UNMET: RoleExitCode.NOT_SENT,
  ROLE_LAUNCH_REFUSED: RoleExitCode.NOT_SENT,
  SESSION_LAUNCH_ROLE_MISMATCH: RoleExitCode.NOT_SENT,
};

/**
 * The role failure an API error is, or null when it is not one. The management
 * routes put their code in `error` and their sentence in `message`; the send and
 * task routes put the code in `code` and the sentence in `error`.
 */
export function roleFailureFromApi(error: unknown): RoleCliError | null {
  if (!(error instanceof ApiError) || !error.payload) return null;
  const { payload } = error;
  const managementShape = payload.success === false && typeof payload.message === 'string';
  const code = managementShape ? payload.error : payload.code;
  const sentence = managementShape ? payload.message : payload.error;
  if (typeof code !== 'string' || typeof sentence !== 'string') return null;
  // A `not_found` from `/send` is the role's only when it says what became of the setting.
  if (!managementShape && !payload.roleSettings && !code.startsWith('ROLE_') && !code.startsWith('SESSION_LAUNCH_ROLE')) {
    return null;
  }
  const exitCode = ROLE_ROUTE_EXITS[code];
  if (exitCode === undefined) return null;
  const details: Record<string, unknown> = {};
  if (payload.references !== undefined) details.references = payload.references;
  if (payload.currentBodyVersion !== undefined) details.currentBodyVersion = payload.currentBodyVersion;
  if (payload.roleRefusal !== undefined) details.roleRefusal = payload.roleRefusal;
  if (payload.roleSettings !== undefined) details.roleSettings = payload.roleSettings;
  if (payload.sendOutcome !== undefined) details.sendOutcome = payload.sendOutcome;
  const saved = payload.roleSettings?.saved === true
    ? ' The role setting stayed saved, so after a restart the message can be sent again without --role.'
    : '';
  return new RoleCliError(code, `${sentence}${saved}`, exitCode, details, error.statusCode, payload);
}

export function usageError(message: string): RoleCliError {
  return new RoleCliError('invalid_request', message, ExitCode.CONFIG_ERROR);
}
