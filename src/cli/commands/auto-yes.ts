/**
 * auto-yes Command - Control auto-yes for a worktree
 * Issue #518: [DR1-08] Factory pattern
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { AutoYesOptions } from '../types';
import { ApiClient, isValidWorktreeId, isValidInstanceId, MAX_STOP_PATTERN_LENGTH } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { parseDurationToMs, ALLOWED_DURATIONS } from '../config/duration-constants';
import { isCliToolId } from '../config/cli-tool-ids';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import { resolveInstanceCliTool } from './instances';

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

        await client.post<void>(`/api/worktrees/${worktreeId}/auto-yes`, body);

        if (options.enable) {
          console.error(`Auto-yes enabled for ${worktreeId}.`);
        } else {
          console.error(`Auto-yes disabled for ${worktreeId}.`);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
