/**
 * verify Command - Run the repository verification gates for a worktree
 * Issue #1544
 *
 * Exit codes:
 * - 0:   SUCCESS (every gate passed)
 * - 20:  VERIFY_FAILED (a gate failed, timed out, or errored)
 * - 21:  NOT_STARTED (work-evidence found nothing to verify)
 * - 124: TIMEOUT (--timeout elapsed before the run reached a verdict)
 * Infrastructure errors and verdict-less runs use ExitCode (1, 2, 99).
 *
 * Issue #1593 adds two read-only subcommands, `history` and `show`. They never
 * return 20/21: those codes mean "this working tree failed verification", and a
 * query about past runs is not a verdict on the current one. A read that
 * succeeds exits 0 even when it finds nothing.
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { VerifyOptions, VerifyHistoryOptions, VerifyShowOptions } from '../types';
import type {
  VerificationGateResultView,
  VerificationRunHistoryResponse,
  VerificationRunSummaryView,
  VerificationRunView,
  VerificationScopeAdmission,
  VerificationScopeDetail,
  VerifyRunResponse,
} from '../types/api-responses';
import { ApiClient, ApiError, isValidWorktreeId, isValidInstanceId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import {
  FLAKY_GATE_LABEL,
  parseFlakyMarker,
  parseGateIds,
  runVerification,
} from '../utils/verify-runner';

/** Mirrors MAX_RUN_HISTORY_DAYS / MAX_RUN_HISTORY_LIMIT in verification-db.ts. */
const MAX_HISTORY_DAYS = 90;
const MAX_HISTORY_LIMIT = 500;

/** Gate statuses that mean the gate did not pass. `skipped` is not a failure. */
const FAILED_GATE_STATUSES: ReadonlySet<string> = new Set(['failed', 'timeout', 'error']);

// =============================================================================
// Scope-gate evidence (Issue #1841)
// =============================================================================

/** Built-in gate id; mirrors SCOPE_GATE_ID in lib/verification/verify-config.ts. */
const SCOPE_GATE_ID = 'scope';

/**
 * Separator the scope gate puts between a path and the rule that decided it.
 *
 * Mirrors SCOPE_PATTERN_ARROW in `src/lib/verification/scope-gate.ts`. The two
 * cannot import each other — tsconfig.cli.json compiles `src/cli/**` alone,
 * with no path aliases, so the CLI bundle never pulls in the server's
 * dependency graph — so a round-trip test feeds a real gate report through this
 * parser instead of trusting the constants to be edited together.
 */
const SCOPE_PATTERN_ARROW = '  \u2190 ';

/**
 * Read the scope gate's report back into structured evidence.
 *
 * Parsing the gate's own prose is not the shape anyone would choose, but it is
 * the only one available: `verification_gate_results` has no column for
 * structured detail, and the CLI's `formatDetail` already reads work-evidence's
 * counts out of `logTail` the same way (src/cli/utils/verify-runner.ts).
 *
 * Returns null when the tail is not a report — a skip, an error, or a gate that
 * was never entered all write a sentence — because an empty `admitted` on those
 * would claim the gate looked and found nothing.
 */
export function parseScopeEvidence(logTail: string | null | undefined): VerificationScopeDetail | null {
  if (!logTail) return null;
  const summary = /^scope: baseRef=.* changed=(\d+) violations=(\d+)$/m.exec(logTail);
  if (!summary) return null;

  const changed = Number(summary[1]);
  const violationTotal = Number(summary[2]);
  const admitted: VerificationScopeAdmission[] = [];
  const violations: string[] = [];

  for (const line of logTail.split('\n')) {
    if (line.startsWith('  + ')) {
      const [path, pattern] = splitAtArrow(line.slice(4));
      // The gate always names the admitting rule; a `+` line without one is
      // output this parser does not understand, and inventing an empty pattern
      // for it would put a claim in the JSON that nothing made.
      if (pattern !== null) admitted.push({ path, pattern });
    } else if (line.startsWith('  - ')) {
      violations.push(splitAtArrow(line.slice(4))[0]);
    }
  }

  return {
    admitted,
    violations,
    // From the summary line, not from the lists: both are capped at 100 by the
    // report, and `changed` counts every path either way. Admitted is the
    // remainder because the gate classifies each changed path exactly once.
    totals: { changed, admitted: changed - violationTotal, violations: violationTotal },
  };
}

/**
 * Split `<path>  \u2190 <pattern>`, keeping the whole line as the path when no
 * arrow is present (an allow-miss violation has no rule to name).
 *
 * Split at the *last* arrow so a path containing the sequence still yields the
 * pattern the gate wrote.
 */
