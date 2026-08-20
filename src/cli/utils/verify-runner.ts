/**
 * Verification run driver shared by `commandmate verify` and `wait --verify`
 * (Issue #1544).
 *
 * The server answers a verify request with 202 and a run id rather than a
 * verdict — gates are whole test suites and builds — so every caller has to
 * start a run, poll it to a terminal status, and translate that status into an
 * exit code. That sequence lives here once so `verify` and `wait` cannot drift
 * apart on what "passed" means.
 *
 * @module cli/utils/verify-runner
 */

import { ExitCode, VerifyExitCode } from '../types';
import type {
  VerificationFlakyDetail,
  VerificationGateResultView,
  VerificationRunStatus,
  VerificationRunView,
  VerifyRunResponse,
  VerifyStartResponse,
} from '../types/api-responses';
import { ApiClient, ApiError, assertResponseShape } from './api-client';

/** Matches the wait command's cadence; runs are minutes long, not seconds. */
export const VERIFY_POLL_INTERVAL_MS = 5000;

/** Built-in gate id; mirrors WORK_EVIDENCE_GATE_ID in lib/verification/gate-runner.ts. */
export const WORK_EVIDENCE_GATE_ID = 'work-evidence';

/**
 * Marker a mutexed gate writes into its log tail; mirrors MUTEX_LOG_PREFIX in
 * lib/verification/gate-runner.ts (Issue #1771).
 *
 * Mirrored rather than imported because `tsconfig.cli.json` compiles
 * `src/cli/**` alone with no path aliases, so the CLI bundle never pulls in the
 * server's dependency graph. `tests/unit/verification/gate-mutex.test.ts` pins
 * the two together by importing both.
 */
export const MUTEX_LOG_PREFIX = '[mutex]';

/**
 * Time a gate spent queued for its `mutex`, as written by the runner.
 *
 * Anchored to the start of a line so a gate whose own output happens to contain
 * `waited=` cannot supply the number.
 */
const MUTEX_WAITED_PATTERN = /^\[mutex\] [^\n]*?\bwaited=([0-9]+(?:\.[0-9]+)?s)/m;

/**
 * Marker a retried gate writes into its log tail; mirrors FLAKY_LOG_PREFIX in
 * lib/verification/gate-runner.ts (Issue #1772).
 *
 * Mirrored rather than imported for the same reason the mutex prefix is, and
 * pinned to the runner's spelling by `tests/unit/verification/gate-flaky.test.ts`.
 */
export const FLAKY_LOG_PREFIX = '[flaky]';

/**
 * Label a gate whose two runs disagreed. Not a `VerificationGateStatus`: the
 * schema has no such status and #1772 added no migration, so FLAKY is a reading
 * of the marker laid over the stored `passed`/`failed` verdict.
 */
export const FLAKY_GATE_LABEL = 'FLAKY';

/**
 * The runner's marker line, anchored to the start of a line so a gate whose own
 * output happens to print `outcome=` cannot supply the numbers.
 */
const FLAKY_PATTERN =
  /^\[flaky\] runs=(\d+) outcome=(flaky|fail) exit=(\S+) duration=(\S+) verdict=(pass|fail)$/m;

/** `n/a` is what the runner writes for a run killed by a signal. */
function parseExitField(value: string): number | null {
  return /^-?\d+$/.test(value) ? Number(value) : null;
}

/** `45.0s` back into milliseconds; anything else is a value we cannot read. */
function parseDurationField(value: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(value);
  return match ? Math.round(Number(match[1]) * 1000) : null;
}

/**
 * Read a retried gate's two runs back out of its log tail (Issue #1772).
 *
 * `verification_gate_results` stores one status, one exit code and one duration,
 * so the second run's numbers only exist in the log — the same carrier
 * work-evidence's counts and the scope gate's evidence already use.
 *
 * @returns null when the gate was never retried, which is every gate that did
 *          not declare `retryOnFail: 1` and every one that passed first time.
 */
export function parseFlakyMarker(
  logTail: string | null | undefined
): VerificationFlakyDetail | null {
  if (!logTail) return null;
  const match = FLAKY_PATTERN.exec(logTail);
  if (!match) return null;
  return {
    runs: Number(match[1]),
    outcome: match[2] as VerificationFlakyDetail['outcome'],
    exitCodes: match[3].split(',').map(parseExitField),
    durationsMs: match[4].split(',').map(parseDurationField),
    verdict: match[5] as VerificationFlakyDetail['verdict'],
    // Kept verbatim so the GATE line prints exactly what the runner wrote,
    // rather than a re-rendering that could round differently.
    exit: match[3],
    duration: match[4],
  };
}

/**
 * Lines of a failing gate's log echoed to stderr before the rest becomes a
 * count (#1683).
 *
 * log_tail is byte-capped only when stored (options.maxLogTailBytes, default
 * 8KB but configurable up to 1MB), so echoing it whole lets one misconfigured
 * gate flood the terminal and scroll the GATE verdict lines out of sight.
 */
export const MAX_PRINTED_LOG_TAIL_LINES = 40;

