/**
 * auto-yes Command - Control auto-yes for a worktree
 * Issue #518: [DR1-08] Factory pattern
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { AutoYesOptions } from '../types';
import type { AutoYesSetResult } from '../types/api-responses';
import { ApiClient, isValidWorktreeId, isValidInstanceId, MAX_STOP_PATTERN_LENGTH } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { parseDurationToMs, ALLOWED_DURATIONS } from '../config/duration-constants';
import { isCliToolId } from '../config/cli-tool-ids';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import { resolveInstanceCliTool } from './instances';

/**
 * Report what arming Auto-Yes actually did: which agent (Issue #1909) and what
 * it answered on the way in (Issue #1898-2).
 *
 * Both halves are read off the response rather than worked out here. For the
 * agent that is a rule, not a convenience: a bare `auto-yes <id> --enable`
 * deliberately sends no `cliToolId`, the server applies the precedence chain
 * (roster > explicit > primary anchor > worktree default) that `send` / `wait` /
 * `capture` also get, and resolving it a second time in the CLI is how the two
 * answers diverged in the first place (design §4 D5 決定 1 / DR2-008). The
 * server names what it chose; this only prints it.
 *
 * @param worktreeId - Worktree the command targeted
 * @param result - Body of the auto-yes POST, or undefined from an old daemon
 */
function reportEnabled(worktreeId: string, result: AutoYesSetResult | undefined): void {
  const agent = result?.cliToolId;
  const instanceId = result?.instanceId;
  // `instanceId === cliToolId` is how the primary instance is spelled (#868);
  // repeating it as "copilot (copilot)" would be noise.
  const label = agent && instanceId && instanceId !== agent
    ? `${agent}, instance ${instanceId}`
    : agent;
  console.error(
    label
      ? `Auto-yes enabled for ${worktreeId} (${label}).`
      : `Auto-yes enabled for ${worktreeId}.`
  );

  // Issue #1898-2: enabling Auto-Yes under a dialog that was already up used to
  // do nothing at all, silently. If it answered something on the way in, say so
  // — that is the difference between "armed for next time" and "the worker you
  // were unsticking is moving again". Printed after the agent line because the
  // approvals it re-judged are that agent's (#1909).
  const pending = result?.pendingDecisions;
  if (pending && pending.examined > 0) {
    console.error(
      `Re-judged ${pending.examined} pending approval(s): ` +
        `${pending.delivered} answered` +
        `${pending.skipped > 0 ? `, ${pending.skipped} skipped (limit)` : ''}.`,
    );
  }
}

export function createAutoYesCommand(): Command {
  const cmd = new Command('auto-yes');
  cmd
    .description('Control auto-yes for a worktree')
    .argument('<worktree-id>', 'Worktree ID')
    .option('--enable', 'Enable auto-yes')
    .option('--disable', 'Disable auto-yes')
    .option('--duration <duration>', `Duration (${ALLOWED_DURATIONS.join(', ')})`)
    .option('--stop-pattern <pattern>', 'Stop pattern (regex, max 500 chars). Matched against terminal output; cannot block commands (build logs mentioning the pattern also trigger it). To suppress auto-responses per command, use the task contract\'s autoYes.denyPatterns')
    .option('--instance <id>', INSTANCE_OPTION_DESCRIPTION)
    .option('--agent <agent>', AGENT_OPTION_DESCRIPTION)
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeId: string, options: AutoYesOptions) => {
      try {
        // [SEC4-04] Validate worktree ID
        if (!isValidWorktreeId(worktreeId)) {
          console.error('Error: Invalid worktree ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Must specify --enable or --disable
        if (!options.enable && !options.disable) {
          console.error('Error: Specify --enable or --disable.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        if (options.enable && options.disable) {
          console.error('Error: Cannot specify both --enable and --disable.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        if (options.agent && !isCliToolId(options.agent)) {
          console.error('Error: Invalid agent.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Issue #896: Validate instance ID if provided
        if (options.instance && !isValidInstanceId(options.instance)) {
          console.error('Error: Invalid --instance. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // [SEC4-06] Validate stop-pattern length
        if (options.stopPattern && options.stopPattern.length > MAX_STOP_PATTERN_LENGTH) {
          console.error(`Error: stop-pattern exceeds maximum length of ${MAX_STOP_PATTERN_LENGTH} characters.`);
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const client = new ApiClient({ token: options.token });

        const body: Record<string, unknown> = {
          enabled: !!options.enable,
        };

        if (options.enable) {
          // [DR2-02] Convert duration string to ms
          const durationMs = options.duration
            ? parseDurationToMs(options.duration)
            : parseDurationToMs('1h');

          if (durationMs === null) {
            console.error(`Error: Invalid duration. Must be one of: ${ALLOWED_DURATIONS.join(', ')}`);
            process.exit(ExitCode.CONFIG_ERROR);
          }

          body.duration = durationMs;

          if (options.stopPattern) {
            body.stopPattern = options.stopPattern;
          }
        }

        // Issue #1629: the auto-yes poller keys on (worktree, cliTool, instance)
        // and watches the session cliTool names, so the instance must be paired
        // with the CLI tool its roster entry declares.
        const agent = options.instance
          ? await resolveInstanceCliTool(client, worktreeId, options.instance, options.agent)
          : options.agent;

        if (agent) {
          body.cliToolId = agent;
        }

        // Issue #896: per-instance auto-yes
        if (options.instance) {
          body.instanceId = options.instance;
        }

        const result = await client.post<AutoYesSetResult | undefined>(
          `/api/worktrees/${worktreeId}/auto-yes`,
          body,
        );

        if (options.enable) {
          reportEnabled(worktreeId, result);
        } else {
          console.error(`Auto-yes disabled for ${worktreeId}.`);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
