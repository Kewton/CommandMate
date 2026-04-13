/**
 * Context builder for assistant chat sessions
 * Issue #649: Builds initial context message for global assistant sessions
 *
 * Generates a context string containing:
 * - CLI tool usage instructions
 * - Registered repository information
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { getCliToolDisplayName } from '@/lib/cli-tools/types';
import { getAllRepositories, type Repository } from '@/lib/db/db-repository';
import type Database from 'better-sqlite3';

/**
 * Build a context string for a global assistant session.
 *
 * The context includes:
 * 1. A system prompt explaining the assistant's role
 * 2. List of registered repositories with paths
 *
 * @param cliToolId - The CLI tool being used
 * @param db - Database instance for querying repositories
 * @returns Context string to send as the initial message
 */
export function buildGlobalContext(cliToolId: CLIToolType, db: Database.Database): string {
  const toolName = getCliToolDisplayName(cliToolId);
  const repositories = getAllRepositories(db);

  const lines: string[] = [];

  lines.push(`You are an assistant using ${toolName}.`);
  lines.push('');

  if (repositories.length > 0) {
    lines.push('## Registered Repositories');
    lines.push('');
    for (const repo of repositories) {
      const displayName = repo.displayName || repo.name;
      const enabledStatus = repo.enabled ? '' : ' (disabled)';
      lines.push(`- ${displayName}: ${repo.path}${enabledStatus}`);
    }
  } else {
    lines.push('No repositories are currently registered.');
  }

  return lines.join('\n');
}

/**
 * Get enabled repositories from the database.
 * Utility function for external consumers that only need enabled repos.
 *
 * @param db - Database instance
 * @returns Array of enabled Repository objects
 */
export function getEnabledRepositories(db: Database.Database): Repository[] {
  return getAllRepositories(db).filter(r => r.enabled);
}
