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
// Issue #2317: the tmux session name, so nobody has to assemble
// `mcbd-<tool>-<worktree>[-<suffix>]` by hand from two commands' output.
import { isCliToolId } from '../config/cli-tool-ids';
import { resolveSessionName } from '../../lib/cli-tools/session-name';
import type { CLIToolType } from '../../lib/cli-tools/types';

/**
 * Derive display status from worktree flags.
 *
 * Deliberately still the three-way boolean branch (design DR3-005 says so in as
 * many words): Issue #1926 adds a reason column beside this, not a fourth
 * branch inside it. The status vocabulary is unchanged.
 *
 * Issue #2775: a session whose frame no rule could classify reaches this row
 * with `isProcessing: false` (the server stopped projecting the detector's
 * floor onto "it is working"), so it prints `ready`, not `running` — the same
 * answer the sidebar's `deriveCliStatus` gives it. The vocabulary has no
 * "cannot tell" and is not widened for it: operators and the orchestrate
 * recipes read this column positionally. What says "this `ready` is a fallback"
 * is the REASON beside it, which names the floor with `(no evidence)` — and
 * `--json` carries `sessionStatusByCli.<tool>.isUnclassified`.
 */
function deriveStatus(wt: WorktreeItem): string {
  if (wt.isWaitingForResponse) return 'waiting';
  if (wt.isProcessing) return 'running';
  if (wt.isSessionRunning) return 'ready';
  return 'idle';
}

/** One entry of the per-CLI-tool status map the list API publishes. */
export type CliStatusEntry = NonNullable<WorktreeItem['sessionStatusByCli']>[string];

/**
 * One instance's Auto-Yes arming, as `GET /api/worktrees` sends it (Issue #2512).
 *
 * Mirrors: src/types/auto-yes.ts AutoYesInstanceSummary.
 *
 * A copy rather than an import: `tsconfig.cli.json` sets `"paths": {}`, so
 * nothing under `src/cli` can reach `@/types/auto-yes`. The copy is kept honest
 * by a bidirectional `AssertAssignable` in
 * `tests/unit/cli/commands/ls-auto-yes-2575.test.ts`, which `npx tsc --noEmit`
 * evaluates — the same guard #1843 uses for the suppression-reason union.
 *
 * Only ARMED instances appear in the map: the server folds expired and
 * turned-off states away as it reads them (`getEnabledAutoYesByWorktree`), so a
 * missing key means "not armed right now" and carries no reason. Why it stopped
 * lives in `commandmate capture --json`'s `autoYes.stopReason`.
 */
export type AutoYesInstanceWire = { enabled: boolean; expiresAt: number | null };

/**
 * A list row with the two maps this command reads and `WorktreeItem` does not
 * declare (Issue #2575).
 *
 * `src/cli/types/api-responses.ts` declares only the fields the CLI reads, and
 * until this column nothing read either of these. Widened HERE rather than
 * there, on the precedent of `PeerWorktreeItem` in `peers.ts`: the shared mirror
 * keeps meaning what its header says, and a row from a server that predates
 * #2512 (no `autoYesByInstance`) or answered `?includeStatus=0` (no
 * `sessionStatusByInstance`) is still a valid row — hence both optional.
 *
 * `sessionStatusByInstance` is the UN-aggregated map. `sessionStatusByCli` next
 * to it is the logical-OR over every instance of a tool, which is the right
 * input for REASON (#1926) and the wrong one here: Auto-Yes is armed per
 * INSTANCE, so an aggregate cannot say whether it was `claude` or `claude-2`
 * that raised the wait.
 *
 * Exported so tests can assert against the wire shape rather than restate it.
 */
export interface LsWorktreeItem extends WorktreeItem {
  autoYesByInstance?: Record<string, AutoYesInstanceWire>;
  sessionStatusByInstance?: Partial<Record<string, CliStatusEntry>>;
}

/** The list response, with rows widened to {@link LsWorktreeItem}. */
type LsWorktreeListResponse = Omit<WorktreeListResponse, 'worktrees'> & {
  worktrees: LsWorktreeItem[];
};

/**
 * Whether this status entry is one of the sessions that produced `status`.
 *
 * `deriveStatus` folds every session of the worktree into one word, so any cell
 * that claims to be ABOUT that word has to be sourced from a session that
 * produced it. Two columns need the predicate and must not drift apart: REASON
 * (#1926) applies it per tool, AUTO_YES (#2575) applies it per instance.
 *
 * `idle` is explained by exactly one thing (Issue #2070): `exited`, the tmux
 * session still there with no agent in it. Everything else idle is unexplained
 * — no entry matches, REASON stays `-`, and AUTO_YES falls back to every armed
 * instance.
 */
