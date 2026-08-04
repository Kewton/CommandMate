/**
 * Session-start failures whose text is safe to hand back to the caller
 * (Issue #1637).
 *
 * A cold `commandmate send` used to come back as `Error: Server error. Check
 * server logs for details.` (exit 99) while the tmux session and the CLI process
 * it had just launched were both alive and still initializing. Nothing had
 * failed: the server simply stopped watching before the prompt appeared. The
 * caller could not tell that apart from a session that never started, so the
 * observed workaround was to guess and re-send — four times across one
 * orchestration, each time misdiagnosed as a session-creation race.
 *
 * `startClaudeSession()` answers unexpected failures with a fixed generic
 * message on purpose (SEC-SF-002): an arbitrary error can carry a filesystem
 * path or raw CLI output, and neither belongs in an HTTP response. The two
 * errors here are the exception, and they earn it by construction — every
 * message is assembled from a tool name, a tmux session name, a fixed pattern
 * string from `cli-patterns.ts` and a number. Nothing that reaches them came
 * from the environment, so passing them through leaks nothing while restoring
 * the one thing the caller actually needed: what went wrong and what to do.
 *
 * Membership is duck-typed on `code` rather than tested with `instanceof`. The
 * thrower, the API route and the CLI-tool wrapper are separate modules, and a
 * check that depends on them sharing one class identity is exactly the kind
 * that stops matching under bundling — silently reinstating the generic message
 * this module exists to remove.
 *
 * @module lib/session/session-start-error
 */

/** Code for a session that exists and is still coming up. */
export const SESSION_STARTING_CODE = 'SESSION_STARTING';

/** Code for a session that started and then reported a terminal error. */
export const SESSION_START_FAILED_CODE = 'SESSION_START_FAILED';

/** The codes {@link isSafeSessionStartError} recognises. */
const SAFE_CODES: readonly string[] = [SESSION_STARTING_CODE, SESSION_START_FAILED_CODE];

/**
 * The CLI tool's session exists and its process is running, but the interactive
 * prompt was not observed within the start budget.
 *
 * Thrown *without* killing the session: the process is still coming up, and
 * tearing it down would throw away the work that a retry a few seconds later
 * gets for free.
 */
export class SessionStartTimeoutError extends Error {
  /** @see SESSION_STARTING_CODE */
  readonly code = SESSION_STARTING_CODE;

  /**
   * @param toolName - Display name of the CLI tool (e.g. `Claude Code`)
   * @param sessionName - tmux session that was created and left running
   * @param timeoutMs - Budget that elapsed without the prompt appearing
   */
  constructor(
    readonly toolName: string,
    readonly sessionName: string,
    readonly timeoutMs: number
  ) {
    super(
      `${toolName} did not reach its input prompt within ${Math.round(timeoutMs / 1000)}s ` +
        `(initialization timeout). The tmux session '${sessionName}' and its process are ` +
        'still running, so this is a slow start, not a failed one — the message was not ' +
        'delivered, but nothing needs repairing. Retry the send in a few seconds, or run ' +
        '`commandmate capture <worktree-id>` to see what it is waiting on.'
    );
    this.name = 'SessionStartTimeoutError';
  }
}

/**
 * The CLI tool printed an error that startup cannot recover from.
 *
 * Distinct from {@link SessionStartTimeoutError} because retrying changes
 * nothing: the reason is on screen already.
 */
export class SessionStartFailedError extends Error {
  /** @see SESSION_START_FAILED_CODE */
  readonly code = SESSION_START_FAILED_CODE;

  /**
   * @param toolName - Display name of the CLI tool (e.g. `Claude Code`)
   * @param sessionName - tmux session the error was observed in
   * @param detectedPattern - Matched entry from `cli-patterns.ts`; a fixed
   *   string this repository authored, never captured output
   */
  constructor(
    readonly toolName: string,
    readonly sessionName: string,
    readonly detectedPattern: string
  ) {
    super(
      `${toolName} reported an error while starting in tmux session '${sessionName}': ` +
        `"${detectedPattern}". Retrying will not help until that is resolved; run ` +
        '`commandmate capture <worktree-id>` to see the session output.'
    );
    this.name = 'SessionStartFailedError';
  }
}

/**
 * Whether `error` reports a session that is still initializing.
 *
 * @param error - Value caught from a `startSession()` call
 */
export function isSessionStartTimeoutError(error: unknown): error is SessionStartTimeoutError {
  return readErrorCode(error) === SESSION_STARTING_CODE;
}

/**
 * Whether `error`'s message was built by this module and may be returned to the
 * caller as-is.
 *
 * @param error - Value caught from a `startSession()` call
 */
export function isSafeSessionStartError(
  error: unknown
): error is SessionStartTimeoutError | SessionStartFailedError {
  const code = readErrorCode(error);
  return code !== undefined && SAFE_CODES.includes(code);
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
