/**
 * interrupt Command - Stop the turn an agent is currently generating
 * Issue #2101: [DR1-08] Factory pattern
 *
 * The CLI face of `POST /api/worktrees/:id/interrupt`, which the browser UI has
 * had since Issue #46 and which Issue #2034 taught to abort an opencode turn
 * through the agent's own server (`POST /session/:id/abort`) before falling back
 * to the measured Escape-Escape keystroke pair. Nothing in the subcommand list
 * reached it: `stop` stops the CommandMate *server*, and an orchestration that
 * wanted to cut a runaway turn short had to either curl the endpoint or attach
 * to tmux.
 *
 * A thin client, deliberately. Every decision about WHAT gets interrupted —
 * which instances are running, which transport applies, whether the abort took —
 * belongs to the route and to `CLIToolManager`; this file validates its two
 * inputs, POSTs, and translates the route's one expected refusal into an exit
 * code a caller can branch on.
 */

import { Command } from 'commander';
import { ExitCode, InterruptExitCode } from '../types';
import type { InterruptOptions } from '../types';
import type { InterruptResponse } from '../types/api-responses';
import { ApiClient, ApiError, isValidWorktreeId, isValidInstanceId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { INTERRUPT_INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';

/**
 * The route's wording for "the worktree is fine, nothing was generating".
 *
 * Matched on the message rather than on a machine code because the route sends
 * none: `POST /api/worktrees/:id/interrupt` answers a bare
 * `{ error: 'No active sessions found' }` with status 404, exactly as it answers
 * `{ error: "Worktree '<id>' not found" }` with the same status. Both would
 * otherwise collapse into {@link ExitCode.UNEXPECTED_ERROR} through the generic
 * 404 mapping in `handleApiError`, and the two need opposite recoveries — "you
 * are already past the state you wanted" versus "your id is wrong".
 *
 * Adding a `code` to the route would be the better fix and is not available
 * here: `src/app/api/**` is outside this change's file scope. The failure mode
 * of this string going stale is benign and bounded — a renamed message stops
 * being recognised and the command falls back to the generic 404 handling every
 * other CLI command still uses. `tests/unit/cli/commands/interrupt-2101.test.ts`
 * pins the string against the route's own source so the drift is caught here
 * rather than in an orchestration loop.
 */
const NO_ACTIVE_SESSIONS_ERROR = 'No active sessions found';

/**
 * `--json` payload for the no-sessions outcome.
 *
 * `interrupted` is present and empty rather than absent: a caller that reads
 * `.interrupted.length` must not have to special-case the one result where that
 * count is the interesting number. This is the additive JSON contract Epic
 * #2055 asks of every CLI surface — the success shape passes through verbatim,
 * and the one shape the server cannot supply (it answers 404, not a 200 with an
 * empty list) is filled in here using the same field names.
 */
function noActiveSessionsJson(): string {
  const payload: InterruptResponse = {
    success: false,
    message: NO_ACTIVE_SESSIONS_ERROR,
    interrupted: [],
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Create the interrupt command.
 * [DR1-08] Factory pattern for addCommand() registration.
 */
export function createInterruptCommand(): Command {
  const cmd = new Command('interrupt');
  cmd
    .description("Interrupt the turn an agent is generating (same as the GUI's interrupt button)")
    .argument('<worktree-id>', 'Worktree ID')
    .option('--json', 'JSON output (API response as-is)')
    .option('--instance <id>', INTERRUPT_INSTANCE_OPTION_DESCRIPTION)
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeId: string, options: InterruptOptions) => {
      /**
       * Report the no-sessions outcome, honouring `--json`.
       * Declared here so the `--json` branch and the exit code stay together.
       */
      const reportNoActiveSessions = (): void => {
        if (options.json) {
          console.log(noActiveSessionsJson());
        }
        console.error(
          `Error: ${NO_ACTIVE_SESSIONS_ERROR} for worktree '${worktreeId}'`
          + `${options.instance ? ` (instance '${options.instance}')` : ''}. Nothing was interrupted.`
        );
        process.exit(InterruptExitCode.NO_ACTIVE_SESSIONS);
      };

      try {
        // [SEC4-04] Validate worktree ID
        if (!isValidWorktreeId(worktreeId)) {
          console.error('Error: Invalid worktree ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        // Issue #868: the id is embedded in a tmux session name server-side, so
        // it is rejected here before it can reach one.
        if (options.instance && !isValidInstanceId(options.instance)) {
          console.error(
            'Error: Invalid --instance. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).'
          );
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        const client = new ApiClient({ token: options.token });

        // No client-side instance -> tool resolution, unlike `respond` (#1629):
        // this route resolves the backing tool from the roster itself and falls
        // back to reading the instance id as a tool id, so there is no
        // worktree-default fallback for a `--instance` to be silently caught by.
        const body: Record<string, unknown> = {};
        if (options.instance) {
          body.instanceId = options.instance;
        }

        const data = await client.post<InterruptResponse>(
          `/api/worktrees/${worktreeId}/interrupt`,
          body
        );

        if (options.json) {
          // Verbatim, on the `sync --json` precedent: a field the route grows
          // later reaches the caller without a line of code here.
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        console.log(data.message);
        for (const session of data.interrupted ?? []) {
          console.log(`  ${session.instanceId}  ${session.cliToolId}  ${session.sessionName}`);
        }
      } catch (error) {
        if (
          error instanceof ApiError
          && error.statusCode === 404
          && error.payload?.error === NO_ACTIVE_SESSIONS_ERROR
        ) {
          reportNoActiveSessions();
          return;
        }
        // The route's only 400s name the input that could not be resolved
        // ("Invalid instanceId parameter", "Could not resolve CLI tool for the
        // specified instance. Provide cliToolId."), which is more use than the
        // generic "Bad request. Check your input parameters." — same reasoning
        // as `sync`'s 400 passthrough.
        if (error instanceof ApiError && error.statusCode === 400 && error.payload?.error) {
          console.error(`Error: ${error.payload.error}`);
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }
        handleCommandError(error);
      }
    });
  return cmd;
}
