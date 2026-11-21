/**
 * The `--model` refusal `send` reports itself, split out of `send.ts` (Issue #4128).
 * `send.ts` re-exports both names.
 */

import { ApiError } from '../utils/api-client';
import { MAX_SERVER_ERROR_DETAIL } from '../utils/api-client-errors';
import { RoleCliError } from '../utils/agent-roles';

/**
 * The `code` of the server's 400 that refuses `--model` (the tool, the value, a running
 * session). Not imported: the CLI does not load route code. Pinned to the route's constant by
 * `tests/unit/cli/commands/cli-small-fixes-4473.test.ts`.
 */
export const MODEL_REFUSED_CODE = 'model_refused';

/**
 * Issue #4473: the 400 that refuses `--model` says why. The shared 400 line is "Bad request.
 * Check your input parameters.", which cannot tell a running session (the model is a launch
 * flag) from a bad value. Only the server's `model_refused` 400 counts — a role, relay, ask,
 * brief or task-target 400 on a send that also carried `--model` is not about the model —
 * and a role failure (RoleCliError) never. Only this command reads the body: the shared
 * classifier is every command's.
 *
 * Exits with the code the shared handler would have used (true is only seen where exit is stubbed);
 * returns false when there is nothing to add.
 */
export function reportModelRefusal(error: unknown, options: { model?: string }): boolean {
  if (!options.model || !(error instanceof ApiError) || error instanceof RoleCliError) return false;
  if (error.statusCode !== 400 || error.payload?.code !== MODEL_REFUSED_CODE) return false;
  const reason = error.payload?.error;
  if (typeof reason !== 'string' || reason.trim() === '') return false;
  const detail = reason.trim();
  console.error(`Error: ${error.message}`);
  console.error(`Server: ${detail.length > MAX_SERVER_ERROR_DETAIL ? `${detail.slice(0, MAX_SERVER_ERROR_DETAIL)}…` : detail}`);
  process.exit(error.exitCode);
  return true;
}