function explainsStatus(entry: CliStatusEntry | undefined, status: string): boolean {
  if (!entry) return false;
  if (status === 'waiting') return entry.isWaitingForResponse;
  if (status === 'running') return entry.isProcessing;
  if (status === 'ready') return entry.isRunning;
  if (status === 'idle') return entry.sessionStatusReason === STATUS_REASON.EXITED;
  return false;
}

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

  const preferred = wt.cliToolId ? byCli[wt.cliToolId] : undefined;
  if (explainsStatus(preferred, status)) return preferred;
  return Object.values(byCli).find((entry) => explainsStatus(entry, status));
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

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/**
 * `MM:SS`, or `H:MM:SS` from an hour up — the Web UI countdown's format.
 *
 * A second spelling of `formatTimeRemaining` (`src/config/auto-yes-config.ts`)
 * on purpose, and the only duplication Issue #2575 accepts. That module imports
 * `@/config/tmux-pane-config`, and `tsconfig.cli.json` sets `"paths": {}`, so a
 * CLI module importing it compiles under lint / `tsc --noEmit` / vitest (all
 * three resolve `@/`) and breaks only at `npm run build:cli` — a trap worth
 * avoiding rather than walking into. The two are pinned to the same strings at
 * the boundaries by `ls-auto-yes-2575.test.ts`, so an operator reads the same
 * number in the browser and in the terminal.
 *
 * Takes a DURATION, not a deadline: the caller has already resolved `now` once
 * for the whole table, and passing the deadline here would re-read the clock per
 * row. Truncating means 0 < remaining < 1 s prints `00:00`, exactly as the
 * browser countdown does one tick before it flips to OFF.
 */
