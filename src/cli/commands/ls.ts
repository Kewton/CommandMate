/**
 * ls Command - List worktrees with status
 * Issue #518: [DR1-08] Factory pattern with createLsCommand()
 */

import { Command } from 'commander';
import type { LsOptions } from '../types';
import type { WorktreeListResponse, WorktreeItem } from '../types/api-responses';
import { ApiClient } from '../utils/api-client';
// The reason vocabulary itself, not a copy of one token of it: `commandmate ls`
// and the server must not be able to disagree about what `exited` is spelled.
import { STATUS_REASON } from '../../lib/detection/status-reason';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';

/**
 * Derive display status from worktree flags.
 *
 * Deliberately still the three-way boolean branch (design DR3-005 says so in as
 * many words): Issue #1926 adds a reason column beside this, not a fourth
 * branch inside it. The status vocabulary is unchanged.
 */
function deriveStatus(wt: WorktreeItem): string {
  if (wt.isWaitingForResponse) return 'waiting';
  if (wt.isProcessing) return 'running';
  if (wt.isSessionRunning) return 'ready';
  return 'idle';
}

/** One entry of the per-CLI-tool status map the list API publishes. */
type CliStatusEntry = NonNullable<WorktreeItem['sessionStatusByCli']>[string];

/**
 * The per-tool status entry that explains this row's STATUS (Issue #1926).
 *
 * `deriveStatus` folds every tool of the worktree into one word, so the reason
 * beside it has to come from the tool that produced that word — printing the
 * worktree default's reason next to a `waiting` raised by a second agent would
 * be a sentence about the wrong session. The worktree default is preferred among
 * the candidates, because on the ordinary single-agent worktree it is the only
 * one and on a multi-agent one it is the session the operator means.
 *
 * Returns undefined for `idle` (nothing is running, so nothing read a frame) and
 * for a server older than #1926, which sends no such fields.
 */
function pickStatusEntry(wt: WorktreeItem, status: string): CliStatusEntry | undefined {
  const byCli = wt.sessionStatusByCli;
  if (!byCli) return undefined;

  const explains = (entry: CliStatusEntry | undefined): boolean => {
    if (!entry) return false;
    if (status === 'waiting') return entry.isWaitingForResponse;
    if (status === 'running') return entry.isProcessing;
    if (status === 'ready') return entry.isRunning;
    // Issue #2070: `idle` gets an explanation for the first time, and only for
    // the one reason a stopped session can carry — `exited`. Everything else
    // about an idle row is unchanged: no entry is picked, so the REASON cell is
    // still `-`. That is what makes this additive rather than a fourth branch of
    // `deriveStatus` (DR3-005 keeps the STATUS vocabulary at four words).
    if (status === 'idle') return entry.sessionStatusReason === STATUS_REASON.EXITED;
    return false;
  };

  const preferred = wt.cliToolId ? byCli[wt.cliToolId] : undefined;
  if (explains(preferred)) return preferred;
  return Object.values(byCli).find(explains);
}

/**
 * The REASON cell: why the STATUS beside it says what it says (Issue #1926).
 *
 * `-` when the server does not say — it predates #1926, the session is not
 * running, or the tool has two or more instances and the aggregate dropped the
 * reason (see `mergeSessionStatus` server-side; `--json` still carries the
 * per-tool rows).
 *
 * `(no evidence)` marks `statusEvidence: 'none'` — the frame was interactive and
 * nothing on it could be read either way, so the STATUS beside it is a fallback
 * rather than a reading. Today that is exactly the `default` and
 * `no_recent_output` reasons; design Phase 3 widens it per tool, and the marker
 * is what makes the widening visible here without the reason token changing.
 *
 * Issue #2070 adds one reason that appears beside `idle`: `exited`, meaning the
 * tmux session is still there and the agent in it is not. Before it, a codex
 * that had crashed or updated itself out from under its pane was reported
 * `running` — and once the detection was fixed, it would have been reported
 * `idle` with a bare `-`, indistinguishable from a worktree nobody has started.
 * The distinction is the point: `idle` means "start it", `idle`/`exited` means
 * "it died under you, and the next send will restart it".
 */
function deriveReason(wt: WorktreeItem): string {
  const entry = pickStatusEntry(wt, deriveStatus(wt));
  const reason = entry?.sessionStatusReason;
  if (!reason) return '-';
  return entry?.statusEvidence === 'none' ? `${reason} (no evidence)` : reason;
}

/**
 * Format worktrees as a table for terminal display.
 */
function formatTable(worktrees: WorktreeItem[]): string {
  if (worktrees.length === 0) return 'No worktrees found.';

  const headers = ['ID', 'NAME', 'STATUS', 'REASON', 'DEFAULT'];
  const rows = worktrees.map(wt => [
    wt.id,
    wt.name,
    deriveStatus(wt),
    deriveReason(wt),
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
 *
 * `--json` prints the server's rows verbatim, and Issue #1926 does not change
 * that. `statusEvidence` / `sessionStatusReason` / `lastKnownStatus` /
 * `lastKnownStatusAt` ride along inside `sessionStatusByCli.<tool>`, which is
 * where the server puts them:
 *
 *     commandmate ls --json | jq -r '.[] | "\(.id) \(.sessionStatusByCli.claude.statusEvidence)"'
 *
 * Deliberately not hoisted to the top level of each row. A synthesised
 * `statusEvidence` there would read as a server field to anyone holding
 * `WorktreeItem`, would need the same tool-picking rule the REASON column
 * applies for display, and would make `ls --json` disagree with
 * `GET /api/worktrees` — three costs for a shorter jq path.
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
    .option('--id <prefix>', 'Filter by worktree id prefix')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (options: LsOptions) => {
      try {
        const client = new ApiClient({ token: options.token });
        const data = await client.get<WorktreeListResponse>('/api/worktrees');

        let worktrees = data.worktrees;

        // [DR2-08] Filter by real branch prefix (Issue #1003), falling back to
        // `name` when the branch is not yet synced (NULL) so legacy behavior and
        // pre-#1003 rows keep working.
        if (options.branch) {
          worktrees = worktrees.filter(wt =>
            (wt.branch ?? wt.name).startsWith(options.branch!)
          );
        }

        // Issue #1005: Filter by worktree id prefix. Independent of `--branch`
        // (AND-combined when both are given). Front-match / case-sensitive.
        //
        // Matched against the CURRENT ids only (Issue #1621): `/api/worktrees`
        // returns live rows, and historical ids resolve exactly — never by
        // prefix — via the alias table on the routes that take an `<id>`
        // argument. A prefix still does not guarantee uniqueness: ids are now
        // directory-basename slugs (`commandmate-issue-1644`), so sibling
        // worktrees of the same feature share a prefix just as `<repo>-<branch>`
        // slugs used to.
        if (options.id) {
          worktrees = worktrees.filter(wt => wt.id.startsWith(options.id!));
        }

        const output = formatOutput(worktrees, options);
        console.log(output);
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
