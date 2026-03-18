/**
 * auto-yes Command - Control auto-yes for a worktree
 * Issue #518: [DR1-08] Factory pattern
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { AutoYesOptions } from '../types';
import { ApiClient, isValidWorktreeId, MAX_STOP_PATTERN_LENGTH } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { parseDurationToMs, ALLOWED_DURATIONS } from '../config/duration-constants';
import { isCliToolId } from '../config/cli-tool-ids';

export function createAutoYesCommand(): Command {
  const cmd = new Command('auto-yes');
  cmd
    .description('Control auto-yes for a worktree')
    .argument('<worktree-id>', 'Worktree ID')
    .option('--enable', 'Enable auto-yes')
    .option('--disable', 'Disable auto-yes')
    .option('--duration <duration>', `Duration (${ALLOWED_DURATIONS.join(', ')})`)
    .option('--stop-pattern <pattern>', 'Stop pattern (regex, max 500 chars)')
    .option('--agent <agent>', 'CLI tool agent (claude, codex, gemini, vibe-local, opencode)')
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

        if (options.agent) {
          body.cliToolId = options.agent;
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