export function formatAutoYesRemaining(remainingMs: number): string {
  const remaining = Math.max(0, remainingMs);
  const hours = Math.floor(remaining / MS_PER_HOUR);
  const minutes = Math.floor((remaining % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((remaining % MS_PER_MINUTE) / MS_PER_SECOND);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Milliseconds of Auto-Yes left on one instance: 0 when it is not armed,
 * Infinity when it is armed with no deadline.
 *
 * Everything that is not positively armed collapses to 0 — no key, `enabled`
 * anything but true, or a deadline already past. A past `expiresAt` reaches us
 * even though the server folds expired states away as it reads them: these are
 * two machines' clocks, and #959's `displayEnabled = enabled && !hasExpired`
 * falls the same way. The direction is the whole point — this cell may under-
 * report arming, never over-report it, because over-reporting hides a prompt
 * that only a human can clear.
 *
 * Infinity is not a shape the current server produces (`AutoYesState.expiresAt`
 * is a number), but an explicit `null` beside `enabled: true` is the server
 * saying armed-with-no-deadline, which is a fact, and the Sessions tile reads
 * the same input as ON. Infinity also makes it lose every `min` against a real
 * deadline, which is what "unknown expiry" should do.
 *
 * `null` EXACTLY, not "anything that is not a number": a row missing the key
 * altogether is malformed rather than eternal, and the rule above decides which
 * way malformed falls — towards `off`.
 */
function remainingAutoYesMs(entry: AutoYesInstanceWire | undefined, now: number): number {
  if (!entry || entry.enabled !== true) return 0;
  if (entry.expiresAt === null) return Number.POSITIVE_INFINITY;
  if (typeof entry.expiresAt !== 'number') return 0;
  return entry.expiresAt > now ? entry.expiresAt - now : 0;
}

/**
 * The AUTO_YES cell: how long before this row loses Auto-Yes (Issue #2575).
 *
 * In one sentence: the remaining time of the instance that will lose Auto-Yes
 * FIRST, among the instances that explain this row's STATUS. One already without
 * it makes the cell `off`.
 *
 * The minimum, rather than the longest or a list, is what closes the gap this
 * Issue is about. On a row where `claude` is waiting unarmed and `codex` is
 * waiting with ten minutes left, printing `10:00` buries a prompt nobody will
 * answer under a countdown that has nothing to do with it; the minimum prints
 * `off`. The cost is accepted and stated in `--help`: one unarmed instance
 * sharing a `ready` row hides the armed one's countdown, which `ls --json` still
 * has in full.
 *
 * `-` means "not known", and is deliberately not `off`:
 *   - no `autoYesByInstance` at all — a server older than #2512;
 *   - a non-idle row no instance explains. Impossible against the current
 *     server, whose row-level flags are the OR of the per-instance ones. It is a
 *     guard for the day that stops being true: falling back to "every armed
 *     instance" on a `waiting` row would print a countdown beside a prompt no
 *     instance is actually going to answer.
 *
 * The fallback to every armed instance is therefore `idle`-only, where nothing
 * is running and there is no session whose wait could be misrepresented. An idle
 * row with an `exited` instance is explained (#2070), so the fallback does not
 * fire there.
 *
 * `status` and `now` are arguments rather than re-derived: `now` is read once
 * per table so two rows cannot disagree about the time, and a test can freeze it.
 */
function deriveAutoYesCell(wt: LsWorktreeItem, status: string, now: number): string {
  const armedByInstance = wt.autoYesByInstance;
  if (!armedByInstance) return '-';

  const byInstance = wt.sessionStatusByInstance ?? {};
  let targets = Object.keys(byInstance).filter(id => explainsStatus(byInstance[id], status));

  if (targets.length === 0) {
    if (status !== 'idle') return '-';
    targets = Object.keys(armedByInstance);
    if (targets.length === 0) return 'off';
  }

  // Deterministic order first, so the cell never depends on the key order the
  // server happened to serialise: the worktree default's primary, then
  // lexicographic. The first strict minimum in that order wins, which is what
  // makes an equal-remaining tie resolve to the default (printed bare) rather
  // than to whichever instance the JSON listed first.
  const ordered = [...targets].sort((a, b) => {
    if (a === wt.cliToolId) return -1;
    if (b === wt.cliToolId) return 1;
    return a < b ? -1 : 1;
  });

  let pick = ordered[0];
  let remaining = remainingAutoYesMs(armedByInstance[pick], now);
  for (const id of ordered.slice(1)) {
    const candidate = remainingAutoYesMs(armedByInstance[id], now);
    if (candidate < remaining) {
      pick = id;
      remaining = candidate;
    }
  }

  const value = remaining === 0
    ? 'off'
    : remaining === Number.POSITIVE_INFINITY
      ? 'on'
      : formatAutoYesRemaining(remaining);

  // The instance is named whenever it is not the default agent's primary — the
  // row where a second agent raised the wait is exactly the row where REASON
  // cannot say so (it is a per-tool aggregate and loses the reason for a tool
  // with two instances), so this parenthesis is sometimes the only thing on the
  // line that identifies the session. It is an `--instance` value verbatim.
  return pick === wt.cliToolId ? value : `${value} (${pick})`;
}

/**
 * Format worktrees as a table for terminal display.
 */
function formatTable(worktrees: LsWorktreeItem[]): string {
  if (worktrees.length === 0) return 'No worktrees found.';

  // Once per table, not once per row: two rows must not disagree about what
  // "now" is, and a frozen clock in a test must produce one reading.
  const now = Date.now();

  // Issue #2575 APPENDS. The first five columns keep their order and their
  // starting offsets, because operators (and the orchestrate recipes) read this
  // table positionally — the same rule #1785 / #2038 / #2317 held for
  // `commandmate instances`.
  const headers = ['ID', 'NAME', 'STATUS', 'REASON', 'DEFAULT', 'AUTO_YES'];
  const rows = worktrees.map(wt => {
    const status = deriveStatus(wt);
    return [
      wt.id,
      wt.name,
      status,
      deriveReason(wt),
      wt.cliToolId || '-',
      deriveAutoYesCell(wt, status, now),
    ];
  });

  // Calculate column widths
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length))
  );

  // The LAST column is not padded. An instance id runs to 64 characters, so one
  // row carrying `off (some-very-long-instance-id)` would otherwise pad every
  // other row out to that width and wrap the whole table on a narrow terminal.
  // Before #2575 the last column was DEFAULT and every line did end in padding.
  const lastCol = headers.length - 1;
  const pad = (cell: string, i: number): string => (i === lastCol ? cell : cell.padEnd(colWidths[i]));

  const headerLine = headers.map(pad).join('  ');
  const separator = colWidths.map(w => '-'.repeat(w)).join('  ');
  const dataLines = rows.map(r => r.map(pad).join('  '));

  return [headerLine, separator, ...dataLines].join('\n');
}

