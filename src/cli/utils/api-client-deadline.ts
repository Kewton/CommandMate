/**
 * The command-deadline error and its predicates (split out of api-client.ts, Issue #4058).
 * api-client.ts re-exports every exported name here; import from there.
 */

import { WaitExitCode } from '../types';
import { ApiError, withServerUrl } from './api-client-errors';

/**
 * A request ended by the deadline of a client from {@link ApiClient.withDeadline}
 * (Issue #3983).
 *
 * An `ApiError` with exit 124 so that the commands' own error handling reports
 * it as the timeout it is, and a class of its own so that a catch which turns
 * failures into a degraded result ("verification resolves its own task", "use
 * the selector as an instance id") can tell it apart and rethrow it — see
 * {@link isDeadlineExceeded}. Wrapped into another `ApiError`, it travels as
 * that error's `transportError`.
 */
export class DeadlineExceededError extends ApiError {
  constructor(serverUrl?: string) {
    super(
      withServerUrl('--timeout reached before the server answered', { serverUrl }),
      WaitExitCode.TIMEOUT,
    );
    this.name = 'DeadlineExceededError';
  }
}

/**
 * Whether `error` is — or wraps — a request ended by a command deadline
 * (Issue #3983). The catches that degrade on failure ask this first and
 * rethrow: a deadline is the command's answer, not a reason to carry on.
 */
export function isDeadlineExceeded(error: unknown): error is ApiError {
  if (error instanceof DeadlineExceededError) return true;
  if (error instanceof ApiError && error.transportError instanceof DeadlineExceededError) return true;
  return error instanceof Error && error.cause instanceof DeadlineExceededError;
}

/** Rethrow `error` when it is a command deadline; otherwise return (Issue #3983). */
export function rethrowIfDeadlineExceeded(error: unknown): void {
  if (isDeadlineExceeded(error)) throw error;
}
