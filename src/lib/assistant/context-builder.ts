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

function resolveCommandMateBinary(): string {
  return process.env.CM_LAUNCHED_BY === 'commandmate-cli' ? 'commandmate' : 'commandmatedev';
}

/**
 * The CommandMate CLI surface an assistant session is told about.
 *
 * Issue #1914: this used to describe `--agent NAME` as the way to name a
 * target, which has been the *secondary* form since Issue #1638 -- `--agent` is
 * for an ad-hoc session the agent-instance roster does not know, and `--instance`
 * is the flag every targeting command accepts (`wait` has no `--agent` at all).
 * `instances`, `verify`, `sync` and `send --contract` were missing entirely, so
 * an assistant asked to drive a worktree could not name the commands that exist.
 */
function buildCommandMateCliReference(bin: string): string {
  return `## CommandMate CLI Reference

The user runs a CommandMate server locally. These are the CLI commands available from their terminal:

- \`${bin} --version\` — Show version
- \`${bin} init [--defaults]\` — Initialize configuration (interactive / non-interactive)
- \`${bin} start [--dev] [--daemon] [--issue N] [--port N] [--auto-port]\` — Start the server (foreground / dev / background / issue-scoped)
- \`${bin} stop [--issue N]\` — Stop the server
- \`${bin} status [--all] [--issue N]\` — Show running server status
- \`${bin} update [--check] [--yes]\` — Update a globally installed CommandMate
- \`${bin} ls [--json] [--quiet] [--branch PREFIX] [--id PREFIX]\` — List worktrees
- \`${bin} sync [--json]\` — Re-scan registered repositories for worktrees (the GUI sync button)
- \`${bin} send <worktree-id> "message" [--instance ID] [--contract PATH] [--auto-yes] [--duration T]\` — Send a message to an agent session
- \`${bin} wait <worktree-id>... [--timeout N] [--stall-timeout N] [--on-prompt agent|human] [--instance ID] [--verify] [--require-work]\` — Wait until the agent finishes or a prompt appears
- \`${bin} respond <worktree-id> "answer" [--default] [--instance ID]\` — Respond to an agent prompt
- \`${bin} capture <worktree-id> [--json] [--pane] [--tail N] [--prompts] [--instance ID]\` — Capture the current terminal output of a session
- \`${bin} auto-yes <worktree-id> [--enable] [--disable] [--duration T] [--stop-pattern PAT] [--instance ID]\` — Toggle Auto-Yes
- \`${bin} instances <worktree-id> [list|add|remove|alias|kill] [--agent TOOL] [--alias NAME] [--id INSTANCE-ID] [--kill] [--json]\` — Inspect and manage the agent-instance roster of a worktree
- \`${bin} verify <worktree-id> [--gates a,b] [--instance ID] [--json] [--timeout N]\` — Run the verification gates declared in \`.commandmate/verify.yaml\`
- \`${bin} task list|show ...\` / \`${bin} report generate|show|list|metrics ...\` — Execution-contract tasks and daily reports

Targeting an agent:

- \`--instance <id>\` is the way to name the target (\`<agent>\` or \`<agent>-<n>\`, e.g. \`codex-2\`). It is accepted by \`send\` / \`wait\` / \`respond\` / \`capture\` / \`auto-yes\` / \`verify\`, and omitting it means the worktree's primary instance.
- \`--agent <tool>\` is **not** the normal way to select a target (Issue #1638). It only declares the CLI tool for an *ad-hoc* instance the roster does not know — pair it with \`--instance\` (plus \`--register\` on \`send\` to add the instance to the roster). \`wait\` has no \`--agent\` at all.
- Valid CLI tools: \`claude\`, \`codex\`, \`gemini\`, \`vibe-local\`, \`opencode\`, \`copilot\`, \`antigravity\`.

Other notes:

- \`--duration\` accepts values like \`1h\`, \`3h\`, \`8h\`.
- \`send --contract <path>\` records an execution contract (a YAML file under the worktree, e.g. \`.commandmate/tasks/my-task.yaml\`) and sends its preamble plus goal. \`wait --verify\` then adjudicates with the verification gates: exit 20 when a gate fails, 21 when there is nothing to verify.
`;
}

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
  const cliBinary = resolveCommandMateBinary();

  return [
    `You are an assistant using ${toolName}, running inside CommandMate.`,
    '',
    buildCommandMateCliReference(cliBinary),
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
