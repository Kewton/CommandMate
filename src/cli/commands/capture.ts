/**
 * capture Command - Get current terminal output
 * Issue #518: [DR1-08] Factory pattern
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { CaptureOptions } from '../types';
import type { CurrentOutputResponse } from '../types/api-responses';
import { ApiClient, isValidWorktreeId, isValidInstanceId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { isCliToolId } from '../config/cli-tool-ids';

/**
 * Format capture output as JSON (excluding fullOutput for size).
 */
function formatJson(data: CurrentOutputResponse): string {
  const { fullOutput: _fullOutput, ...rest } = data;
  return JSON.stringify(rest, null, 2);
}

export function createCaptureCommand(): Command {
  const cmd = new Command('capture');
  cmd
    .description('Capture current terminal output from a worktree')
    .argument('<worktree-id>', 'Worktree ID')
    .option('--json', 'JSON output (excludes fullOutput)')
    .option('--agent <agent>', 'CLI tool agent (claude, codex, gemini, vibe-local, opencode, copilot)')
    .option('--instance <id>', 'Agent instance ID (defaults to the agent\'s primary instance)')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeId: string, options: CaptureOptions) => {
      try {
        // [SEC4-04] Validate worktree ID
        if (!isValidWorktreeId(worktreeId)) {
          console.error('Error: Invalid worktree ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        if (options.agent && !isCliToolId(options.agent)) {
          console.error('Error: Invalid agent.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Issue #868: Validate instance ID if provided
        if (options.instance && !isValidInstanceId(options.instance)) {
          console.error('Error: Invalid --instance. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const client = new ApiClient({ token: options.token });

        // Build path with optional cliTool/instance query parameters
        const query = new URLSearchParams();
        if (options.agent) {
          query.set('cliTool', options.agent);
        }
        if (options.instance) {
          query.set('instance', options.instance);
        }
        const qs = query.toString();
        const path = `/api/worktrees/${worktreeId}/current-output${qs ? `?${qs}` : ''}`;

        const data = await client.get<CurrentOutputResponse>(path);

        if (options.json) {
          console.log(formatJson(data));
        } else {
          // Default: plain text output (content field)
          console.log(data.content);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