function splitAtArrow(text: string): [string, string | null] {
  const at = text.lastIndexOf(SCOPE_PATTERN_ARROW);
  if (at === -1) return [text, null];
  return [text.slice(0, at), text.slice(at + SCOPE_PATTERN_ARROW.length)];
}

/**
 * Attach the evidence the CLI parses out of gate logs before a run is printed
 * as JSON: {@link parseScopeEvidence} on the scope gate (Issue #1841), and the
 * retry record on any gate that was re-run (Issue #1772).
 *
 * Copies rather than mutates: the run object is also what the polling loop
 * reported from, and a JSON-only field has no business appearing in it.
 */
function withGateEvidence(run: VerificationRunView): VerificationRunView {
  const gates = run.gates ?? [];
  return {
    ...run,
    gates: gates.map((gate): VerificationGateResultView => {
      const scope = gate.gateId === SCOPE_GATE_ID ? parseScopeEvidence(gate.logTail) : null;
      const flaky = parseFlakyMarker(gate.logTail);
      if (!scope && !flaky) return gate;
      return {
        ...gate,
        ...(scope ? { scope } : {}),
        ...(flaky ? { flaky } : {}),
      };
    }),
  };
}

function formatSeconds(durationMs: number | null): string {
  return durationMs === null ? 'n/a' : `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * Read a flag that `verify` and its read subcommands both declare.
 *
 * Commander binds a flag to whichever command in the chain declared it and
 * reached it first, so in `verify history --json` the parent's own `--json`
 * (used by the run mode) swallows the flag before `history` ever sees it.
 * Falling back to the parent's options is what makes `--json` work where users
 * actually type it, without changing the root program's option scoping.
 */
function inheritedFlag<T>(own: T | undefined, command: Command, key: string): T | undefined {
  if (own !== undefined) return own;
  return command.parent?.opts()[key] as T | undefined;
}

/**
 * One run per line.
 *
 * The run id leads the line even though it is not in the requested field list:
 * without it there is no way to reach `verify show`, which is the only reason
 * to read this listing in the first place.
 */
function formatHistoryLine(run: VerificationRunSummaryView): string {
  const failed = run.gates
    .filter((gate) => FAILED_GATE_STATUSES.has(gate.status))
    .map((gate) => gate.gateId);
  const suffix = failed.length > 0 ? `  failed: ${failed.join(',')}` : '';
  return `#${run.id}  ${run.startedAt}  ${run.worktreeId}  ${run.trigger}  ${run.status}${suffix}`;
}

