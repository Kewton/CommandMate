/**
 * Error classification for the CLI API client (split out of api-client.ts, Issue #4058).
 * api-client.ts re-exports every exported name here; import from there.
 */

import { ExitCode } from '../types';

/**
 * Error result from API operations
 */
export interface ApiErrorResult {
  message: string;
  exitCode: number;
}

/**
 * The server's own explanation for a failure, when it sent one worth showing.
 *
 * Issue #1637: every 5xx used to be flattened into `Server error. Check server
 * logs for details.`, which is only useful to someone who has the server logs.
 * A cold-start `send` failed with an initialization timeout and told the
 * operator nothing but "go read the logs" — four orchestration runs in a row
 * then misdiagnosed it as a session-creation race and worked around it by
 * re-sending. Every route in this codebase already answers `{ error }`, so the
 * cause was always in the response body; nothing read it.
 *
 * Trimmed and length-capped because it is printed to a terminal, and an
 * unbounded server string is not something a CLI should paste verbatim.
 */
const MAX_SERVER_ERROR_DETAIL = 2000;

function serverErrorDetail(payload?: ApiErrorPayload): string | undefined {
  const detail = typeof payload?.error === 'string' ? payload.error.trim() : '';
  if (detail === '') return undefined;
  return detail.length > MAX_SERVER_ERROR_DETAIL
    ? `${detail.slice(0, MAX_SERVER_ERROR_DETAIL)}…`
    : detail;
}

/**
 * What this function knows about the request, beyond its status (Issue #2404).
 *
 * `handleApiError` is a pure classifier over `(status, payload)` and has no way
 * to know which server answered — which is exactly the fact a 404 needs. The
 * caller's `Resource not found. Check the worktree ID.` sent an agent looking
 * for a typo in an id that was correct: the CLI was dialling a *different*
 * CommandMate server than the one that had started its session, and the id it
 * was asking about lived on the other one. Optional so the two callers that
 * classify without a client ({@link ApiClient} aside, `server-capabilities.ts`)
 * keep compiling and keep their wording.
 */
export interface ApiErrorContext {
  /** The base URL the failing request was actually sent to. */
  serverUrl?: string;
}

/** Append `(server: <url>)` when the caller named one. */
export function withServerUrl(message: string, context?: ApiErrorContext): string {
  return context?.serverUrl ? `${message} (server: ${context.serverUrl})` : message;
}

/**
 * The `code` the server sends with the 409 for a tmux session another
 * CommandMate server created (Issue #2865). Spelled out rather than imported:
 * the server's constant lives next to the tmux gateway, which the CLI must not
 * load. `tests/unit/cli/utils/api-client-foreign-session-3334.test.ts` pins the
 * two to the same string.
 */
export const FOREIGN_SESSION_ERROR_CODE = 'session_owned_by_other_server';

/**
 * Issue #3334: what the operator reads for that 409. It has to say three
 * things the status alone does not: the session is another CommandMate
 * server's, this command therefore did nothing to it, and where to go instead.
 */
export function foreignSessionMessage(payload?: ApiErrorPayload): string {
  const name = typeof payload?.sessionName === 'string' && payload.sessionName !== ''
    ? `"${payload.sessionName}" `
    : '';
  const where = typeof payload?.sessionPath === 'string' && payload.sessionPath !== ''
    ? ` (it was started in ${payload.sessionPath})`
    : '';
  return (
    `The tmux session ${name}belongs to another CommandMate server${where}, ` +
    'so nothing was sent to it, read from it or stopped. ' +
    'Use the CommandMate server that started it, or stop that session there first.'
  );
}

/**
 * Classify API errors into user-friendly messages and exit codes.
 * [IA3-09] Covers: ECONNREFUSED, 400, 401/403, 404, 429, 500, timeout
 *
 * @param error - Error object or unknown
 * @param status - HTTP status code if available
 * @param payload - Parsed error body, when the response carried one (Issue #1637).
 *   Used for 5xx, and for the foreign-session 409 (Issue #3334): the other 4xx
 *   messages below are already specific, and are pinned by tests as the CLI's
 *   own wording.
 * @param context - Which server answered, when the caller knows (Issue #2404).
 *   Read by the 404 branch only; the other messages do not send anyone looking
 *   in the wrong place.
 * @returns User-friendly error message and exit code
 */