/** A `--json` row plus Issue #2317's tmux session name. */
type JsonWorktreeRow = LsWorktreeItem & { tmuxSession: string | null };

/**
 * The tmux session name of this worktree's DEFAULT agent, or null (Issue #2317).
 *
 * The default agent's PRIMARY instance, which is the session `commandmate
 * attach <id>` opens with no flags — so the two answers cannot disagree. A
 * worktree running several agents has several sessions, and this field names one
 * of them on purpose: the complete per-instance list is what
 * `commandmate instances <id>` is for, and duplicating it here would put the
 * roster in two places.
 *
 * Null when the row names no default agent, or names one this CLI does not know
 * (a server newer than the CLI), or when the id would not survive
 * `validateSessionName` — the same three cases in which there is no name to
 * give rather than a wrong one.
 *
 * Computed CLIENT-side. The server does not publish it, and asking it to would
 * mean `/api/worktrees` — the sidebar's poll, for every worktree, every couple
 * of seconds — carrying a string derivable from two fields already in the row.
 */
function deriveTmuxSession(wt: WorktreeItem): string | null {
  if (!wt.cliToolId || !isCliToolId(wt.cliToolId)) return null;
  try {
    return resolveSessionName(wt.cliToolId as CLIToolType, wt.id);
  } catch {
    return null;
  }
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
 *
 * Issue #2575 adds a table column and nothing here, for the same reason plus
 * one: the derived cell would be the LEAST accurate answer a machine can get.
 * `autoYesByInstance` and `sessionStatusByInstance` are already in these rows
 * verbatim, and a caller that needs "will anything answer this prompt" wants
 * `commandmate wait`'s exit 10 or `capture --json`'s `autoYes`, both of which
 * know about answers the contract policy withheld. The cell is a summary for a
 * human reading a table.
 */
function formatOutput(worktrees: LsWorktreeItem[], options: LsOptions): string {
  if (options.json) {
    // Issue #2317 appends one key and changes nothing else: every field the
    // server sent still passes through verbatim, so a consumer reading
    // `sessionStatusByCli.<tool>.statusEvidence` is unaffected.
    const rows: JsonWorktreeRow[] = worktrees.map((wt) => ({
      ...wt,
      tmuxSession: deriveTmuxSession(wt),
    }));
    return JSON.stringify(rows, null, 2);
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
    // Issue #2575: AUTO_YES is a derived cell with rules an operator can be
    // surprised by (a `ready` row can read `off` while an instance is armed),
    // and docs/** is outside this change's scope — so until the guides catch up,
    // this is the only place a shipped build explains the column. Same reason
    // `wait --help` carries the unclassified dwell (#1926).
    .addHelpText('after', `
AUTO_YES column (Issue #2575):
  How much Auto-Yes is left on the instance that will lose it FIRST, among the
  instances that explain this row's STATUS (waiting: the ones waiting; running:
  the ones processing; ready: the ones running; idle: the ones that exited. A
  bare idle row falls back to every armed instance).

    MM:SS      time left, under an hour
    H:MM:SS    time left, an hour or more
    on         armed, with no expiry the server named
    off        at least one of those instances is NOT armed, so a prompt on this
               row waits for a human. This is the cell to look for
    -          not known: the server predates the field, or this row is not idle
               and no instance explains its STATUS

  A time left is a fact about Auto-Yes, not a promise that the prompt gets
  answered: a contract policy can withhold the answer, and a free-text prompt
  has none to give. \`commandmate capture <id> --json --instance <instanceId>\`
  carries autoYes.lastSuppression (what was withheld) and autoYes.stopReason
  (why it stopped); \`commandmate wait <id>\` returns exit 10 for a prompt no
  agent is going to clear.

  The id in parentheses is the instance the cell is about, printed when that is
  not the default agent's primary. Pass it to capture / send / respond as
  --instance verbatim. It names an instance for THIS column only: REASON is
  chosen per tool with the worktree default preferred (Issue #1926), so the two
  cells on one row can be about different sessions.

  Nothing here is derived in --json: it carries sessionStatusByInstance and
  autoYesByInstance raw, which is where the per-instance breakdown is.
`)
    .action(async (options: LsOptions) => {
      try {
        const client = new ApiClient({ token: options.token });
        const data = await client.get<LsWorktreeListResponse>('/api/worktrees');

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
