/**
 * peers Command - the other agent sessions this one can talk to (Issue #2376)
 *
 *   commandmate peers [--json]
 *
 * ## Why `ls` + `instances` was not enough
 *
 * The two ids `ask` needs live in two different commands and neither one knows
 * the caller. `ls` lists every worktree on the machine — including the dozen
 * belonging to repositories this session has nothing to do with — and
 * `instances` needs a worktree id per call. So working out "who can I ask?" was
 * a fan-out plus a filter the agent had to invent, and inventing it is what
 * produced the wrong `--instance` values this Issue exists to stop.
 *
 * This is that fan-out, done once, narrowed to the caller's own repository, with
 * the caller's own row marked `(you)` and a ready-to-run `ask` line against
 * every other row. The listing is the answer AND the example: the acceptance
 * criterion for this command is that a line pasted out of it works.
 *
 * Scoped to the repository rather than to everything because that is the unit a
 * delegation is about — sibling worktrees of one project, which is what
 * `/worktree-setup` produces — and because a global listing is what `ls`
 * already is.
 */

import { Command } from 'commander';
import type { AgentInstance, WorktreeItem, WorktreeListResponse } from '../types/api-responses';
import { ApiClient } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { resolveCommandMateBinary } from '../../lib/cli/command-reference';
import {
  NOT_IN_SESSION,
  NOT_IN_SESSION_MESSAGE,
  detectServerMismatch,
  formatServerMismatchWarning,
  resolveSessionIdentity,
  type SessionIdentity,
} from './whoami';

/**
 * The repository fields the list API sends and `WorktreeItem` does not declare.
 *
 * `src/cli/types/api-responses.ts` declares only the fields the CLI reads ("Only
 * the fields the CLI reads are declared"), and until this command nothing read
 * these two. Mirrored locally rather than widened there so the shared type keeps
 * meaning what its header says it means; both are optional because a row written
 * before the field existed, or by a non-sync path, carries neither.
 */
interface PeerWorktreeItem extends WorktreeItem {
  repositoryPath?: string;
  repositoryName?: string;
}

/** One session in the listing. */
interface PeerRow {
  worktreeId: string;
  instanceId: string;
  cliTool: string;
  alias: string;
  /** The worktree's aggregate STATUS word, as `commandmate ls` prints it. */
  status: string;
  /** True for the session running this command. */
  isSelf: boolean;
  /** The line to paste, or null for the caller's own row. */
  ask: string | null;
}

/**
 * The four-word status vocabulary, derived exactly as `ls` derives it.
 *
 * Duplicated from `ls.ts` rather than shared: this is three lines of precedence
 * over three booleans, and the alternative — exporting `deriveStatus` from a
 * command module so another command module can import it — couples two
 * commands to save nothing. The vocabulary itself is pinned by `ls`'s own tests.
 */
function deriveStatus(wt: WorktreeItem): string {
  if (wt.isWaitingForResponse) return 'waiting';
  if (wt.isProcessing) return 'running';
  if (wt.isSessionRunning) return 'ready';
  return 'idle';
}

/**
 * Whether `wt` belongs to the same repository as `self`.
 *
 * `repositoryPath` is the identity — two checkouts of the same upstream have the
 * same `repositoryName` and are not the same repository — and the name is the
 * fallback for a row that predates the field. A row with neither is excluded
 * rather than assumed: a listing that quietly widened to the whole machine
 * would put a `--instance` for somebody else's project in front of an agent.
 *
 * @param wt - Candidate worktree
 * @param self - The caller's own worktree row
 */
function sameRepository(wt: PeerWorktreeItem, self: PeerWorktreeItem): boolean {
  if (self.repositoryPath && wt.repositoryPath) {
    return wt.repositoryPath === self.repositoryPath;
  }
  if (self.repositoryName && wt.repositoryName) {
    return wt.repositoryName === self.repositoryName;
  }
  // Neither side declares one: the caller's own worktree is still a peer group
  // of one, and nothing else can be shown to belong to it.
  return wt.id === self.id;
}

/**
 * The roster of a worktree as the list API sent it.
 *
 * A worktree with no roster still has its primary instance — that is what
 * `--instance` resolves to with no roster row at all (#868) — so an empty
 * roster is reported as the worktree's own CLI tool rather than as no sessions.
 *
 * A worktree that declares no CLI tool either contributes NO rows, rather than
 * a row for the agent it is statistically most likely to be running. An `ask`
 * line naming the wrong tool is a message typed into a session that was never
 * started, and the whole point of this listing is that its lines run.
 */