export function handleApiError(
  error: unknown,
  status?: number,
  payload?: ApiErrorPayload,
  context?: ApiErrorContext
): ApiErrorResult {
  // HTTP status-based errors
  if (status !== undefined) {
    switch (status) {
      case 400:
        return {
          message: 'Bad request. Check your input parameters.',
          exitCode: ExitCode.CONFIG_ERROR,
        };
      case 401:
      case 403:
        // Issue #2489: the second sentence is the one that matters during a
        // `commandmate remote` session. `remote` mints the token, hands its
        // plaintext to the phone once through the pairing handoff and deletes
        // it — so "set CM_AUTH_TOKEN" names a value the operator has no way to
        // obtain, and following that advice is a dead end (#2489's report spent
        // a session there). `--auth remote-only` is the exit: it leaves the
        // loopback listener this client dials unauthenticated while the
        // Provider's listener keeps demanding the token.
        return {
          message:
            'Authentication failed. Use --token <token> or set CM_AUTH_TOKEN environment variable. ' +
            'During a "commandmate remote" session the token is only ever shown to the paired phone — ' +
            'restart it with "commandmate remote --auth remote-only" to use the CLI from this machine without one.',
          exitCode: ExitCode.CONFIG_ERROR,
        };
      case 404:
        // Issue #2404: the sentence stays, so everything matching on it keeps
        // matching; the URL is appended because "check the worktree ID" is
        // advice about the wrong thing whenever the id is fine and the SERVER
        // is the one that is wrong.
        return {
          message: withServerUrl('Resource not found. Check the worktree ID.', context),
          exitCode: ExitCode.UNEXPECTED_ERROR,
        };
      case 409:
        // Issue #3334: the one 409 every session route shares (#2865 / #3290).
        // Without this it read "Unexpected HTTP status: 409", which does not say
        // that nothing was done, nor why. Same exit code as that default branch,
        // so a script branching on it sees no change. Every other 409 keeps the
        // default wording below — the commands that own one (send's
        // PROMPT_WAITING, verify's running run) already explain it themselves.
        if (payload?.code === FOREIGN_SESSION_ERROR_CODE) {
          return {
            message: foreignSessionMessage(payload),
            exitCode: ExitCode.UNEXPECTED_ERROR,
          };
        }
        return {
          message: `Unexpected HTTP status: ${status}`,
          exitCode: ExitCode.UNEXPECTED_ERROR,
        };
      case 429:
        return {
          message: 'Rate limited. Please retry after a moment.',
          exitCode: ExitCode.DEPENDENCY_ERROR,
        };
      case 500:
      default:
        if (status >= 500) {
          // Issue #1637: pass the server's own reason through. The prefix is
          // kept so "this came from the server, not from the CLI" survives, and
          // so does the log pointer when the body said nothing.
          const detail = serverErrorDetail(payload);
          return {
            message: detail
              ? `Server error: ${detail}`
              : 'Server error. Check server logs for details.',
            exitCode: ExitCode.UNEXPECTED_ERROR,
          };
        }
        return {
          message: `Unexpected HTTP status: ${status}`,
          exitCode: ExitCode.UNEXPECTED_ERROR,
        };
    }
  }

  // Network/connection errors
  if (error instanceof Error) {
    const msg = error.message || '';
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return {
        message: 'Server is not running. Start it with: commandmate start',
        exitCode: ExitCode.DEPENDENCY_ERROR,
      };
    }
    if (error.name === 'AbortError' || msg.includes('timeout') || msg.includes('Timeout')) {
      return {
        message: 'Server did not respond in time. Check server status.',
        exitCode: ExitCode.DEPENDENCY_ERROR,
      };
    }
    if (error.name === 'TypeError') {
      return {
        message: 'Network error. Check your connection and server status.',
        exitCode: ExitCode.DEPENDENCY_ERROR,
      };
    }
  }

  return {
    message: 'An unexpected error occurred.',
    exitCode: ExitCode.UNEXPECTED_ERROR,
  };
}

/**
 * Machine-readable part of a failed API response (Issue #1237).
 * Every Skill route answers `{ error, code }`; the uninstall routes add `blockers`.
 */
export interface ApiErrorPayload {
  code?: string;
  error?: string;
  blockers?: Array<{ code: string; path: string | null }>;
  /** Issue #1544: run already in flight, sent with the verify route's 409. */
  runningRunId?: number;
  /**
   * Issue #1545: every task-contract violation, sent with the tasks route's 400.
   * Printed in full so a broken contract is fixed in one pass, not one round
   * trip per mistake.
   */
  issues?: string[];
  /** Issue #2865: sent with the foreign-session 409 (`session_owned_by_other_server`). */
  sessionName?: string;
  sessionPath?: string | null;
  /**
   * Issue #3957/#3992: sent with the send route's errors after a bound relay
   * was reserved — `not_sent`: nothing reached the session, it may be sent
   * again; `unknown`: it may have, look before resending. Issue #4011: also
   * on a failure of a send with no bound relay that was recorded as its
   * attempt (`not-sent` → `not_sent`, otherwise `unknown`; no 400). Mirrors
   * src/lib/relay/relay-bind.ts RelaySendOutcome (and ChatMessage.sendOutcome).
   */
  sendOutcome?: 'sent' | 'not_sent' | 'unknown';
}

/**
 * API Error with exit code for CLI process.exit()
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly statusCode?: number,
    /** Typed error body, when the server sent one (Issue #1237). */
    public readonly payload?: ApiErrorPayload,
    /**
     * The error `fetch` threw, when no HTTP response came back (Issue #3756):
     * the strict `respond` tells "never connected" (nothing can have been sent)
     * from "the connection broke" by its `cause.code`.
     */
    public readonly transportError?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Stable machine code the server assigned to this failure, if any. */
  get apiCode(): string | undefined {
    return this.payload?.code;
  }
}
