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

/**
 * Code for a start that could not even be attempted — the CLI is not on PATH.
 *
 * Issue #2009: every one of the seven tools already detects this, and every one
 * of them threw a bare `Error`, so nothing downstream could tell "the binary is
 * missing" (install it) from "tmux refused" (something else is wrong) from "it
 * is merely slow" (wait). The code is what lets the ONE notification decision in
 * `lib/push/failure-push-notifier` answer all three differently.
 */
export const SESSION_START_UNAVAILABLE_CODE = 'SESSION_START_UNAVAILABLE';

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
 * The CLI tool is not installed, so no session could be attempted.
 *
 * Issue #2009. The message defaults to the wording `POST /api/worktrees/:id/send`
 * used to compose at the HTTP layer, so a tool that has nothing more useful to
 * say keeps the body its callers already read; a tool that DOES (copilot ships
 * an install hint) passes its own.
 *
 * Deliberately NOT in {@link SAFE_CODES}: that list is #1637's exception to
 * SEC-SF-002 for `startClaudeSession`'s catch, and widening it would change
 * which messages that catch lets past. Nothing throws this from inside that
 * try block — claude's own install check runs before it — so membership would
 * buy nothing and cost the reader a reason to re-audit #1637.
 */
export class SessionStartUnavailableError extends Error {
  /** @see SESSION_START_UNAVAILABLE_CODE */
  readonly code = SESSION_START_UNAVAILABLE_CODE;

  /**
   * @param toolName - Display name of the CLI tool (e.g. `Codex CLI`)
   * @param message - Tool-specific wording; defaults to the generic advice
   */
  constructor(
    readonly toolName: string,
    message = `${toolName} is not installed. Please install it first.`
  ) {
    super(message);
    this.name = 'SessionStartUnavailableError';
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

/**
 * Whether `error` reports a CLI tool that is not installed (Issue #2009).
 *
 * Duck-typed on `code` for the reason the module docblock gives: the thrower
 * (seven separate tool modules) and the reader (the push notifier, the API
 * route) never share a class identity under bundling.
 *
 * @param error - Value caught from a `startSession()` call
 */
export function isSessionStartUnavailableError(
  error: unknown
): error is SessionStartUnavailableError {
  return readErrorCode(error) === SESSION_START_UNAVAILABLE_CODE;
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