export interface VerificationRequest {
  worktreeId: string;
  /** 'manual' for the verify command, 'wait' when chained after wait. */
  trigger: 'manual' | 'wait';
  instanceId?: string;
  /**
   * Task the run judges. Omitted lets the server resolve the worktree's own
   * task, which is enough while that task is still open — `wait` names one
   * because the agent may close it before the run starts (#1620).
   */
  taskId?: string;
  /** Omitted means work-evidence plus every gate declared in verify.yaml. */
  gateIds?: string[];
  /** Seconds before the CLI stops polling and reports TIMEOUT. */
  timeoutSec?: number;
  /** Stream the final `RESULT <status>` line goes to. Defaults to stdout. */
  resultStream?: 'stdout' | 'stderr';
  /** Suppress the RESULT line because the caller prints JSON on stdout instead. */
  suppressResultLine?: boolean;
}

export interface VerificationOutcome {
  exitCode: number;
  /** Last observed run; on timeout this is still `running`. */
  run?: VerificationRunView;
}

const GATE_LABELS: Record<string, string> = {
  passed: 'PASS',
  failed: 'FAIL',
  timeout: 'TIMEOUT',
  skipped: 'SKIP',
  error: 'ERROR',
};

/**
 * Translate a terminal run status into a process exit code.
 *
 * `error` and `cancelled` mean no verdict was reached, so they take the generic
 * UNEXPECTED_ERROR code rather than VERIFY_FAILED — a caller branching on 20
 * must be able to trust that gates actually ran and judged the work.
 */
export function exitCodeForRunStatus(status: VerificationRunStatus): number {
  switch (status) {
    case 'passed':
      return VerifyExitCode.SUCCESS;
    case 'failed':
      return VerifyExitCode.VERIFY_FAILED;
    case 'not_started':
      return VerifyExitCode.NOT_STARTED;
    default:
      return ExitCode.UNEXPECTED_ERROR;
  }
}

/**
 * Parse `--gates a,b` into a gate id list.
 * @returns The ids, or null when the value names no gate at all.
 */
export function parseGateIds(value: string | undefined): string[] | null | undefined {
  if (value === undefined) return undefined;
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  return ids.length > 0 ? ids : null;
}

function formatDetail(gate: VerificationGateResultView): string {
  // The work-evidence gate's verdict is a count, not an exit status; surfacing
  // the counts is what tells a caller *why* a run came back not_started.
  if (gate.gateId === WORK_EVIDENCE_GATE_ID && gate.logTail) {
    const match = /commits=(\d+)\s+uncommitted=(\d+)/.exec(gate.logTail);
    if (match) return `commits=${match[1]}, uncommitted=${match[2]}`;
  }

  if (gate.status === 'skipped') {
    const reason = gate.logTail?.split('\n')[0]?.trim();
    return reason ? reason.slice(0, 160) : 'not run';
  }

  const parts: string[] = [];
  // A retried gate reports both runs (#1772). The stored columns hold only the
  // run whose verdict was recorded, so printing them would silently drop half
  // of the evidence the retry exists to produce.
  const flaky = parseFlakyMarker(gate.logTail);
  if (flaky) {
    parts.push(`exit=${flaky.exit}`, flaky.duration);
  } else {
    if (gate.exitCode !== null && gate.exitCode !== undefined) parts.push(`exit=${gate.exitCode}`);
    if (gate.durationMs !== null && gate.durationMs !== undefined) {
      parts.push(`${(gate.durationMs / 1000).toFixed(1)}s`);
    }
  }
  // After the duration and never merged into it (#1771): the duration is what
  // the gate's command took, the wait is what the machine made it queue for.
  // Adding them would hide contention inside a number that timeout budgets and
  // "did this gate get slower" are read from.
  const waited = MUTEX_WAITED_PATTERN.exec(gate.logTail ?? '');
  if (waited) parts.push(`waited=${waited[1]}`);
  return parts.join(', ');
}

/**
 * Mark a gate that exists for this delegation only (Issue #1791).
 *
 * Contract-defined gates are the ones a reader cannot look up: verify.yaml is
 * on disk, the contract's copy lives in `tasks.contract_json`. An unmarked line
 * therefore means "the repository's own criterion" and a marked one means "this
 * Issue's", which is the distinction that keeps per-delegation gates from being
 * a second verify.yaml nothing announces. Appended at the end so the leading
 * `GATE <id> <LABEL>` shape every existing log reader matches on is unchanged,
 * and absent for every other source so output is byte-identical in repositories
 * that do not use the feature.
 */
function formatGateSource(gate: VerificationGateResultView): string {
  return gate.source === 'contract' ? ' [contract]' : '';
}

/**
 * The verdict word on a gate's line.
 *
 * FLAKY displaces PASS/FAIL rather than being appended to it (Issue #1772),
 * because the whole point is that neither of those two words was true of this
 * gate: it failed and then it passed. How the run *counted* it is not lost —
 * `flakyIsPass` decided the stored status, which is what the RESULT line and
 * the exit code are built from, so a FLAKY line on a `RESULT failed` run reads
 * exactly as it should.
 *
 * A gate that failed twice keeps FAIL: the retry agreed, and nothing about it
 * was flaky.
 */