function rosterOf(wt: PeerWorktreeItem): AgentInstance[] {
  if (wt.agentInstances && wt.agentInstances.length > 0) return wt.agentInstances;
  if (!wt.cliToolId) return [];
  return [{ id: wt.cliToolId, cliTool: wt.cliToolId, alias: wt.cliToolId, order: 0 }];
}

/**
 * Quote an argument for the `ask` example when it needs it.
 *
 * Instance ids never do (`isValidInstanceId` allows no shell metacharacter) but
 * this command prints ids, not aliases, precisely so the line is paste-safe.
 * The guard is here so a future id shape cannot silently produce a line that
 * means something else in a shell.
 */
function shellArg(value: string): string {
  return /^[A-Za-z0-9_.:@+-]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Build the listing.
 *
 * @param worktrees - Every worktree the server knows
 * @param identity - Who is asking
 * @param binary - The command name to spell the examples with
 */
export function buildPeerRows(
  worktrees: PeerWorktreeItem[],
  identity: SessionIdentity,
  binary: string,
): PeerRow[] {
  const self = worktrees.find((wt) => wt.id === identity.worktreeId);
  const scoped = self ? worktrees.filter((wt) => sameRepository(wt, self)) : [];

  const rows: PeerRow[] = [];
  for (const wt of scoped) {
    const status = deriveStatus(wt);
    for (const inst of rosterOf(wt)) {
      const isSelf = wt.id === identity.worktreeId && inst.id === identity.instanceId;
      rows.push({
        worktreeId: wt.id,
        instanceId: inst.id,
        cliTool: inst.cliTool,
        alias: inst.alias,
        status,
        isSelf,
        ask: isSelf
          ? null
          : `${binary} ask ${shellArg(wt.id)} --instance ${shellArg(inst.id)} "<request>"`,
      });
    }
  }
  return rows;
}

/** Render the listing for a terminal. */
function formatPeers(rows: PeerRow[]): string {
  if (rows.length === 0) return 'No peer sessions found.';

  return rows
    .map((row) => {
      const head = `${row.worktreeId} / ${row.instanceId}`;
      const marker = row.isSelf ? '  (you)' : '';
      const lines = [
        `${head}${marker}`,
        `  alias: ${row.alias}   tool: ${row.cliTool}   status: ${row.status}`,
      ];
      if (row.ask) lines.push(`  ${row.ask}`);
      return lines.join('\n');
    })
    .join('\n');
}

export function createPeersCommand(): Command {
  const cmd = new Command('peers');
  cmd
    .description(
      'List the other agent sessions in this repository, with a ready-to-run `ask` line each'
    )
    .option('--json', 'JSON output')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (options: { json?: boolean; token?: string }) => {
      try {
        const client = new ApiClient({ token: options.token });
        const identity = await resolveSessionIdentity(client);

        if (!identity) {
          console.error(NOT_IN_SESSION_MESSAGE);
          process.exit(NOT_IN_SESSION);
          return;
        }

        const response = await client.get<WorktreeListResponse>('/api/worktrees');
        const worktrees = (response.worktrees ?? []) as PeerWorktreeItem[];

        // The same rule the GUI's panel and brief use (Issue #2120), from the
        // same function: `CM_LAUNCHED_BY` is stamped by `commandmate start` on
        // the server it spawns, and an agent pane inherits it — so a session
        // started by the installed CLI is told `commandmate` and one started
        // from a checkout is told `commandmatedev`, which is the name that
        // actually exists on that PATH. A literal here would be a second
        // authority on the one string the caller pastes into a shell.
        const binary = resolveCommandMateBinary();
        const rows = buildPeerRows(worktrees, identity, binary);

        // Issue #2404: the listing above is empty precisely when the caller's own
        // worktree is absent from `worktrees` — which is what "you are on another
        // server" looks like from here, and which `No peer sessions found.` reads
        // as "you have no siblings". The list is already in hand, so the check is
        // free and applies whichever source named the worktree.
        const mismatch = detectServerMismatch(
          identity,
          new Set(worktrees.map((wt) => wt.id)),
          client.serverUrl,
        );
        if (mismatch) console.error(formatServerMismatchWarning(mismatch));

        if (options.json) {
          console.log(JSON.stringify({
            // `self` is unchanged: it answers "who is asking", and the server is
            // not part of that. The connection target is its own top-level field.
            self: {
              worktreeId: identity.worktreeId,
              instanceId: identity.instanceId,
              cliToolId: identity.cliToolId,
            },
            serverUrl: client.serverUrl,
            ...(mismatch ? { serverMismatch: true } : {}),
            peers: rows,
          }, null, 2));
          return;
        }

        console.log(formatPeers(rows));
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
