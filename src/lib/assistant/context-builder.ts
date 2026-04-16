/**
 * Context builder for assistant chat sessions.
 *
 * Generates a context string containing:
 * - CommandMate CLI command reference
 * - Registered repositories (name, path, alias, worktree count)
 * - Active worktree session statuses (snapshot at session start; not refreshed per message)
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { getCliToolDisplayName, CLI_TOOL_DISPLAY_NAMES } from '@/lib/cli-tools/types';
import { getAllRepositories, type Repository } from '@/lib/db/db-repository';
import { getWorktrees } from '@/lib/db/worktree-db';
import type Database from 'better-sqlite3';

const COMMANDMATE_CLI_REFERENCE = `## CommandMate CLI Reference

The user runs a CommandMate server locally. These are the CLI commands available from their terminal:

- \`commandmate --version\` — Show version
- \`commandmate init [--defaults]\` — Initialize configuration (interactive / non-interactive)
- \`commandmate start [--dev] [--daemon] [--issue N] [--port N] [--auto-port]\` — Start the server (foreground / dev / background / issue-scoped)
- \`commandmate stop [--issue N]\` — Stop the server
- \`commandmate status [--all] [--issue N]\` — Show running server status
- \`commandmate ls [--json] [--quiet] [--branch PREFIX]\` — List worktrees
- \`commandmate send <worktree-id> "message" [--agent NAME] [--auto-yes] [--duration T]\` — Send a message to an agent session
- \`commandmate wait <worktree-id>... [--timeout N] [--stall-timeout N] [--on-prompt TYPE]\` — Wait until the agent finishes or a prompt appears
- \`commandmate respond <worktree-id> "answer" [--agent NAME]\` — Respond to an agent prompt
- \`commandmate capture <worktree-id> [--json] [--agent NAME]\` — Capture the current terminal output of a session
- \`commandmate auto-yes <worktree-id> [--enable] [--disable] [--duration T] [--stop-pattern PAT]\` — Toggle Auto-Yes
- \`--duration\` accepts values like \`1h\`, \`3h\`, \`8h\`.
- \`--agent\` selects the CLI tool: \`claude\`, \`codex\`, \`gemini\`, \`vibe-local\`, \`opencode\`, \`copilot\`.
`;

function buildRepositoriesSection(db: Database.Database): string {
  const repositories = getAllRepositories(db);
  if (repositories.length === 0) {
    return '## Registered Repositories\n\nNo repositories are currently registered.';
  }

  const lines: string[] = ['## Registered Repositories', ''];
  lines.push('| Alias | Name | Path | Worktrees | Enabled |');
  lines.push('|-------|------|------|-----------|---------|');
  for (const repo of repositories) {
    const alias = repo.displayName && repo.displayName !== repo.name ? repo.displayName : '-';
    const worktreeCount = getWorktrees(db, repo.path).length;
    const enabled = repo.enabled ? 'yes' : 'no';
    lines.push(`| ${alias} | ${repo.name} | ${repo.path} | ${worktreeCount} | ${enabled} |`);
  }
  return lines.join('\n');
}

function formatCliLabel(cliToolId: string | null | undefined): string {
  if (!cliToolId) {
    return '-';
  }
  const asType = cliToolId as CLIToolType;
  return CLI_TOOL_DISPLAY_NAMES[asType] ?? cliToolId;
}

const ACTIVE_WORKTREE_SNAPSHOT_LIMIT = 30;

function buildActiveWorktreesSection(db: Database.Database, takenAt: Date): string {
  const worktrees = getWorktrees(db);
  const active = worktrees
    .filter((w) => w.status && w.status !== 'done')
    .slice(0, ACTIVE_WORKTREE_SNAPSHOT_LIMIT);

  const lines: string[] = [
    '## Active Worktree Session Snapshot',
    `Snapshot taken at: ${takenAt.toISOString()} (not refreshed per message)`,
    '',
  ];

  if (active.length === 0) {
    lines.push('_No worktree sessions had an active status at snapshot time._');
    return lines.join('\n');
  }

  lines.push('| Repository | Branch | CLI | Status | Path |');
  lines.push('|------------|--------|-----|--------|------|');
  for (const w of active) {
    const repo = w.repositoryDisplayName || w.repositoryName || '-';
    const branch = w.name;
    const cli = formatCliLabel(w.cliToolId);
    const status = w.status ?? '-';
    lines.push(`| ${repo} | ${branch} | ${cli} | ${status} | ${w.path} |`);
  }
  return lines.join('\n');
}

/**
 * Build the startup context snapshot for the assistant conversation.
 *
 * Called once at session start. The returned string is stored on the
 * conversation record and reused verbatim on every subsequent message
 * so repository/worktree state does not silently drift mid-conversation.
 */
export function buildAssistantStartupSnapshot(
  cliToolId: CLIToolType,
  db: Database.Database,
  takenAt: Date = new Date(),
): string {
  const toolName = getCliToolDisplayName(cliToolId);

  return [
    `You are an assistant using ${toolName}, running inside CommandMate.`,
    '',
    COMMANDMATE_CLI_REFERENCE,
    buildRepositoriesSection(db),
    '',
    buildActiveWorktreesSection(db, takenAt),
  ].join('\n');
}

/**
 * Build a context string for an assistant session.
 *
 * For interactive (tmux) sessions this is called once at session start.
 * For non-interactive sessions the stored `conversation.contextSnapshot`
 * is preferred; this function is the fallback when no snapshot exists yet.
 */
export function buildGlobalContext(cliToolId: CLIToolType, db: Database.Database): string {
  return buildAssistantStartupSnapshot(cliToolId, db);
}

/**
 * Get enabled repositories from the database.
 */
export function getEnabledRepositories(db: Database.Database): Repository[] {
  return getAllRepositories(db).filter((r) => r.enabled);
}