function gateLabel(gate: VerificationGateResultView): string {
  if (parseFlakyMarker(gate.logTail)?.outcome === 'flaky') return FLAKY_GATE_LABEL;
  return GATE_LABELS[gate.status] ?? gate.status.toUpperCase();
}

function formatGateLine(gate: VerificationGateResultView): string {
  const label = gateLabel(gate);
  const detail = formatDetail(gate);
  const head = detail ? `GATE ${gate.gateId} ${label} (${detail})` : `GATE ${gate.gateId} ${label}`;
  return `${head}${formatGateSource(gate)}`;
}

/**
 * Cap a failing gate's log for display, keeping the LAST lines: every producer
 * puts its conclusion there — a failing suite ends with its summary, the scope
 * gate ends with its violation list and guidance. The omission marker leads so
 * the reader knows lines are missing before reading, and it names `verify show`
 * because that is where the full stored log lives.
 */
function formatLogTailForDisplay(gate: VerificationGateResultView): string {
  const lines = (gate.logTail ?? '').replace(/\n+$/, '').split('\n');
  if (lines.length <= MAX_PRINTED_LOG_TAIL_LINES) return lines.join('\n');
  const omitted = lines.length - MAX_PRINTED_LOG_TAIL_LINES;
  return [
    `... (+${omitted} more lines; run \`commandmate verify show ${gate.runId}\` for the full log)`,
    ...lines.slice(-MAX_PRINTED_LOG_TAIL_LINES),
  ].join('\n');
}

/**
 * Print each gate exactly once, when it reaches a terminal status.
 * @param reported - Gate row ids already printed; mutated in place.
 */
function reportGates(gates: VerificationGateResultView[], reported: Set<number>): void {
  for (const gate of gates) {
    if (gate.status === 'running' || reported.has(gate.id)) continue;
    reported.add(gate.id);
    console.error(formatGateLine(gate));
    // A failing gate without its log forces the caller back to the API to learn
    // anything actionable, which defeats the point of a CLI verdict.
    if (gate.status !== 'passed' && gate.logTail) {
      console.error(formatLogTailForDisplay(gate));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Turn the verify route's 409 into an error that names the blocking run.
 *
 * handleApiError() maps 409 through its default branch to "Unexpected HTTP
 * status: 409", which tells the caller nothing about what to do next.
 */
function withConflictMessage(error: unknown, worktreeId: string): unknown {
  if (!(error instanceof ApiError) || error.statusCode !== 409) return error;
  const running = error.payload?.runningRunId;
  const which = typeof running === 'number' ? ` (run ${running})` : '';
  return new ApiError(
    `A verification run is already in progress for '${worktreeId}'${which}. ` +
      'Wait for it to finish, then retry.',
    error.exitCode,
    error.statusCode,
    error.payload
  );
}

/**
 * Start a verification run and poll it to a verdict.
 *
 * @throws ApiError when the run cannot be started or the server stops answering
 */
export async function runVerification(
  client: ApiClient,
  request: VerificationRequest
): Promise<VerificationOutcome> {
  const { worktreeId } = request;

  let runId: number;
  try {
    const started = await client.post<VerifyStartResponse>(`/api/worktrees/${worktreeId}/verify`, {
      trigger: request.trigger,
      instanceId: request.instanceId,
      gateIds: request.gateIds,
      taskId: request.taskId,
    });
    runId = assertResponseShape<VerifyStartResponse>(
      started,
      ['runId'],
      `POST /api/worktrees/${worktreeId}/verify`
    ).runId;
  } catch (error) {
    throw withConflictMessage(error, worktreeId);
  }

  console.error(`Verifying: ${worktreeId} (run ${runId})`);

  const startedAt = Date.now();
  const reported = new Set<number>();
  const runPath = `/api/worktrees/${worktreeId}/verify/runs/${runId}`;
  let lastRun: VerificationRunView | undefined;

  while (true) {
    const body = await client.get<VerifyRunResponse>(runPath);
    const run = assertResponseShape<VerifyRunResponse>(body, ['run'], `GET ${runPath}`).run;
    lastRun = run;
    reportGates(run.gates ?? [], reported);

    if (run.status !== 'running') {
      if (!request.suppressResultLine) {
        const line = `RESULT ${run.status}`;
        if (request.resultStream === 'stderr') console.error(line);
        else console.log(line);
      }
      return { exitCode: exitCodeForRunStatus(run.status), run };
    }

    // Checked after the terminal-status branch so a run that finishes exactly on
    // the deadline still reports its verdict instead of a timeout.
    if (request.timeoutSec) {
      const elapsed = (Date.now() - startedAt) / 1000;
      if (elapsed >= request.timeoutSec) {
        console.error(
          `Timeout: verification of ${worktreeId} exceeded ${request.timeoutSec}s ` +
            `(run ${runId} is still running server-side)`
        );
        return { exitCode: VerifyExitCode.TIMEOUT, run: lastRun };
      }
    }

    await sleep(VERIFY_POLL_INTERVAL_MS);
  }
}
