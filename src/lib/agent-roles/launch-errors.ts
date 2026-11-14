/**
 * Why a launch or a send was refused because of its role (Issue #4115). No imports
 * beyond types, so the send service, the routes and the drivers can all read it.
 *
 * A tool driver wraps what its launch threw in `new Error('Failed to start …: msg')`,
 * which keeps the message and drops the class. So the message carries the reason in
 * a fixed form and {@link readRoleLaunchRefusal} reads either, as the session-start
 * errors do. The message never holds a role's body, only names and paths.
 *
 * @module lib/agent-roles/launch-errors
 */

/** The stable code of a launch refused because of its role. Nothing was typed. */
export const ROLE_LAUNCH_REFUSED_CODE = 'ROLE_LAUNCH_REFUSED';

/** The stable code of a send whose role condition does not hold. Nothing was typed. */
export const ROLE_CONDITION_UNMET_CODE = 'ROLE_CONDITION_UNMET';

/** The stable code of a start refused because another start is running with another role. */
export const SESSION_LAUNCH_ROLE_MISMATCH_CODE = 'SESSION_LAUNCH_ROLE_MISMATCH';

export type RoleLaunchRefusalReason =
  /** The registered roots of this repository hold different settings for the tool. */
  | 'root-settings-differ'
  /** Git could not say whether a root that would disagree belongs to this repository. */
  | 'membership-undetermined'
  /** A role was resolved, and this tool's adapter is not enabled (Antigravity, D3). */
  | 'adapter-disabled'
  /** The user's settings the role has to be composed with could not be read or combined. */
  | 'composition-failed'
  /** The generated file could not be written or did not pass its inspection. */
  | 'artifact-failed'
  /**
   * The CLI said it did not take the role (Copilot's `✗`), or Antigravity's
   * screen showed plainly that it runs without it (Issue #4385).
   */
  | 'not-applied'
  /**
   * Antigravity (Issue #4385): nothing confirms the role on the process now
   * running, so the body was not sent. Its grace ran out, the record of the
   * confirmation is gone (a stop, a server restart, a role set afterwards), the
   * settings could not be read, or they changed while the send was on its way.
   */
  | 'not-confirmed'
  /** The role could not be resolved at all. */
  | 'resolve-failed'
  /** The session was stopped while this start was still resolving its role. */
  | 'session-stopped';

const MARK = /\(role launch refused: ([a-z-]+)\)/;

/** A launch that did not happen because of its role. Nothing was typed. */
export class RoleLaunchRefusedError extends Error {
  readonly code = ROLE_LAUNCH_REFUSED_CODE;

  constructor(
    public readonly reason: RoleLaunchRefusalReason,
    message: string
  ) {
    super(`${message} (role launch refused: ${reason})`);
    this.name = 'RoleLaunchRefusedError';
  }
}

/** The reason when `error` is, or wraps the message of, a {@link RoleLaunchRefusedError}. */
export function readRoleLaunchRefusal(error: unknown): RoleLaunchRefusalReason | null {
  if (error instanceof RoleLaunchRefusedError) return error.reason;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = MARK.exec(message);
  return match ? (match[1] as RoleLaunchRefusalReason) : null;
}

/** A condition on a send's role did not hold right before the body. Nothing was typed. */
export class RoleConditionUnmetError extends Error {
  readonly code = ROLE_CONDITION_UNMET_CODE;

  constructor(message: string) {
    super(`${message} (${ROLE_CONDITION_UNMET_CODE})`);
    this.name = 'RoleConditionUnmetError';
  }
}

/** Whether `error` is, or wraps the message of, a {@link RoleConditionUnmetError}. */
export function isRoleConditionUnmet(error: unknown): boolean {
  if (error instanceof RoleConditionUnmetError) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.includes(`(${ROLE_CONDITION_UNMET_CODE})`);
}
