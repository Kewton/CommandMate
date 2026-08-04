/**
 * sync Command - Trigger a server-side worktree re-scan
 * Issue #1680: worktrees created with `git worktree add` stay invisible to
 * `commandmate ls` until the GUI sync button is pressed. This command calls the
 * same endpoint (POST /api/repositories/sync) so worktree creation → dispatch
 * completes from the CLI alone.
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { SyncOptions } from '../types';
import type { RepositorySyncResponse } from '../types/api-responses';
import { ApiClient, ApiError } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';

/**
 * Create the sync command.
 * [DR1-08] Factory pattern for addCommand() registration.
 */
export function createSyncCommand(): Command {
  const cmd = new Command('sync');
  cmd
    .description('Re-scan repositories and sync worktrees to the server (same as the GUI sync button)')
    .option('--json', 'JSON output (API response as-is)')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (options: SyncOptions) => {
      try {
        const client = new ApiClient({ token: options.token });
        const data = await client.post<RepositorySyncResponse>('/api/repositories/sync');

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        console.log(data.message);
        if (data.deletedCount > 0) {
          console.log(`Removed ${data.deletedCount} stale worktree(s).`);
        }
        for (const warning of data.cleanupWarnings ?? []) {
          console.error(`Warning: ${warning}`);
        }
      } catch (error) {
        // The route's only 400 is "No repositories configured..." — the server's
        // wording names the fix (WORKTREE_REPOS / CM_ROOT_DIR), so pass it
        // through instead of the generic "Bad request" mapping.
        if (error instanceof ApiError && error.statusCode === 400 && error.payload?.error) {
          console.error(`Error: ${error.payload.error}`);
          process.exit(ExitCode.CONFIG_ERROR);
        }
        handleCommandError(error);
      }
    });
  return cmd;
}