export function createVerifyCommand(): Command {
  const cmd = new Command('verify');
  cmd
    .description('Run the verification gates declared in .commandmate/verify.yaml for a worktree')
    .argument('<worktree-id>', 'Worktree ID to verify')
    .option('--instance <id>', 'Agent instance ID the run is attributed to (e.g. codex-2)')
    .option(
      '--gates <ids>',
      'Comma-separated gate ids to run (default: work-evidence plus every declared gate)'
    )
    .option('--json', 'Print the run and its gate results as JSON on stdout')
    .option('--timeout <seconds>', 'Stop polling after this many seconds (exit 124)', parseInt)
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeId: string, options: VerifyOptions) => {
      try {
        if (!isValidWorktreeId(worktreeId)) {
          console.error(`Error: Invalid worktree ID format: ${worktreeId}`);
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        if (options.instance && !isValidInstanceId(options.instance)) {
          console.error(
            'Error: Invalid --instance. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).'
          );
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        const gateIds = parseGateIds(options.gates);
        if (gateIds === null) {
          console.error('Error: --gates must name at least one gate id.');
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        const client = new ApiClient({ token: options.token });
        const outcome = await runVerification(client, {
          worktreeId,
          trigger: 'manual',
          instanceId: options.instance,
          gateIds,
          timeoutSec: options.timeout,
          suppressResultLine: options.json,
        });

        if (options.json && outcome.run) {
          console.log(JSON.stringify(withGateEvidence(outcome.run)));
        }
        process.exit(outcome.exitCode);
      } catch (error) {
        handleCommandError(error);
      }
    });

  addHistoryCommand(cmd);
  addShowCommand(cmd);
  return cmd;
}

/** `commandmate verify history [--worktree <id>] [--days N] [--limit N] [--json]` */
function addHistoryCommand(parent: Command): void {
  parent
    .command('history')
    .description('List past verification runs, newest first')
    .option('--worktree <id>', 'Restrict to one worktree (default: every worktree)')
    .option('--days <days>', `Look back this many days (1..${MAX_HISTORY_DAYS})`, parseInt)
    .option('--limit <n>', `Maximum runs to list (1..${MAX_HISTORY_LIMIT}, default 50)`, parseInt)
    .option('--json', 'Print the runs as a JSON array on stdout')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (options: VerifyHistoryOptions, command: Command) => {
      try {
        const json = inheritedFlag<boolean>(options.json, command, 'json');
        const token = inheritedFlag<string>(options.token, command, 'token');

        if (options.worktree !== undefined && !isValidWorktreeId(options.worktree)) {
          console.error(`Error: Invalid worktree ID format: ${options.worktree}`);
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        if (
          options.days !== undefined &&
          (!Number.isInteger(options.days) || options.days < 1 || options.days > MAX_HISTORY_DAYS)
        ) {
          console.error(`Error: --days must be an integer between 1 and ${MAX_HISTORY_DAYS}.`);
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        if (
          options.limit !== undefined &&
          (!Number.isInteger(options.limit) ||
            options.limit < 1 ||
            options.limit > MAX_HISTORY_LIMIT)
        ) {
          console.error(`Error: --limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}.`);
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        const query: string[] = [];
        if (options.worktree !== undefined) {
          query.push(`worktreeId=${encodeURIComponent(options.worktree)}`);
        }
        if (options.days !== undefined) query.push(`days=${options.days}`);
        if (options.limit !== undefined) query.push(`limit=${options.limit}`);
        const suffix = query.length > 0 ? `?${query.join('&')}` : '';

        const client = new ApiClient({ token });
        const data = await client.get<VerificationRunHistoryResponse>(
          `/api/verification/runs${suffix}`
        );
        const runs = data.runs ?? [];

        if (json) {
          // Always valid JSON, including the empty case: a consumer piping this
          // into jq must not have to special-case "no runs".
          console.log(JSON.stringify(runs, null, 2));
          return;
        }

        if (runs.length === 0) {
          console.error('No verification runs found.');
          return;
        }
        for (const run of runs) {
          console.log(formatHistoryLine(run));
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
}

/** `commandmate verify show <run-id> [--json]` */
function addShowCommand(parent: Command): void {
  parent
    .command('show')
    .description('Show one verification run with its gate results and log tails')
    .argument('<run-id>', 'Verification run ID (from `verify history`)')
    .option('--json', 'Print the run as JSON on stdout')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (runId: string, options: VerifyShowOptions, command: Command) => {
      try {
        const json = inheritedFlag<boolean>(options.json, command, 'json');
        const token = inheritedFlag<string>(options.token, command, 'token');

        if (!/^[1-9]\d*$/.test(runId)) {
          console.error(`Error: Invalid run ID: ${runId}. Expected a positive integer.`);
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        const client = new ApiClient({ token });
        let data: VerifyRunResponse;
        try {
          data = await client.get<VerifyRunResponse>(`/api/verification/runs/${runId}`);
        } catch (error) {
          // The generic 404 message names the worktree id, which this command
          // never takes. Say what was actually not found.
          if (error instanceof ApiError && error.statusCode === 404) {
            console.error(`Verification run ${runId} not found.`);
            process.exit(error.exitCode);
            return;
          }
          throw error;
        }

        const run = data.run;
        if (json) {
          // `show` is the forensic surface — the one a reader reaches for to
          // reconstruct a run days later — so the scope evidence and the retry
          // record have to be readable here too, not only on the run that
          // produced them.
          console.log(JSON.stringify(withGateEvidence(run), null, 2));
          return;
        }

        console.log(
          `run #${run.id}  ${run.status}  worktree=${run.worktreeId}  trigger=${run.trigger}`
        );
        console.log(`started=${run.startedAt}  finished=${run.finishedAt ?? '-'}`);
        console.log(`baseRef=${run.baseRef ?? '-'}  instance=${run.instanceId ?? '-'}  task=${run.taskId ?? '-'}`);

        for (const gate of run.gates) {
          const exit = gate.exitCode === null ? 'n/a' : String(gate.exitCode);
          // `show` names every gate's source, not only the contract's (#1791):
          // this is the detail view a reader consults to reconstruct what a run
          // judged, so "which of these was the repository's own definition of
          // passing" should not have to be inferred from an absent marker.
          const source = gate.source ? `  src=${gate.source}` : '';
          // Appended rather than replacing `status`, which is the stored column
          // this view exists to show verbatim (#1772). The marker in the log
          // tail below carries both runs' numbers.
          const flaky =
            parseFlakyMarker(gate.logTail)?.outcome === 'flaky' ? `  ${FLAKY_GATE_LABEL}` : '';
          console.log(
            `  ${gate.gateId}  ${gate.status}  exit=${exit}  ${formatSeconds(gate.durationMs)}${source}${flaky}`
          );
          if (gate.logTail) {
            for (const line of gate.logTail.split('\n')) {
              console.log(`    | ${line}`);
            }
          }
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
}
