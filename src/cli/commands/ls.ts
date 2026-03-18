/**
 * ls Command - List worktrees with status
 * Issue #518: [DR1-08] Factory pattern with createLsCommand()
 */

import { Command } from 'commander';
import type { LsOptions } from '../types';
import type { WorktreeListResponse, WorktreeItem } from '../types/api-responses';
import { ApiClient } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';

/**
 * Derive display status from worktree flags.
 */
function deriveStatus(wt: WorktreeItem): string {
  if (wt.isWaitingForResponse) return 'waiting';
  if (wt.isProcessing) return 'running';
  if (wt.isSessionRunning) return 'ready';
  return 'idle';
}

/**
 * Format worktrees as a table for terminal display.
 */
function formatTable(worktrees: WorktreeItem[]): string {
  if (worktrees.length === 0) return 'No worktrees found.';

  const headers = ['ID', 'NAME', 'STATUS', 'DEFAULT'];
  const rows = worktrees.map(wt => [
    wt.id,
    wt.name,
    deriveStatus(wt),
    wt.cliToolId || '-',
  ]);

  // Calculate column widths
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length))
  );

  const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join('  ');
  const separator = colWidths.map(w => '-'.repeat(w)).join('  ');
  const dataLines = rows.map(r =>
    r.map((cell, i) => cell.padEnd(colWidths[i])).join('  ')
  );

  return [headerLine, separator, ...dataLines].join('\n');
}

/**
 * Format output based on options [DR1-02]
 */
function formatOutput(worktrees: WorktreeItem[], options: LsOptions): string {
  if (options.json) {
    return JSON.stringify(worktrees, null, 2);
  }
  if (options.quiet) {
    return worktrees.map(wt => wt.id).join('\n');
  }
  return formatTable(worktrees);
}

/**
 * Create the ls command.
 * [DR1-08] Factory pattern for addCommand() registration.
 */
export function createLsCommand(): Command {
  const cmd = new Command('ls');
  cmd
    .description('List worktrees with status')
    .option('--json', 'JSON output')
    .option('--quiet', 'IDs only (one per line)')
    .option('--branch <prefix>', 'Filter by branch name prefix')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (options: LsOptions) => {
      try {
        const client = new ApiClient({ token: options.token });
        const data = await client.get<WorktreeListResponse>('/api/worktrees');

        let worktrees = data.worktrees;

        // [DR2-08] Filter by name (not branch) prefix
        if (options.branch) {
          worktrees = worktrees.filter(wt =>
            wt.name.startsWith(options.branch!)
          );
        }

        const output = formatOutput(worktrees, options);
        console.log(output);
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
