/**
 * verify Command - Run the repository verification gates for a worktree
 * Issue #1544
 *
 * Exit codes:
 * - 0:   SUCCESS (every gate passed)
 * - 20:  VERIFY_FAILED (a gate failed, timed out, or errored)
 * - 21:  NOT_STARTED (work-evidence found nothing to verify)
 * - 124: TIMEOUT (--timeout elapsed before the run reached a verdict)
 * Infrastructure errors and verdict-less runs use ExitCode (1, 2, 99).
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { VerifyOptions } from '../types';
import { ApiClient, isValidWorktreeId, isValidInstanceId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { parseGateIds, runVerification } from '../utils/verify-runner';

export function createVerifyCommand(): Command {
  const cmd = new Command('verify');
  cmd
    .description('Run the verification gates declared in .commandmate/verify.yaml for a worktree')
    .argument('<worktree-id>', 'Worktree ID to verify')
    .option('--instance <id>', 'Agent instance ID the run is attributed to (e.g. codex-2)')
    .option(
      '--gates <ids>',
      'Comma-separated gate ids to run (default: work-evidence plus every declared gate)'
    )
    .option('--json', 'Print the run and its gate results as JSON on stdout')
    .option('--timeout <seconds>', 'Stop polling after this many seconds (exit 124)', parseInt)
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeId: string, options: VerifyOptions) => {
      try {
        if (!isValidWorktreeId(worktreeId)) {
          console.error(`Error: Invalid worktree ID format: ${worktreeId}`);
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        if (options.instance && !isValidInstanceId(options.instance)) {
          console.error(
            'Error: Invalid --instance. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).'
          );
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        const gateIds = parseGateIds(options.gates);
        if (gateIds === null) {
          console.error('Error: --gates must name at least one gate id.');
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        const client = new ApiClient({ token: options.token });
        const outcome = await runVerification(client, {
          worktreeId,
          trigger: 'manual',
          instanceId: options.instance,
          gateIds,
          timeoutSec: options.timeout,
          suppressResultLine: options.json,
        });

        if (options.json && outcome.run) {
          console.log(JSON.stringify(outcome.run));
        }
        process.exit(outcome.exitCode);
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
